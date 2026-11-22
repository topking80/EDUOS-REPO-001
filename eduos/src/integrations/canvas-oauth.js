// Canvas LMS OAuth 2.0 authorization-code connection.
// State is tenant-, connector-, config-version-, user- and browser-bound;
// tokens are encrypted before persistence and never returned to the browser.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { getCookie, serialize } from "../cookies.js";
import { config } from "../config.js";
import { requireSession, requireCsrf } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { HttpError, audit, one, validId, sendError } from "../role-app-util.js";
import { encryptSecret, decryptSecret } from "./secrets.js";
import { checkUrl, request as outboundRequest, IntegrationError } from "./http.js";

const MANAGERS = new Set(["superintendent", "it_admin"]);
const BASE = "/api/integrations/connectors";
const STATE_TTL_SECONDS = 600;
const oauthStartLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
const oauthCallbackLimiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
const COOKIE = { httpOnly: true, secure: config.secureCookies, sameSite: "lax", path: "/" };
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const stateCookie = state => `eduos_canvas_state_${hash(state).slice(0, 24)}`;
const urlOptions = () => ({ allowInsecureLoopback: config.integrationsAllowInsecureLoopback, allowedHosts: config.integrationsAllowedHosts });

function requireManager(req, res) {
  if (!MANAGERS.has(req.actor?.role)) { res.status(403).json({ error: "integrations_access_denied" }); return false; }
  if (!config.integrationsKey) { res.status(503).json({ error: "integrations_disabled" }); return false; }
  return true;
}

function canvasOrigin(raw) {
  let url;
  try { url = checkUrl(raw, urlOptions()); } catch { throw new HttpError(400, "canvas_origin_not_allowed"); }
  if (url.protocol !== "https:" && !(config.integrationsAllowInsecureLoopback && url.hostname === "127.0.0.1"))
    throw new HttpError(400, "canvas_origin_must_use_https");
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new HttpError(400, "canvas_origin_must_be_origin_only");
  return url.origin;
}

function callbackUri() {
  // Never derive the redirect from Host / X-Forwarded-Host.
  return new URL("/api/integrations/canvas/callback", config.publicOrigin).toString();
}

function clearStateCookie(res, state) {
  res.append("Set-Cookie", serialize(stateCookie(state), "", { ...COOKIE, maxAge: 0 }));
}

function tokenPayload(text) {
  try { return JSON.parse(text); } catch { throw new HttpError(502, "canvas_token_response_invalid"); }
}

function decryptCanvasSecret(districtId, connectorId, ciphertext) {
  try {
    return decryptSecret(config.integrationsKey, districtId, connectorId, ciphertext);
  } catch {
    // Never expose cipher/authentication details or fall through to a generic
    // 500. A damaged or mismatched grant must be re-authorized by the district.
    throw new HttpError(409, "canvas_credentials_unreadable");
  }
}


/**
 * Return a live Canvas bearer token for a district connector. Refresh is
 * serialized across application instances with a short database lease; the
 * raw tokens exist only in this server-side call path.
 */
export async function getCanvasAccessToken(actor, connectorId) {
  if (!validId(connectorId)) throw new HttpError(400, "invalid_connector_id");
  for (let attempt = 0; attempt < 40; attempt++) {
    const claim = await withTenantTransaction(actor, async c => {
      const connector = await one(c,
        "SELECT id,kind,status,base_url,token_url,client_id,client_secret_enc,config_version FROM integration_connectors WHERE id=$1 AND district_id=$2",
        [connectorId,actor.districtId]);
      if (!connector || connector.kind !== "canvas") throw new HttpError(404,"canvas_connector_not_found");
      if (connector.status !== "active") throw new HttpError(409,"connector_not_approved");
      const grant = await one(c,
        "SELECT access_token_enc,refresh_token_enc,expires_at FROM integration_canvas_oauth_grants WHERE connector_id=$1 AND district_id=$2",
        [connectorId,actor.districtId]);
      if (!grant) throw new HttpError(409,"canvas_authorization_required");
      if (new Date(grant.expires_at).getTime() > Date.now() + 60_000) {
        return { accessToken: decryptCanvasSecret(actor.districtId,`${connectorId}:canvas-access`,grant.access_token_enc) };
      }
      const leaseToken = crypto.randomUUID();
      const leased = await one(c,
        `UPDATE integration_canvas_oauth_grants SET refresh_lease_token=$3,
           refresh_lease_until=now()+interval '30 seconds'
          WHERE district_id=$1 AND connector_id=$2
            AND (refresh_lease_until IS NULL OR refresh_lease_until<=now())
            -- Re-checked under the row lock: another request may have refreshed
            -- (and released its lease) since this one read the expired token.
            AND expires_at<=now()+interval '60 seconds'
          RETURNING refresh_token_enc`,
        [actor.districtId,connectorId,leaseToken]);
      if (!leased) return { waiting: true };
      return { leaseToken, refreshTokenEnc: leased.refresh_token_enc, connector };
    });
    if (claim.accessToken) return claim.accessToken;
    if (claim.waiting) {
      await new Promise(resolve => setTimeout(resolve,250));
      continue;
    }

    const release = async () => withTenantTransaction(actor,c => c.query(
      `UPDATE integration_canvas_oauth_grants SET refresh_lease_token=NULL,refresh_lease_until=NULL
        WHERE district_id=$1 AND connector_id=$2 AND refresh_lease_token=$3`,
      [actor.districtId,connectorId,claim.leaseToken]));
    try {
      const origin = canvasOrigin(claim.connector.base_url);
      const tokenUrl = new URL("/login/oauth2/token",origin).toString();
      if (claim.connector.token_url !== tokenUrl) throw new HttpError(409,"canvas_token_url_mismatch");
      const oldRefresh = decryptCanvasSecret(actor.districtId,`${connectorId}:canvas-refresh`,claim.refreshTokenEnc);
      const clientSecret = decryptCanvasSecret(actor.districtId,connectorId,claim.connector.client_secret_enc);
      const response = await outboundRequest(tokenUrl,{
        method:"POST",options:{...urlOptions(),timeoutMs:10_000},
        headers:{"content-type":"application/x-www-form-urlencoded",accept:"application/json+canvas-string-ids"},
        body:new URLSearchParams({grant_type:"refresh_token",refresh_token:oldRefresh,
          client_id:claim.connector.client_id,client_secret:clientSecret}).toString()
      });
      if (response.status < 200 || response.status > 299) {
        if (response.status === 400 || response.status === 401) {
          await withTenantTransaction(actor,c=>c.query(
            "DELETE FROM integration_canvas_oauth_grants WHERE district_id=$1 AND connector_id=$2 AND refresh_lease_token=$3",
            [actor.districtId,connectorId,claim.leaseToken]));
          throw new HttpError(409,"canvas_authorization_required");
        }
        throw new IntegrationError("canvas_token_refresh_failed",`HTTP ${response.status}`);
      }
      const token = tokenPayload(response.text);
      if (typeof token?.access_token !== "string" || !token.access_token ||
          String(token?.token_type || "").toLowerCase() !== "bearer" ||
          !Number.isSafeInteger(token.expires_in) || token.expires_in < 60 || token.expires_in > 86400)
        throw new IntegrationError("canvas_token_response_invalid");
      const nextRefresh = typeof token.refresh_token === "string" && token.refresh_token ? token.refresh_token : oldRefresh;
      const accessEnc = encryptSecret(config.integrationsKey,actor.districtId,`${connectorId}:canvas-access`,token.access_token);
      const refreshEnc = encryptSecret(config.integrationsKey,actor.districtId,`${connectorId}:canvas-refresh`,nextRefresh);
      const saved = await withTenantTransaction(actor,c=>one(c,
        `UPDATE integration_canvas_oauth_grants g SET access_token_enc=$4,refresh_token_enc=$5,
           expires_at=now()+make_interval(secs=>$6),updated_at=now(),
           refresh_lease_token=NULL,refresh_lease_until=NULL
          WHERE g.district_id=$1 AND g.connector_id=$2 AND g.refresh_lease_token=$3
            AND EXISTS(SELECT 1 FROM integration_connectors x WHERE x.id=g.connector_id
              AND x.district_id=g.district_id AND x.kind='canvas' AND x.status='active'
              AND x.config_version=$7)
          RETURNING g.connector_id`,
        [actor.districtId,connectorId,claim.leaseToken,accessEnc,refreshEnc,token.expires_in,claim.connector.config_version]));
      if (!saved) throw new HttpError(409,"canvas_connector_changed");
      return token.access_token;
    } catch (error) {
      try { await release(); } catch { /* preserve the original failure */ }
      throw error;
    }
  }
  throw new IntegrationError("canvas_token_refresh_busy","A Canvas token refresh is still in progress");
}

export async function revokeCanvasToken(baseUrl, accessToken) {
  if (!accessToken) return false;
  try {
    const origin = canvasOrigin(baseUrl);
    const response = await outboundRequest(new URL("/login/oauth2/token",origin).toString(),{
      method:"DELETE",options:{...urlOptions(),timeoutMs:10_000},
      headers:{authorization:`Bearer ${accessToken}`,accept:"application/json"}
    });
    return response.status >= 200 && response.status <= 299;
  } catch {
    // Local disconnect must still be possible during a Canvas outage.
    return false;
  }
}

export function registerCanvasOAuthRoutes(app) {
  app.post(`${BASE}/:id/canvas/authorize`, oauthStartLimiter, requireSession, requireCsrf, async (req, res, next) => {
    if (!requireManager(req, res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_connector_id" });
    try {
      const state = crypto.randomBytes(32).toString("base64url");
      const redirectUri = callbackUri();
      const connector = await withTenantTransaction(req.actor, async c => {
        const row = await one(c,
          "SELECT id,kind,status,base_url,token_url,client_id,scope,config_version FROM integration_connectors WHERE id=$1 AND district_id=$2",
          [req.params.id, req.actor.districtId]);
        if (!row) throw new HttpError(404, "connector_not_found");
        if (row.kind !== "canvas") throw new HttpError(409, "not_a_canvas_connector");
        if (row.status !== "active") throw new HttpError(409, "connector_not_approved");
        const origin = canvasOrigin(row.base_url);
        const expectedTokenUrl = new URL("/login/oauth2/token", origin).toString();
        if (row.token_url !== expectedTokenUrl) throw new HttpError(409, "canvas_token_url_mismatch");
        await c.query("DELETE FROM integration_canvas_oauth_states WHERE expires_at<=now()");
        await c.query(
          `INSERT INTO integration_canvas_oauth_states(district_id,connector_id,user_id,state_hash,config_version,redirect_uri,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(secs=>$7))`,
          [req.actor.districtId, row.id, req.actor.userId, hash(state), row.config_version, redirectUri, STATE_TTL_SECONDS]);
        return { ...row, origin };
      });
      const authorize = new URL("/login/oauth2/auth", connector.origin);
      authorize.search = new URLSearchParams({
        client_id: connector.client_id,
        response_type: "code",
        redirect_uri: redirectUri,
        state,
        scope: connector.scope
      }).toString();
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.append("Set-Cookie", serialize(stateCookie(state), state, { ...COOKIE, maxAge: STATE_TTL_SECONDS }));
      return res.json({ data: { authorizationUrl: authorize.toString() } });
    } catch (e) { sendError(res, next, e); }
  });

  // Canvas returns the authorization response by top-level GET. The short-lived
  // HttpOnly SameSite=Lax cookie supplies the browser binding; the session and
  // database row bind the same attempt to one district, user and config version.
  app.get("/api/integrations/canvas/callback", oauthCallbackLimiter, requireSession, async (req, res, next) => {
    const state = req.query?.state;
    if (typeof state !== "string" || state.length < 32 || state.length > 128)
      return res.status(400).type("text/plain").send("Invalid Canvas authorization response");
    clearStateCookie(res, state);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!requireManager(req, res)) return;
    try {
      // Commit consumption separately. Throwing inside the DELETE transaction
      // would roll it back and make denied/malformed states replayable.
      const consumed = await withTenantTransaction(req.actor, c => one(c,
        "UPDATE integration_canvas_oauth_states SET consumed_at=now() WHERE state_hash=$1 AND district_id=$2 AND consumed_at IS NULL AND expires_at>now() RETURNING id,connector_id,user_id,config_version,redirect_uri,expires_at",
        [hash(state), req.actor.districtId]));
      const cookieValue = getCookie(req.headers.cookie, stateCookie(state));
      const cookieMatches = typeof cookieValue === "string" && cookieValue.length === state.length &&
        crypto.timingSafeEqual(Buffer.from(cookieValue), Buffer.from(state));
      if (!consumed || new Date(consumed.expires_at).getTime() <= Date.now() ||
          consumed.user_id !== req.actor.userId || !cookieMatches)
        throw new HttpError(400, "canvas_oauth_state_invalid");
      if (req.query.error) throw new HttpError(400, "canvas_authorization_denied");
      if (typeof req.query.code !== "string" || req.query.code.length < 1 || req.query.code.length > 4096)
        throw new HttpError(400, "canvas_authorization_code_invalid");

      const result = await withTenantTransaction(req.actor, async c => {
        const stateStillValid = await one(c,
          "SELECT id FROM integration_canvas_oauth_states WHERE id=$1 AND district_id=$2 AND connector_id=$3 AND consumed_at IS NOT NULL AND expires_at>now()",
          [consumed.id,req.actor.districtId,consumed.connector_id]);
        if (!stateStillValid) throw new HttpError(409,"canvas_authorization_cancelled");
        const connector = await one(c,
          "SELECT id,kind,status,base_url,token_url,client_id,client_secret_enc,scope,config_version FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE",
          [consumed.connector_id, req.actor.districtId]);
        if (!connector || connector.kind !== "canvas" || connector.status !== "active" ||
            connector.config_version !== consumed.config_version)
          throw new HttpError(409, "canvas_connector_changed");
        const origin = canvasOrigin(connector.base_url);
        const tokenUrl = new URL("/login/oauth2/token", origin).toString();
        if (connector.token_url !== tokenUrl) throw new HttpError(409, "canvas_token_url_mismatch");
        const clientSecret = decryptCanvasSecret(req.actor.districtId, connector.id, connector.client_secret_enc);
        return { connector, redirectUri: consumed.redirect_uri, tokenUrl, clientSecret, code: req.query.code, stateId: consumed.id };
      });

      const response = await outboundRequest(result.tokenUrl, {
        method: "POST",
        options: { ...urlOptions(), timeoutMs: 10_000 },
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json+canvas-string-ids" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: result.code,
          redirect_uri: result.redirectUri,
          client_id: result.connector.client_id,
          client_secret: result.clientSecret
        }).toString()
      });
      if (response.status < 200 || response.status > 299)
        return res.status(502).type("text/plain").send("Canvas authorization could not be completed");
      const token = tokenPayload(response.text);
      const userId = token?.user?.id ?? token?.user_id;
      if (typeof token?.access_token !== "string" || !token.access_token ||
          String(token?.token_type || "").toLowerCase() !== "bearer" ||
          typeof token?.refresh_token !== "string" || !token.refresh_token ||
          !Number.isSafeInteger(token.expires_in) || token.expires_in < 60 || token.expires_in > 86400 ||
          (typeof userId !== "string" && !Number.isSafeInteger(userId))) {
        if (typeof token?.access_token === "string" && token.access_token)
          await revokeCanvasToken(result.connector.base_url,token.access_token);
        return res.status(502).type("text/plain").send("Canvas returned an incomplete authorization grant");
      }

      try {
        await withTenantTransaction(req.actor, async c => {
        const current = await one(c,
          "SELECT status,config_version,kind FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE",
          [result.connector.id, req.actor.districtId]);
        if (!current || current.kind !== "canvas" || current.status !== "active" ||
            current.config_version !== result.connector.config_version)
          throw new HttpError(409, "canvas_connector_changed");
        const access = encryptSecret(config.integrationsKey, req.actor.districtId, `${result.connector.id}:canvas-access`, token.access_token);
        const refresh = encryptSecret(config.integrationsKey, req.actor.districtId, `${result.connector.id}:canvas-refresh`, token.refresh_token);
        await c.query(
          `INSERT INTO integration_canvas_oauth_grants(district_id,connector_id,canvas_user_id,canvas_user_name,
             access_token_enc,refresh_token_enc,expires_at,granted_scope,authorized_by,authorized_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(secs=>$7),$8,$9,now(),now())
           ON CONFLICT(district_id,connector_id) DO UPDATE SET canvas_user_id=EXCLUDED.canvas_user_id,
             canvas_user_name=EXCLUDED.canvas_user_name,access_token_enc=EXCLUDED.access_token_enc,
             refresh_token_enc=EXCLUDED.refresh_token_enc,expires_at=EXCLUDED.expires_at,
             granted_scope=EXCLUDED.granted_scope,authorized_by=EXCLUDED.authorized_by,
             authorized_at=now(),updated_at=now(),refresh_lease_token=NULL,refresh_lease_until=NULL`,
          [req.actor.districtId,result.connector.id,String(userId),typeof token.user?.name==="string"?token.user.name.slice(0,200):null,
            access,refresh,token.expires_in,typeof token.scope==="string"?token.scope.split(/\s+/).filter(Boolean):result.connector.scope.split(/\s+/).filter(Boolean),req.actor.userId]);
        await c.query("DELETE FROM integration_canvas_oauth_states WHERE id=$1 AND district_id=$2",[result.stateId,req.actor.districtId]);
        await audit(c,req,"canvas_oauth_connect","integration_canvas_oauth_grant",result.connector.id,"Canvas OAuth grant stored; tokens encrypted");
        });
      } catch (e) {
        await revokeCanvasToken(result.connector.base_url,token.access_token);
        throw e;
      }
      return res.redirect(303, "/app/?canvas=connected");
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).type("text/plain").send("Canvas authorization was not accepted");
      if (e instanceof IntegrationError) return res.status(502).type("text/plain").send("Canvas authorization could not be completed");
      sendError(res, next, e);
    }
  });

  app.get(`${BASE}/:id/canvas/status`, requireSession, async (req,res,next) => {
    if (!requireManager(req,res)) return;
    if (!validId(req.params.id)) return res.status(400).json({error:"invalid_connector_id"});
    try {
      const data = await withTenantTransaction(req.actor, async c => one(c,
        `SELECT g.canvas_user_id,g.canvas_user_name,g.expires_at,g.granted_scope,g.authorized_at,u.display_name AS authorized_by
           FROM integration_canvas_oauth_grants g JOIN users u ON u.id=g.authorized_by
          WHERE g.connector_id=$1 AND g.district_id=$2`,[req.params.id,req.actor.districtId]));
      res.setHeader("Cache-Control","no-store");
      res.json({data: data ? {connected:true,canvasUserId:data.canvas_user_id,canvasUserName:data.canvas_user_name,
        expiresAt:data.expires_at,scopes:data.granted_scope,authorizedAt:data.authorized_at,authorizedBy:data.authorized_by} : {connected:false}});
    } catch(e){sendError(res,next,e);}
  });

  app.post(`${BASE}/:id/canvas/refresh`, oauthStartLimiter, requireSession, requireCsrf, async (req,res,next) => {
    if (!requireManager(req,res)) return;
    if (!validId(req.params.id)) return res.status(400).json({error:"invalid_connector_id"});
    try {
      await getCanvasAccessToken(req.actor,req.params.id);
      res.setHeader("Cache-Control","no-store");
      res.json({data:{connected:true}});
    } catch(e) {
      if (e instanceof HttpError) return res.status(e.status).json({error:e.code});
      if (e instanceof IntegrationError) return res.status(502).json({error:"canvas_token_refresh_failed"});
      sendError(res,next,e);
    }
  });

  app.post(`${BASE}/:id/canvas/disconnect`, requireSession, requireCsrf, async (req,res,next) => {
    if (!requireManager(req,res)) return;
    if (!validId(req.params.id)) return res.status(400).json({error:"invalid_connector_id"});
    try {
      const snapshot = await withTenantTransaction(req.actor,c => one(c,
        "SELECT id,kind,base_url,status,config_version FROM integration_connectors WHERE id=$1 AND district_id=$2",[req.params.id,req.actor.districtId]));
      if (!snapshot) throw new HttpError(404,"connector_not_found");
      if (snapshot.kind !== "canvas") throw new HttpError(409,"not_a_canvas_connector");
      let accessToken = null;
      if (snapshot.status === "active") {
        try { accessToken = await getCanvasAccessToken(req.actor,req.params.id); } catch { /* still allow local disconnect */ }
      }
      await withTenantTransaction(req.actor,async c=>{
        const current=await one(c,"SELECT status,config_version FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,req.actor.districtId]);
        if(!current)throw new HttpError(404,"connector_not_found");
        if(current.status==="active") {
          if(current.config_version!==snapshot.config_version)throw new HttpError(409,"canvas_connector_changed");
          await c.query("UPDATE integration_connectors SET status='pending_approval',approved_by=NULL,approved_at=NULL,updated_by=$3,updated_at=now(),config_version=config_version+1 WHERE id=$1 AND district_id=$2",[req.params.id,req.actor.districtId,req.actor.userId]);
        }
        await c.query("UPDATE integration_sync_schedules SET enabled=false,next_run_at=NULL,paused_at=now(),approved_by=NULL,approved_at=NULL,pause_reason='canvas_disconnected',updated_at=now() WHERE connector_id=$1 AND district_id=$2",[req.params.id,req.actor.districtId]);
        await c.query("UPDATE integration_sync_jobs SET status='cancelled',lease_until=NULL,lease_token=NULL,finished_at=now(),last_error='canvas_disconnected' WHERE connector_id=$1 AND district_id=$2 AND status IN ('pending','processing')",[req.params.id,req.actor.districtId]);
        await c.query("DELETE FROM integration_canvas_oauth_states WHERE connector_id=$1 AND district_id=$2",[req.params.id,req.actor.districtId]);
      });
      const canvasTokenRevoked = await revokeCanvasToken(snapshot.base_url,accessToken);
      await withTenantTransaction(req.actor,async c=>{
        await c.query("DELETE FROM integration_canvas_oauth_grants WHERE connector_id=$1 AND district_id=$2",[req.params.id,req.actor.districtId]);
        await audit(c,req,"canvas_oauth_disconnect","integration_canvas_oauth_grant",req.params.id,
          "Local Canvas tokens deleted; canvas_token_revoked="+canvasTokenRevoked+"; connector requires independent reapproval before reconnect");
      });
      res.setHeader("Cache-Control","no-store");
      res.json({data:{connected:false,canvasTokenRevoked,reapprovalRequired:true,canvasDeveloperKeyRevocationRequired:true}});
    }catch(e){sendError(res,next,e);}
  });
}

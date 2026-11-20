// Canvas LMS OAuth 2.0 authorization-code connection.
// State is tenant-, connector-, config-version-, user- and browser-bound;
// tokens are encrypted before persistence and never returned to the browser.
import crypto from "node:crypto";
import { parse, serialize } from "../cookies.js";
import { config } from "../config.js";
import { requireSession, requireCsrf } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { HttpError, audit, one, validId, sendError } from "../role-app-util.js";
import { encryptSecret, decryptSecret } from "./secrets.js";
import { checkUrl, request as outboundRequest } from "./http.js";

const MANAGERS = new Set(["superintendent", "it_admin"]);
const BASE = "/api/integrations/connectors";
const STATE_TTL_SECONDS = 600;
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

export function registerCanvasOAuthRoutes(app) {
  app.post(`${BASE}/:id/canvas/authorize`, requireSession, requireCsrf, async (req, res, next) => {
    if (!requireManager(req, res)) return;
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_connector_id" });
    try {
      const state = crypto.randomBytes(32).toString("base64url");
      const redirectUri = callbackUri();
      const connector = await withTenantTransaction(req.actor, async c => {
        const row = await one(c,
          "SELECT id,kind,status,base_url,token_url,client_id,config_version FROM integration_connectors WHERE id=$1 AND district_id=$2",
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
        state
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
  app.get("/api/integrations/canvas/callback", requireSession, async (req, res, next) => {
    const state = req.query?.state;
    if (typeof state !== "string" || state.length < 32 || state.length > 128)
      return res.status(400).type("text/plain").send("Invalid Canvas authorization response");
    clearStateCookie(res, state);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!requireManager(req, res)) return;
    try {
      const result = await withTenantTransaction(req.actor, async c => {
        // Consume before examining callback parameters: even denied/invalid
        // responses cannot replay the same authorization state.
        const consumed = await one(c,
          "DELETE FROM integration_canvas_oauth_states WHERE state_hash=$1 AND district_id=$2 RETURNING connector_id,user_id,config_version,redirect_uri,expires_at",
          [hash(state), req.actor.districtId]);
        const cookies = parse(req.headers.cookie || "");
        const cookieValue = cookies[stateCookie(state)];
        if (!consumed || new Date(consumed.expires_at).getTime() <= Date.now() ||
            consumed.user_id !== req.actor.userId || typeof cookieValue !== "string" ||
            !crypto.timingSafeEqual(Buffer.from(cookieValue), Buffer.from(state)))
          throw new HttpError(400, "canvas_oauth_state_invalid");
        if (req.query.error) throw new HttpError(400, "canvas_authorization_denied");
        if (typeof req.query.code !== "string" || req.query.code.length < 1 || req.query.code.length > 4096)
          throw new HttpError(400, "canvas_authorization_code_invalid");
        const connector = await one(c,
          "SELECT id,kind,status,base_url,token_url,client_id,client_secret_enc,config_version FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE",
          [consumed.connector_id, req.actor.districtId]);
        if (!connector || connector.kind !== "canvas" || connector.status !== "active" ||
            connector.config_version !== consumed.config_version)
          throw new HttpError(409, "canvas_connector_changed");
        const origin = canvasOrigin(connector.base_url);
        const tokenUrl = new URL("/login/oauth2/token", origin).toString();
        if (connector.token_url !== tokenUrl) throw new HttpError(409, "canvas_token_url_mismatch");
        const clientSecret = decryptSecret(config.integrationsKey, req.actor.districtId, connector.id, connector.client_secret_enc);
        return { connector, redirectUri: consumed.redirect_uri, tokenUrl, clientSecret, code: req.query.code };
      });

      const response = await outboundRequest(result.tokenUrl, {
        method: "POST",
        options: { ...urlOptions(), timeoutMs: 10_000 },
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
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
          typeof token?.refresh_token !== "string" || !token.refresh_token ||
          !Number.isSafeInteger(token.expires_in) || token.expires_in < 60 || token.expires_in > 86400 ||
          (typeof userId !== "string" && typeof userId !== "number"))
        return res.status(502).type("text/plain").send("Canvas returned an incomplete authorization grant");

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
             authorized_at=now(),updated_at=now()`,
          [req.actor.districtId,result.connector.id,String(userId),typeof token.user?.name==="string"?token.user.name.slice(0,200):null,
            access,refresh,token.expires_in,typeof token.scope==="string"?token.scope.split(/\s+/).filter(Boolean):[],req.actor.userId]);
        await audit(c,req,"canvas_oauth_connect","integration_canvas_oauth_grant",result.connector.id,"Canvas OAuth grant stored; tokens encrypted");
      });
      return res.redirect(303, "/app/?canvas=connected");
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) return res.status(e.status).type("text/plain").send("Canvas authorization was not accepted");
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

  app.post(`${BASE}/:id/canvas/disconnect`, requireSession, requireCsrf, async (req,res,next) => {
    if (!requireManager(req,res)) return;
    if (!validId(req.params.id)) return res.status(400).json({error:"invalid_connector_id"});
    try {
      await withTenantTransaction(req.actor,async c=>{
        const connector=await one(c,"SELECT id,kind FROM integration_connectors WHERE id=$1 AND district_id=$2 FOR UPDATE",[req.params.id,req.actor.districtId]);
        if(!connector)throw new HttpError(404,"connector_not_found");
        if(connector.kind!=="canvas")throw new HttpError(409,"not_a_canvas_connector");
        await c.query("DELETE FROM integration_canvas_oauth_states WHERE connector_id=$1 AND district_id=$2",[connector.id,req.actor.districtId]);
        await c.query("DELETE FROM integration_canvas_oauth_grants WHERE connector_id=$1 AND district_id=$2",[connector.id,req.actor.districtId]);
        await audit(c,req,"canvas_oauth_disconnect","integration_canvas_oauth_grant",connector.id,"Local Canvas tokens and pending authorization states deleted; district must revoke the developer key in Canvas if full revocation is required");
      });
      res.setHeader("Cache-Control","no-store");
      res.json({data:{connected:false,canvasDeveloperKeyRevocationRequired:true}});
    }catch(e){sendError(res,next,e);}
  });
}

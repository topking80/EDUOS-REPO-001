import crypto from "node:crypto";
import { parse, serialize } from "./cookies.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { getOidcMetadata, randomSecret, sha256, verifiedEmailFromClaims, verifyIdToken } from "./oidc.js";

// Secure whenever the public origin is HTTPS (not only NODE_ENV=production).
const cookieOptions = {
  httpOnly: true,
  secure: config.secureCookies,
  sameSite: "lax",
  path: "/"
};
const PENDING_LOGIN_TTL_MS = 5 * 60_000;
const SESSION_TOUCH_INTERVAL_MS = 60_000;

// Optional short-TTL cache of validated sessions. OFF by default
// (SESSION_CACHE_TTL_MS=0): requireSession re-reads the database on every
// request, so a revoked or expired session is rejected at once. When enabled it
// removes the per-request session lookup for sessions seen within the TTL. The
// in-process paths that change a session's validity -- logout, sign-in and
// membership switching -- evict the entry, so they are never served stale; only
// an out-of-band change (an admin revoking a row directly in the database) can
// be served up to TTL old, which is the bounded window the operator opts into.
// Single-instance only: a multi-node deployment should keep this at 0 or back
// it with a shared store, since one node's eviction does not reach the others.
const sessionCache = new Map(); // tokenHash -> { actor, exp }
const MAX_SESSION_CACHE = config.sessionCacheMax; // memory bound for the optional cache (SESSION_CACHE_MAX)

function cacheGetSession(hash) {
  if (config.sessionCacheTtlMs <= 0) return null;
  const hit = sessionCache.get(hash);
  if (!hit) return null;
  if (hit.exp <= Date.now()) { sessionCache.delete(hash); return null; }
  return hit.actor;
}
function cacheSetSession(hash, actor) {
  if (config.sessionCacheTtlMs <= 0) return;
  if (sessionCache.size >= MAX_SESSION_CACHE && !sessionCache.has(hash)) {
    const oldest = sessionCache.keys().next().value; // Map preserves insertion order
    if (oldest !== undefined) sessionCache.delete(oldest);
  }
  sessionCache.set(hash, { actor: { ...actor }, exp: Date.now() + config.sessionCacheTtlMs });
}
function evictSession(hash) { if (hash) sessionCache.delete(hash); }

// Give each authorization attempt its own browser cookie so concurrent tabs do
// not overwrite one another's OIDC state binding.
export function oidcStateCookieName(state) {
  return `eduos_oidc_state_${sha256(state).slice(0, 24)}`;
}

/**
 * The CSRF token is derived from the (HttpOnly) session token, so it is stable
 * for the life of the session: GET /api/csrf has no side effects and cannot be
 * used cross-site to invalidate the token held by open tabs.
 */
export function csrfTokenFor(rawSession) {
  return crypto.createHmac("sha256", String(rawSession)).update("eduos-csrf-v1").digest("base64url");
}

// Constant-time comparison for same-length secret tokens / digests.
// Avoids leaking match position through early-exit string comparison.
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const fetchWithTimeout = (url, options = {}) =>
  fetch(url, { ...options, signal: AbortSignal.timeout(config.oidcHttpTimeoutMs) });

// 32.1.0: an unreachable or misconfigured identity provider is an operational
// outage, not a server bug: tell the person (503) instead of a JSON 500.
function idpUnavailable(req, res, error) {
  console.error("OIDC provider unavailable", { requestId: req.requestId, message: error.message });
  res.status(503).set("Retry-After", "60").set("Cache-Control", "no-store").type("html").send(
    `<!doctype html><meta charset="utf-8"><title>Sign-in unavailable</title><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>Sign-in is temporarily unavailable</h1><p>EduOS could not reach the district identity provider. Please try again in a minute; if it keeps happening, contact your district IT team` +
    ` (reference ${String(req.requestId || "").replace(/[^A-Za-z0-9-]/g, "")}).</p><p><a href="/">Back to EduOS</a></p></body>`);
}

export const RETURN_PATHS = new Set(["/", "/app/"]);
export async function beginLogin(req, res, next) {
  let meta;
  try { meta = await getOidcMetadata(); } catch (error) { return idpUnavailable(req, res, error); }
  try {
    const state = randomSecret(24);
    const nonce = randomSecret(24);
    const verifier = randomSecret(48);
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    // Pending logins live in the database so any instance can complete them.
    await pool.query("DELETE FROM oidc_pending_logins WHERE expires_at <= now()");
    // 32.4.0: the mobile role app signs in through the same flow and asks to
    // come back to /app/. Only the two allow-listed paths are accepted, so the
    // parameter cannot become an open redirect.
    const returnPath = RETURN_PATHS.has(req.query.next) ? req.query.next : "/";
    await pool.query(
      `INSERT INTO oidc_pending_logins(state_hash,nonce,code_verifier,expires_at,return_path)
       VALUES($1,$2,$3,now() + make_interval(secs => $4),$5)`,
      [sha256(state), nonce, verifier, PENDING_LOGIN_TTL_MS / 1000, returnPath]
    );
    // Bind this authorization response to its initiating browser and allow
    // independent login attempts in multiple tabs.
    res.append("Set-Cookie", serialize(oidcStateCookieName(state), state, {
      ...cookieOptions, maxAge: PENDING_LOGIN_TTL_MS / 1000
    }));

    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: config.oidcClientId,
      redirect_uri: config.oidcRedirectUri,
      scope: config.oidcScopes.join(" "),
      state, nonce,
      code_challenge: challenge,
      code_challenge_method: "S256"
    }).toString();
    res.redirect(302, url.toString());
  } catch (error) { next(error); }
}

/** Create a session row and return the raw (cookie) token. */
export async function createSession(db, { userId, districtId, schoolId, role, verifiedEmail = null }) {
  const rawSession = randomSecret(32);
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await db.query(
    `INSERT INTO sessions (token_hash,csrf_token_hash,user_id,district_id,school_id,role,expires_at,verified_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [sha256(rawSession), sha256(csrfTokenFor(rawSession)), userId, districtId, schoolId, role, expiresAt, verifiedEmail]
  );
  // Multi-session policy: keep at most SESSION_MAX_PER_USER active sessions
  // (e.g. laptop + phone); the oldest beyond the cap are revoked.
  await db.query(
    `UPDATE sessions SET revoked_at=now()
      WHERE user_id=$1 AND revoked_at IS NULL AND id NOT IN (
        SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
         ORDER BY created_at DESC, id DESC LIMIT $2)`,
    [userId, config.sessionMaxPerUser]
  );
  return { rawSession, expiresAt };
}

function setSessionCookie(res, rawSession, expiresAt) {
  res.append("Set-Cookie", serialize(config.cookieName, rawSession, {
    ...cookieOptions, maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)), expires: expiresAt
  }));
}

export async function completeLogin(req, res, next) {
  try {
    const { code, state } = req.query;
    if (typeof code !== "string" || typeof state !== "string" || state.length > 128)
      return res.status(400).send("Invalid login response");
    // Consume before validation: every callback is single-use, on any instance.
    const consumed = await pool.query(
      "DELETE FROM oidc_pending_logins WHERE state_hash=$1 RETURNING nonce, code_verifier, expires_at, return_path",
      [sha256(state)]
    );
    const transaction = consumed.rows[0];
    const browserCookies = parse(req.headers.cookie || "");
    const stateCookieName = oidcStateCookieName(state);
    const stateCookie = browserCookies[stateCookieName];
    res.append("Set-Cookie", serialize(stateCookieName, "", { ...cookieOptions, maxAge: 0 }));
    if (!transaction || new Date(transaction.expires_at).getTime() < Date.now() || !safeEqual(stateCookie, state))
      return res.status(400).send("Login state expired or browser binding failed");

    const meta = await getOidcMetadata();
    const tokenResponse = await fetchWithTimeout(meta.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: config.oidcRedirectUri,
        client_id: config.oidcClientId,
        client_secret: config.oidcClientSecret,
        code_verifier: transaction.code_verifier
      })
    });
    if (!tokenResponse.ok) return res.status(401).send("Identity provider rejected login");
    const tokens = await tokenResponse.json();
    if (!tokens.id_token) return res.status(401).send("Identity provider did not return an ID token");
    const claims = await verifyIdToken(tokens.id_token, transaction.nonce);

    // Provisioning is intentionally closed: an administrator must pre-create and
    // map the OIDC subject to an enabled EduOS user. Email alone is not identity.
    // A user may hold several memberships; sign-in starts in the default one.
    const userResult = await pool.query(
      `SELECT u.id, u.status, m.district_id, m.school_id, m.role
         FROM users u JOIN memberships m ON m.user_id=u.id
         JOIN districts d ON d.id=m.district_id AND d.status='active'
        WHERE u.oidc_issuer=$1 AND u.oidc_subject=$2 AND u.status='active'
          AND m.status='active'
        ORDER BY m.is_default DESC, m.id
        LIMIT 1`,
      [claims.iss, claims.sub]
    );
    if (userResult.rowCount !== 1) return res.status(403).send("Account is not provisioned for EduOS");
    const user = userResult.rows[0];

    // Never keep the browser's previous session alive after a new sign-in.
    const previous = browserCookies[config.cookieName];
    if (previous && previous.length <= 256) {
      const previousHash = sha256(previous);
      await pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [previousHash]);
      evictSession(previousHash);
    }
    const { rawSession, expiresAt } = await createSession(pool, {
      userId: user.id, districtId: user.district_id, schoolId: user.school_id, role: user.role,
      verifiedEmail: verifiedEmailFromClaims(claims)
    });
    setSessionCookie(res, rawSession, expiresAt);
    // 32.4.0: bus drivers only have the mobile role app.
    const target = user.role === "driver" ? "/app/" : (RETURN_PATHS.has(transaction.return_path) ? transaction.return_path : "/");
    res.redirect(303, target);
  } catch (error) { next(error); }
}

// 32.7.0: extra per-request checks after the session is known (a DECN partner
// node limits hosted staff to the continuity services). A guard returns an
// error code to refuse the request, or a falsy value to allow it.
const sessionGuards = [];
export function addSessionGuard(fn) { if (typeof fn === "function") sessionGuards.push(fn); }
function guardRefusal(req) { for (const g of sessionGuards) { const code = g(req); if (code) return code; } return null; }

export async function requireSession(req, res, next) {
  try {
    const cookies = parse(req.headers.cookie || "");
    const raw = cookies[config.cookieName];
    if (!raw || raw.length > 256) return res.status(401).json({ error: "authentication_required" });
    const hash = sha256(raw);
    req._sessionTokenHash = hash; // used by logout / membership switch to evict the cache
    req._sessionRaw = raw;
    const cached = cacheGetSession(hash);
    if (cached) { req.actor = { ...cached }; const refused = guardRefusal(req); if (refused) return res.status(403).json({ error: refused }); return next(); }
    const result = await pool.query(
      `SELECT s.id AS session_id, s.user_id, s.district_id, s.school_id, s.role,
              s.csrf_token_hash, s.verified_email, s.last_seen_at, u.display_name, u.status
         FROM sessions s
         JOIN users u ON u.id=s.user_id
         JOIN memberships m ON m.user_id=s.user_id AND m.district_id=s.district_id
                           AND m.school_id IS NOT DISTINCT FROM s.school_id
                           AND m.role=s.role AND m.status='active'
         JOIN districts d ON d.id=s.district_id AND d.status='active'
        WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
          AND s.last_seen_at > now() - make_interval(mins => $2)
          AND u.status='active'`,
      [hash, config.sessionIdleMinutes]
    );
    if (result.rowCount !== 1) return res.status(401).json({ error: "invalid_session" });
    const row = result.rows[0];
    // Idle timeout: refresh last_seen_at at most once a minute per session.
    if (row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() > SESSION_TOUCH_INTERVAL_MS) {
      await pool.query("UPDATE sessions SET last_seen_at=now() WHERE id=$1", [row.session_id]);
    }
    req.actor = {
      userId: row.user_id, districtId: row.district_id,
      schoolId: row.school_id, role: row.role,
      displayName: row.display_name, sessionId: row.session_id,
      csrfTokenHash: row.csrf_token_hash, verifiedEmail: row.verified_email || null
    };
    cacheSetSession(hash, req.actor);
    const refused = guardRefusal(req);
    if (refused) return res.status(403).json({ error: refused });
    next();
  } catch (error) { next(error); }
}

export async function logout(req, res, next) {
  try {
    const cookies = parse(req.headers.cookie || "");
    const raw = cookies[config.cookieName];
    if (raw) {
      const h = sha256(raw);
      await pool.query("UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL", [h]);
      evictSession(h); // never serve a logged-out session from cache
    }
    res.setHeader("Set-Cookie", serialize(config.cookieName, "", { ...cookieOptions, maxAge: 0 }));
    res.status(204).end();
  } catch (error) { next(error); }
}

export function requireCsrf(req, res, next) {
  const supplied = req.get("X-CSRF-Token");
  if (typeof supplied !== "string" || supplied.length > 256 ||
      !req.actor.csrfTokenHash || !safeEqual(sha256(supplied), req.actor.csrfTokenHash)) {
    return res.status(403).json({ error: "csrf_validation_failed" });
  }
  next();
}

/** Returns the session's CSRF token. Side-effect free (no rotation). */
export function issueCsrfToken(req, res) {
  const token = csrfTokenFor(req._sessionRaw);
  if (!safeEqual(sha256(token), req.actor.csrfTokenHash || "")) {
    return res.status(401).json({ error: "invalid_session" });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ csrfToken: token });
}

/** Lists the signed-in user's active memberships (roles/schools). */
export async function listMemberships(req, res, next) {
  try {
    const result = await pool.query(
      `SELECT m.id, m.district_id, m.school_id, sc.name AS school_name, m.role, m.is_default
         FROM memberships m JOIN districts d ON d.id=m.district_id AND d.status='active'
         LEFT JOIN schools sc ON sc.id=m.school_id
        WHERE m.user_id=$1 AND m.status='active'
        ORDER BY m.is_default DESC, m.role, sc.name`,
      [req.actor.userId]
    );
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: result.rows.map(r => ({ ...r,
      current: r.district_id === req.actor.districtId && r.role === req.actor.role && (r.school_id || null) === (req.actor.schoolId || null) })) });
  } catch (error) { next(error); }
}

/**
 * Switch the session to another of the user's active memberships. The session
 * token is rotated (privilege change) and the old one revoked.
 */
export async function switchMembership(req, res, next) {
  try {
    const membershipId = req.body?.membershipId;
    if (typeof membershipId !== "string" || !/^[0-9a-f-]{36}$/i.test(membershipId))
      return res.status(400).json({ error: "invalid_membership_id" });
    const found = await pool.query(
      `SELECT m.district_id, m.school_id, m.role FROM memberships m
         JOIN districts d ON d.id=m.district_id AND d.status='active'
        WHERE m.id=$1 AND m.user_id=$2 AND m.status='active'`,
      [membershipId, req.actor.userId]
    );
    if (!found.rowCount) return res.status(404).json({ error: "membership_not_found" });
    const m = found.rows[0];
    const current = await pool.query("SELECT verified_email FROM sessions WHERE id=$1", [req.actor.sessionId]);
    await pool.query("UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL", [req.actor.sessionId]);
    evictSession(req._sessionTokenHash);
    const { rawSession, expiresAt } = await createSession(pool, {
      userId: req.actor.userId, districtId: m.district_id, schoolId: m.school_id, role: m.role,
      verifiedEmail: current.rows[0]?.verified_email || null
    });
    setSessionCookie(res, rawSession, expiresAt);
    res.setHeader("Cache-Control", "no-store");
    res.json({ role: m.role, districtId: m.district_id, schoolId: m.school_id, csrfToken: csrfTokenFor(rawSession) });
  } catch (error) { next(error); }
}

// Device sign-in (RFC 8628 device authorization grant) for screens that can't
// run a browser sign-in: Android TV / Google TV, Fire TV, Roku and the
// Windows desktop app. See db/150_device_sign_in.sql and
// docs/CLIENT-PLATFORMS.md.
//
//   POST /auth/device/code   {clientKind, deviceLabel?}  (no session)
//        -> {deviceCode, userCode "BCDF-GHJK", verificationUri(Complete), qr, expiresIn, interval}
//   POST /api/device-sign-in/check   {userCode}  (session + CSRF) -> what is asking
//   POST /api/device-sign-in/approve {userCode}  (session + CSRF)
//   POST /api/device-sign-in/deny    {userCode}  (session + CSRF)
//   POST /auth/device/token  {deviceCode}  (no session, polled)
//        -> 400 authorization_pending | slow_down | access_denied | expired_token | invalid_grant
//        -> 200 {tokenType:"Bearer", sessionToken, csrfToken, ...} once, after approval
//
// TV and Roku sessions are read-only: a session guard refuses every
// state-changing request except signing out and switching role. A Windows
// session is a full session (it is a personal computer, like the phone app).
// A device session can never approve another device.
import crypto from "node:crypto";
import { config } from "./config.js";
import { pool, withTenantTransaction } from "./db.js";
import { addSessionGuard, authorityRole, createSession, csrfTokenFor } from "./auth.js";
import { randomSecret, sha256 } from "./oidc.js";
import { qrRows } from "./pickup-routes.js";

export const DEVICE_CLIENT_KINDS = Object.freeze(["android_tv", "fire_tv", "roku", "windows"]);
export const READ_ONLY_CLIENT_KINDS = Object.freeze(["android_tv", "fire_tv", "roku"]);
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
// Consonants only (no vowels, so no words; no 0/O or 1/I look-alikes):
// 20^8 ≈ 2.6e10 codes, each live for 10 minutes, approvals rate-limited.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

export function newUserCode(random = crypto.randomInt) {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[random(USER_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** "bcdf ghjk", "BCDF-GHJK" -> "BCDFGHJK"; anything that can't be a code -> null. */
export function normalizeUserCode(value) {
  if (typeof value !== "string" || value.length > 32) return null;
  const code = value.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== USER_CODE_LENGTH) return null;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
// The only writes a read-only (TV/Roku) session may make.
const READ_ONLY_ALLOWED_WRITES = new Set(["/auth/logout", "/api/session/membership"]);

/** Session guard: TV and Roku sessions can read, sign out and switch role, nothing else. */
export function readOnlyDeviceGuard(req) {
  if (!READ_ONLY_CLIENT_KINDS.includes(req.actor?.clientKind)) return null;
  if (SAFE_METHODS.has(req.method)) return null;
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return READ_ONLY_ALLOWED_WRITES.has(path) ? null : "device_session_read_only";
}
addSessionGuard(readOnlyDeviceGuard);

/** One audit event in the person's district (EDAL): who signed which screen in. */
function auditDevice(actor, action, requestId, clientKind, req) {
  return withTenantTransaction(actor, c => c.query(
    `INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail,request_id)
     VALUES($1,$2,$3,$4,'device_sign_in',$5,'success',$6,$7)`,
    [actor.districtId, actor.userId, actor.role, action, requestId, `client_kind=${clientKind}`, req.requestId || null]));
}

const disabled = res => res.status(404).json({ error: "device_sign_in_disabled" });
const deviceError = (res, error, status = 400) => res.status(status).json({ error });

/** POST /auth/device/code */
export async function startDeviceSignIn(req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (!config.deviceSignInEnabled) return disabled(res);
    const { clientKind, deviceLabel } = req.body || {};
    if (!DEVICE_CLIENT_KINDS.includes(clientKind)) return deviceError(res, "invalid_client_kind");
    let label = null;
    if (deviceLabel !== undefined && deviceLabel !== null) {
      if (typeof deviceLabel !== "string") return deviceError(res, "invalid_device_label");
      label = deviceLabel.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || null;
    }
    await pool.query("DELETE FROM device_sign_in_requests WHERE expires_at <= now()");
    const deviceCode = randomSecret(32);
    // A user-code collision with a live request is astronomically unlikely;
    // retry a few times rather than fail on the UNIQUE constraint.
    for (let attempt = 0; attempt < 5; attempt++) {
      const userCode = newUserCode();
      const inserted = await pool.query(
        `INSERT INTO device_sign_in_requests(device_code_hash,user_code_hash,client_kind,device_label,expires_at)
         VALUES($1,$2,$3,$4,now() + make_interval(secs => $5))
         ON CONFLICT (user_code_hash) DO NOTHING RETURNING id`,
        [sha256(deviceCode), sha256(normalizeUserCode(userCode)), clientKind, label, DEVICE_CODE_TTL_SECONDS]);
      if (!inserted.rowCount) continue;
      const verificationUri = new URL("/device/", config.publicOrigin).toString();
      const verificationUriComplete = `${verificationUri}#${userCode}`;
      return res.status(200).json({
        deviceCode, userCode, verificationUri, verificationUriComplete,
        // QR modules ("0"/"1" rows) of verificationUriComplete, so a TV or Roku
        // can show a code to scan without a QR library or an image request.
        qr: qrRows(verificationUriComplete),
        expiresIn: DEVICE_CODE_TTL_SECONDS, interval: DEVICE_POLL_INTERVAL_SECONDS
      });
    }
    return deviceError(res, "try_again", 503);
  } catch (error) { next(error); }
}

/** POST /auth/device/token: polled by the device until the code is approved. */
export async function redeemDeviceSignIn(req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (!config.deviceSignInEnabled) return disabled(res);
    const deviceCode = req.body?.deviceCode;
    if (typeof deviceCode !== "string" || !/^[A-Za-z0-9_-]{20,128}$/.test(deviceCode))
      return deviceError(res, "invalid_request");
    const hash = sha256(deviceCode);
    const found = await pool.query(
      `SELECT id, status, expires_at <= now() AS expired,
              last_polled_at > now() - make_interval(secs => $2) AS too_fast
         FROM device_sign_in_requests WHERE device_code_hash=$1`,
      [hash, DEVICE_POLL_INTERVAL_SECONDS - 1]);
    const row = found.rows[0];
    if (!row) return deviceError(res, "invalid_grant");
    if (row.expired) {
      await pool.query("DELETE FROM device_sign_in_requests WHERE id=$1", [row.id]);
      return deviceError(res, "expired_token");
    }
    if (row.status === "denied") {
      await pool.query("DELETE FROM device_sign_in_requests WHERE id=$1", [row.id]);
      return deviceError(res, "access_denied");
    }
    if (row.status === "pending") {
      await pool.query("UPDATE device_sign_in_requests SET last_polled_at=now() WHERE id=$1", [row.id]);
      return deviceError(res, row.too_fast ? "slow_down" : "authorization_pending");
    }
    // Approved: consume it exactly once, re-checking the approving membership.
    const consumed = await pool.query(
      "DELETE FROM device_sign_in_requests WHERE id=$1 AND status='approved' RETURNING id, user_id, membership_id, verified_email, client_kind",
      [row.id]);
    const grant = consumed.rows[0];
    if (!grant) return deviceError(res, "invalid_grant");
    const membership = await pool.query(
      `SELECT m.district_id, m.school_id, m.role FROM memberships m
         JOIN users u ON u.id=m.user_id AND u.status='active'
         JOIN districts d ON d.id=m.district_id AND d.status='active'
        WHERE m.id=$1 AND m.user_id=$2 AND m.status='active'`,
      [grant.membership_id, grant.user_id]);
    if (!membership.rowCount) return deviceError(res, "account_not_active", 403);
    const m = membership.rows[0];
    const { rawSession, expiresAt } = await createSession(pool, {
      userId: grant.user_id, districtId: m.district_id, schoolId: m.school_id, role: m.role,
      verifiedEmail: grant.verified_email, clientKind: grant.client_kind
    });
    await auditDevice({ userId: grant.user_id, districtId: m.district_id, schoolId: m.school_id, ...authorityRole(m.role) },
      "session_created", grant.id, grant.client_kind, req);
    res.json({
      tokenType: "Bearer", sessionToken: rawSession, csrfToken: csrfTokenFor(rawSession),
      expiresAt: expiresAt.toISOString(), role: authorityRole(m.role).role, membershipRole: m.role,
      idleMinutes: config.sessionIdleMinutes, clientKind: grant.client_kind,
      readOnly: READ_ONLY_CLIENT_KINDS.includes(grant.client_kind)
    });
  } catch (error) { next(error); }
}

// The signed-in person's half. Device sessions can't approve devices.
function approverCode(req, res) {
  if (!config.deviceSignInEnabled) { disabled(res); return null; }
  if (req.actor.clientKind) { deviceError(res, "device_session_cannot_approve", 403); return null; }
  const code = normalizeUserCode(req.body?.userCode);
  if (!code) { deviceError(res, "invalid_user_code"); return null; }
  return sha256(code);
}
const describe = r => ({ clientKind: r.client_kind, deviceLabel: r.device_label, expiresAt: r.expires_at,
  readOnly: READ_ONLY_CLIENT_KINDS.includes(r.client_kind) });

/** POST /api/device-sign-in/check: what is asking to sign in (no change). */
export async function checkDeviceSignIn(req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const hash = approverCode(req, res); if (!hash) return;
    const r = await pool.query(
      "SELECT client_kind, device_label, expires_at FROM device_sign_in_requests WHERE user_code_hash=$1 AND status='pending' AND expires_at > now()",
      [hash]);
    if (!r.rowCount) return deviceError(res, "code_not_found", 404);
    res.json({ data: describe(r.rows[0]) });
  } catch (error) { next(error); }
}

/** POST /api/device-sign-in/approve: sign the device in as this membership. */
export async function approveDeviceSignIn(req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const hash = approverCode(req, res); if (!hash) return;
    const membership = await pool.query(
      `SELECT m.id FROM memberships m
        WHERE m.user_id=$1 AND m.district_id=$2 AND m.school_id IS NOT DISTINCT FROM $3 AND m.role=$4 AND m.status='active'
        LIMIT 1`,
      [req.actor.userId, req.actor.districtId, req.actor.schoolId ?? null, req.actor.membershipRole || req.actor.role]);
    if (!membership.rowCount) return deviceError(res, "membership_not_found", 403);
    const r = await pool.query(
      `UPDATE device_sign_in_requests
          SET status='approved', user_id=$2, membership_id=$3, verified_email=$4, decided_at=now()
        WHERE user_code_hash=$1 AND status='pending' AND expires_at > now()
        RETURNING id, client_kind, device_label, expires_at`,
      [hash, req.actor.userId, membership.rows[0].id, req.actor.verifiedEmail || null]);
    if (!r.rowCount) return deviceError(res, "code_not_found", 404);
    await auditDevice(req.actor, "approve", r.rows[0].id, r.rows[0].client_kind, req);
    res.json({ data: { ...describe(r.rows[0]), status: "approved" } });
  } catch (error) { next(error); }
}

/** POST /api/device-sign-in/deny: refuse a code (e.g. one you didn't start). */
export async function denyDeviceSignIn(req, res, next) {
  try {
    res.setHeader("Cache-Control", "no-store");
    const hash = approverCode(req, res); if (!hash) return;
    const r = await pool.query(
      `UPDATE device_sign_in_requests SET status='denied', decided_at=now()
        WHERE user_code_hash=$1 AND status='pending' AND expires_at > now()
        RETURNING id, client_kind, device_label, expires_at`,
      [hash]);
    if (!r.rowCount) return deviceError(res, "code_not_found", 404);
    await auditDevice(req.actor, "deny", r.rows[0].id, r.rows[0].client_kind, req);
    res.json({ data: { ...describe(r.rows[0]), status: "denied" } });
  } catch (error) { next(error); }
}

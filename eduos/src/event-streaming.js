// Helpers for non-sport live events and paywalled livestreams (db/154).
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const EVENT_KINDS = Object.freeze(["sport", "play", "concert", "assembly", "ceremony", "club_showcase", "other"]);
export const PASS_KINDS = Object.freeze(["admission", "stream_pass", "season_stream_pass"]);
export const STREAM_ACCESS_MODES = Object.freeze(["free", "paid_pass"]);

export function hashStreamSecret(secret) {
  if (typeof secret !== "string" || secret.trim().length < 12 || secret.length > 256) return null;
  return createHash("sha256").update(secret.trim()).digest("hex");
}

function keyBytes(signingSecret) {
  return createHash("sha256").update(`eduos-stream-token:${signingSecret}`).digest();
}

export function signStreamToken(claims, signingSecret, ttlSeconds = 900) {
  const exp = Math.floor(Date.now() / 1000) + Math.max(60, Math.min(3600, ttlSeconds));
  const payload = Buffer.from(JSON.stringify({ ...claims, exp })).toString("base64url");
  const sig = createHmac("sha256", keyBytes(signingSecret)).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyStreamToken(token, signingSecret, expected = {}) {
  if (typeof token !== "string" || !token.includes(".")) return { ok: false, reason: "invalid_stream_token" };
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return { ok: false, reason: "invalid_stream_token" };
  const want = createHmac("sha256", keyBytes(signingSecret)).update(payload).digest();
  let got;
  try { got = Buffer.from(sig, "base64url"); } catch { return { ok: false, reason: "invalid_stream_token" }; }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: "invalid_stream_token" };
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return { ok: false, reason: "invalid_stream_token" }; }
  if (!parsed || typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: "stream_token_expired" };
  for (const [k, v] of Object.entries(expected)) {
    if (v !== undefined && parsed[k] !== v) return { ok: false, reason: "stream_token_scope_mismatch" };
  }
  return { ok: true, claims: parsed };
}

// Fail-closed server-side gate for stream access.
export function evaluateStreamAccess({ stream, hasPass, isLead, unconsentedCount = 0 }) {
  if (!stream) return { allowed: false, status: 404, reason: "stream_not_found" };
  if (!stream.live_enabled) return { allowed: false, status: 403, reason: "stream_live_kill_switch_off" };
  if (stream.media_consent_required && unconsentedCount > 0 && !stream.unconsented_minors_masked) {
    return { allowed: false, status: 409, reason: "media_consent_masking_required" };
  }
  if ((stream.access_mode === "paid_pass" || stream.audience === "ticket_holders") && !hasPass && !isLead) {
    return { allowed: false, status: 403, reason: "stream_pass_required" };
  }
  return {
    allowed: true,
    status: 200,
    unconsentedExcludedOrBlurred: Boolean(stream.unconsented_minors_masked && unconsentedCount > 0),
    unconsentedCount
  };
}

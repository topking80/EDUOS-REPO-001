// EduOS 37.6.0 learner wallet. Credentials recorded on EDAL (32.6/32.7) can be
// exported as W3C Verifiable Credentials 2.0 in the Open Badges 3.0
// "OpenBadgeCredential" format, secured with a Data Integrity proof
// (cryptosuite eddsa-jcs-2022, Ed25519) by a per-school did:key issuer key.
// PARTIAL PROFILE (honest): not 1EdTech-certified; no credentialStatus list
// (revocation is checked live on this server); did:key, not a hosted issuer
// profile; no evidence files. See docs/UPGRADING-37.6.0.md.
// The learner (or guardian) controls sharing: they choose how the name shows
// (initials / full / none) and how long a link lives, and can revoke it.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { config } from "./config.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, HttpError } from "./role-app-util.js";
import { wrap, created, need } from "./route-helpers.js";
import { wallet } from "./wallet/config.js";
import { deriveIssuerSeed, keyPairFromSeed, buildOpenBadge, signOpenBadge, verifyDataIntegrity, minimalView, credentialUuid } from "./wallet/vc.js";

const ANON_USER = "00000000-0000-0000-0000-000000000000";
const NAME_MODES = ["initials", "full", "none"];
export const PROFILE_NOTE = "Open Badges 3.0 / W3C VC 2.0 credential with an eddsa-jcs-2022 Data Integrity proof. Partial profile: not 1EdTech-certified, no status list (revocation is checked live by the issuing school), did:key issuer.";

function issuer(districtId, schoolId) {
  if (!wallet.issuerSecret) throw new HttpError(503, "wallet_issuer_not_configured", { message: "The district has not set WALLET_ISSUER_SECRET yet." });
  const seed = deriveIssuerSeed(wallet.issuerSecret, districtId, schoolId);
  return { seed, did: keyPairFromSeed(seed).did };
}
const verifyBase = districtId => `${config.publicOrigin.replace(/\/$/, "")}/verify/?d=${districtId}`;
function salt(credentialId, studentId) {
  return crypto.createHmac("sha256", wallet.issuerSecret).update(`wallet-salt:${credentialId}:${studentId}`).digest("hex").slice(0, 32);
}
async function buildSigned(client, req, credentialId, nameDisplay) {
  const c = await one(client, `SELECT * FROM eduos_wallet_export_inputs($1)`, [credentialId]);
  need(c, 404, "credential_not_found");
  if (c.revoked) throw new HttpError(409, "credential_revoked");
  const iss = issuer(req.actor.districtId, c.school_id);
  const badge = buildOpenBadge({
    credential: { id: c.credential_id, kind: c.kind, title: c.title, description: c.description, issuedAt: c.issued_at, edalEntryHash: c.edal_entry_hash },
    learner: { fullName: c.learner_name, salt: salt(c.credential_id, c.student_id) },
    school: { did: iss.did, name: c.school_name, url: verifyBase(req.actor.districtId) }, nameDisplay, verifyBase: verifyBase(req.actor.districtId)
  });
  return { c, vc: signOpenBadge(badge, iss.seed) };
}
const sha = t => crypto.createHash("sha256").update(t).digest("hex");

export function registerWalletRoutes(app) {
  const limiter = rateLimit({ windowMs: 60_000, limit: config.commsRateLimit, standardHeaders: true, legacyHeaders: false });
  const publicLimiter = rateLimit({ windowMs: 60_000, limit: wallet.publicVerifyRateLimit, standardHeaders: true, legacyHeaders: false });

  app.get("/api/wallet", requireSession, requirePermission("wallet", "hold"), wrap(async (client, req) => {
    const creds = await rows(client, `SELECT * FROM eduos_wallet_credentials()`);
    const shares = await rows(client, `SELECT id,credential_id,name_display,expires_at,revoked_at,view_count,last_viewed_at,created_at FROM wallet_shares ORDER BY created_at DESC`);
    return { issuerReady: Boolean(wallet.issuerSecret), profile: PROFILE_NOTE,
      credentials: creds.map(c => ({ id: c.id, kind: c.kind, title: c.title, description: c.description, issuedAt: c.issued_at, revoked: c.revoked,
        learner: c.learner_name, school: c.school_name, onLedger: c.on_ledger,
        shares: shares.filter(s => s.credential_id === c.id).map(s => ({ id: s.id, nameDisplay: s.name_display, expiresAt: s.expires_at, revoked: Boolean(s.revoked_at),
          views: s.view_count, lastViewedAt: s.last_viewed_at, createdAt: s.created_at,
          state: s.revoked_at ? "revoked" : new Date(s.expires_at) < new Date() ? "expired" : "active" })) })) };
  }));

  app.get("/api/wallet/credentials/:id/vc", limiter, requireSession, requirePermission("wallet", "hold"), async (req, res, next) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_credential_id" });
    const nameDisplay = NAME_MODES.includes(req.query.name) ? req.query.name : "initials";
    try {
      const vc = await withTenantTransaction(req.actor, async client => {
        const out = await buildSigned(client, req, req.params.id, nameDisplay);
        await audit(client, req, "export", "credential", req.params.id, `ob3;name=${nameDisplay}`);
        return out.vc;
      });
      res.setHeader("Content-Type", "application/vc+ld+json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="credential-${req.params.id.slice(0, 8)}.json"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(JSON.stringify(vc, null, 2));
    } catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.code, ...(e.extra || {}) });
      next(e);
    }
  });

  app.post("/api/wallet/credentials/:id/shares", limiter, requireSession, requireCsrf, requirePermission("wallet", "hold"), wrap(async (client, req) => {
    need(validId(req.params.id), 400, "invalid_credential_id");
    const nameDisplay = req.body?.nameDisplay ?? "initials";
    need(NAME_MODES.includes(nameDisplay), 400, "invalid_name_display");
    const days = Number(req.body?.days ?? 30);
    need(Number.isInteger(days) && days >= 1 && days <= wallet.shareMaxDays, 400, "invalid_days", { max: wallet.shareMaxDays });
    const { c, vc } = await buildSigned(client, req, req.params.id, nameDisplay);
    const token = crypto.randomBytes(24).toString("base64url");
    const r = await one(client, `INSERT INTO wallet_shares(district_id,school_id,credential_id,student_id,created_by,created_role,token_hash,name_display,vc_json,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+make_interval(days => $10)) RETURNING id,expires_at`,
      [req.actor.districtId, c.school_id, c.credential_id, c.student_id, req.actor.userId, req.actor.role, sha(token), nameDisplay, JSON.stringify(vc), days]);
    await audit(client, req, "share.create", "wallet_share", r.id, `credential=${c.credential_id};name=${nameDisplay};days=${days}`);
    return created({ id: r.id, expiresAt: r.expires_at, url: `${config.publicOrigin.replace(/\/$/, "")}/verify/#${req.actor.districtId}.${token}`,
      note: "Anyone with this link can see the achievement, the school and the name as you chose. You can turn it off any time." });
  }));
  app.post("/api/wallet/shares/:id/revoke", limiter, requireSession, requireCsrf, requirePermission("wallet", "hold"), wrap(async (client, req) => {
    need(validId(req.params.id), 400, "invalid_share_id");
    const r = await client.query(`UPDATE wallet_shares SET revoked_by=$2, revoked_at=now() WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [req.params.id, req.actor.userId]);
    need(r.rowCount, 404, "not_found");
    await audit(client, req, "share.revoke", "wallet_share", req.params.id);
    return { id: req.params.id, revoked: true };
  }));

  // ---- public verification (no session; minimum fields only) ----
  function checkProof(vc, districtId, schoolId) {
    const v = verifyDataIntegrity(vc);
    if (!v.verified) return { ok: false, reason: v.reason || "signature_invalid" };
    if (wallet.issuerSecret && districtId && schoolId) {
      const expected = keyPairFromSeed(deriveIssuerSeed(wallet.issuerSecret, districtId, schoolId)).did;
      if (vc.issuer?.id !== expected) return { ok: false, reason: "issuer_mismatch" };
    }
    return { ok: true };
  }
  app.get("/api/public/wallet/:districtId/:token", publicLimiter, async (req, res, next) => {
    const { districtId, token } = req.params;
    res.setHeader("Cache-Control", "no-store");
    if (!validId(districtId) || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).json({ error: "not_found" });
    try {
      const r = await withTenantTransaction({ districtId, userId: ANON_USER, role: "anonymous" }, async client =>
        (await client.query(`SELECT eduos_wallet_share_lookup($1) AS j`, [sha(token)])).rows[0]?.j);
      if (!r) return res.status(404).json({ error: "not_found" });
      if (r.state !== "ok") return res.json({ data: { result: r.state } });
      const proof = checkProof(r.credential, districtId, r.schoolId);
      const result = !proof.ok ? "invalid" : r.revoked ? "revoked" : "valid";
      res.json({ data: { result, reason: proof.reason || null, view: minimalView(r.credential), school: r.school, shareExpires: r.expiresAt, profile: PROFILE_NOTE } });
    } catch (e) { next(e); }
  });
  app.post("/api/public/wallet/verify", publicLimiter, async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    const vc = req.body?.credential;
    if (!vc || typeof vc !== "object" || JSON.stringify(vc).length > 20000) return res.status(400).json({ error: "invalid_credential" });
    try {
      let districtId = null;
      try { districtId = new URL(vc.issuer?.url || "").searchParams.get("d"); } catch { /* not ours */ }
      const id = credentialUuid(vc);
      let status = null;
      if (validId(districtId) && id) {
        status = await withTenantTransaction({ districtId, userId: ANON_USER, role: "anonymous" }, async client =>
          (await client.query(`SELECT eduos_wallet_credential_status($1) AS j`, [id])).rows[0]?.j);
      }
      const proof = checkProof(vc, status?.schoolId ? districtId : null, status?.schoolId || null);
      const result = !proof.ok ? "invalid" : status?.status === "revoked" ? "revoked" : status?.status === "active" ? "valid" : "signature_only";
      res.json({ data: { result, reason: proof.reason || null, view: minimalView(vc), school: status?.school || null, profile: PROFILE_NOTE } });
    } catch (e) { next(e); }
  });
}

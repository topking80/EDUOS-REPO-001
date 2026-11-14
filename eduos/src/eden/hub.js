// EduOS 32.7.0 district hub (EDUOS_NODE_TIER=district).
//   /api/eden/v1/*     node-to-hub API: signed by the node's Ed25519 key, whose
//                      certificate this hub issued under the pinned root.
//   /api/eden/admin/*  district superintendent / IT screens (session + CSRF).
// The hub never receives student-level data from nodes: aggregates are
// re-validated against the gate on arrival; DECN packages are ciphertext
// sealed to the partner node and the hub holds no key to open them.
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { withTenantTransaction } from "../db.js";
import { requireSession, requireCsrf } from "../auth.js";
import { requirePermission } from "../policy.js";
import { verifyReleased, GateError } from "./aggregation-gate.js";
import { issueCertificate, verifyRequestSignature, checkProofOfPossession, signBundle, verifyBundle, canonical, sha256, BUNDLE_KINDS, verifyCertificate } from "./crypto.js";
import { districtIdentity, withSystem, SYSTEM_USER } from "./runtime.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const err = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });
const online = n => Boolean(n.last_seen_at) && Date.now() - new Date(n.last_seen_at).getTime() < config.edenNodeOfflineAfterMs;
async function audit(client, actor, action, type, id, detail) {
  await client.query(`INSERT INTO audit_events(district_id,actor_user_id,actor_role,action,resource_type,resource_id,outcome,detail)
    VALUES($1,$2,$3,$4,$5,$6,'success',$7)`, [actor.districtId, actor.userId, actor.role, action, type, id, detail ? String(detail).slice(0, 500) : null]);
}
async function failoverEvent(client, id, event, actor, detail = {}) {
  await client.query(`INSERT INTO eden_failover_events(district_id,failover_id,event,actor,detail) VALUES(eduos_ctx_district(),$1,$2,$3,$4)`,
    [id, event, String(actor).slice(0, 80), JSON.stringify(detail)]);
}

export function registerEdenHub(app) {
  const id = districtIdentity();
  const status = { enabled: Boolean(id), reason: id ? null : "EDEN_ROOT_CERT / EDEN_DISTRICT_CERT / EDEN_DISTRICT_KEY missing or invalid" };
  if (!id) console.warn(`EDEN hub disabled: ${status.reason}`);
  const D = id?.districtId;
  const sys = fn => withSystem("eden_hub", D, null, fn);
  const enrollLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });
  const ready = (_req, res, next) => id ? next() : err(res, 503, "eden_not_configured");

  // ---- node authentication (signed requests) -------------------------------
  async function nodeAuth(req, res, next) {
    try {
      const nodeId = String(req.get("x-eden-node") || "");
      if (!UUID.test(nodeId)) return err(res, 401, "node_signature_required");
      const node = await sys(async c => (await c.query(`SELECT * FROM eden_nodes WHERE id=$1`, [nodeId])).rows[0]);
      if (!node) return err(res, 401, "unknown_node");
      if (node.status !== "active") return err(res, 403, "node_revoked");
      const v = verifyRequestSignature({ signPublic: node.sign_public, method: req.method, path: req.originalUrl, body: req.rawBody || "", headers: req.headers });
      if (!v.ok) return err(res, 401, v.reason);
      const cert = verifyCertificate(node.cert, { root: id.root, chain: [id.cert] });
      if (!cert.ok) return err(res, 403, `certificate_${cert.reason}`);
      const fresh = await sys(async c => {
        if (Math.random() < 0.05) await c.query(`DELETE FROM eden_nonces WHERE seen_at < now() - interval '15 minutes'`);
        return (await c.query(`INSERT INTO eden_nonces(district_id,node_id,nonce) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING nonce`, [D, nodeId, v.nonce])).rowCount;
      });
      if (!fresh) return err(res, 401, "replayed_request");
      req.node = node;
      next();
    } catch (e) { next(e); }
  }

  // ---- enrollment ------------------------------------------------------------
  app.post("/api/eden/v1/enroll", enrollLimiter, ready, async (req, res, next) => {
    const { token, name, signPublic, boxPublic, proof } = req.body || {};
    if (typeof token !== "string" || token.length < 20 || token.length > 200 || typeof signPublic !== "string" || typeof boxPublic !== "string" || typeof proof !== "string")
      return err(res, 400, "invalid_enrollment");
    const tokenHash = sha256(token);
    if (!checkProofOfPossession(signPublic, `${tokenHash}\n${boxPublic}`, proof)) return err(res, 400, "proof_of_possession_failed");
    try {
      const out = await sys(async c => {
        const t = (await c.query(`SELECT * FROM eden_enrollment_tokens WHERE token_hash=$1 FOR UPDATE`, [tokenHash])).rows[0];
        if (!t || t.used_at || new Date(t.expires_at) < new Date()) return { status: 403, error: "enrollment_token_invalid" };
        const existing = (await c.query(`SELECT id FROM eden_nodes WHERE school_id=$1 AND tier='school' AND status='active'`, [t.school_id])).rows[0];
        if (existing) return { status: 409, error: "school_already_has_a_node" };
        const nodeId = crypto.randomUUID();
        const cert = issueCertificate({ kind: "node", id: nodeId, name: String(name || t.name).slice(0, 80), districtId: D, schoolId: t.school_id,
          signPublic, boxPublic, days: 365, issuer: id.cert, issuerPrivate: id.signPrivate });
        await c.query(`INSERT INTO eden_nodes(id,district_id,school_id,name,sign_public,box_public,cert,cert_serial,enrolled_by)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [nodeId, D, t.school_id, String(name || t.name).slice(0, 80), signPublic, boxPublic, JSON.stringify(cert), cert.serial, t.created_by]);
        await c.query(`UPDATE eden_enrollment_tokens SET used_at=now(), node_id=$2 WHERE id=$1`, [t.id, nodeId]);
        await audit(c, { districtId: D, userId: SYSTEM_USER, role: "eden_hub" }, "eden_enroll", "eden_node", nodeId, `school=${t.school_id};token=${t.id}`);
        return { status: 201, body: { nodeId, schoolId: t.school_id, districtId: D, cert, chain: [id.cert], root: id.root } };
      });
      if (out.error) return err(res, out.status, out.error);
      res.status(201).json(out.body);
    } catch (e) { next(e); }
  });

  // ---- heartbeat + directives -----------------------------------------------
  app.post("/api/eden/v1/heartbeat", ready, nodeAuth, async (req, res, next) => {
    const b = req.body || {};
    try {
      const out = await sys(async c => {
        const me = req.node;
        await c.query(`UPDATE eden_nodes SET last_seen_at=now(), version=$2 WHERE id=$1`, [me.id, /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(b.version) ? b.version : null]);
        for (const [kind, version] of Object.entries(b.bundles || {}))
          if (BUNDLE_KINDS.includes(kind) && Number.isInteger(version) && version > 0)
            await c.query(`INSERT INTO eden_node_bundles(district_id,node_id,kind,version) VALUES($1,$2,$3,$4)
              ON CONFLICT (node_id,kind) DO UPDATE SET version=EXCLUDED.version, acked_at=now() WHERE eden_node_bundles.version<>EXCLUDED.version`, [D, me.id, kind, version]);
        await lifecycle(c);
        // The failed school's own node is back: hand services back automatically.
        const mine = (await c.query(`SELECT id,status FROM eden_failovers WHERE failed_node_id=$1 AND status IN ('authorized','active')`, [me.id])).rows;
        for (const f of mine) {
          if (f.status === "authorized") {
            await c.query(`UPDATE eden_failovers SET status='cancelled', closed_at=now() WHERE id=$1`, [f.id]);
            await failoverEvent(c, f.id, "cancelled", "hub", { reason: "origin_recovered_before_activation" });
          } else {
            await c.query(`UPDATE eden_failovers SET status='handing_back', handback_reason='origin_recovered', handback_started_at=now() WHERE id=$1`, [f.id]);
            await failoverEvent(c, f.id, "handback_started", "hub", { reason: "origin_recovered" });
          }
        }
        const latest = (await c.query(`SELECT kind, max(version)::int v FROM eden_bundles GROUP BY kind`)).rows;
        const bundles = latest.filter(r => (b.bundles?.[r.kind] || 0) < r.v).map(r => ({ kind: r.kind, version: r.v }));
        const partner = me.partner_node_id ? (await c.query(`SELECT id,cert,status FROM eden_nodes WHERE id=$1`, [me.partner_node_id])).rows[0] : null;
        const host = (await c.query(`SELECT f.id,f.school_id,f.failed_node_id,f.expires_at,f.status,f.package_sha256,n.cert FROM eden_failovers f JOIN eden_nodes n ON n.id=f.failed_node_id
            WHERE f.partner_node_id=$1 AND f.status IN ('authorized','active')`, [me.id])).rows;
        const handback = (await c.query(`SELECT f.id,n.cert FROM eden_failovers f JOIN eden_nodes n ON n.id=f.failed_node_id
            WHERE f.partner_node_id=$1 AND f.status='handing_back'`, [me.id])).rows;
        const returns = (await c.query(`SELECT f.id,n.cert FROM eden_failovers f JOIN eden_nodes n ON n.id=f.partner_node_id
            WHERE f.failed_node_id=$1 AND f.status='returned' AND f.imported_at IS NULL`, [me.id])).rows;
        const revoked = (await c.query(`SELECT cert_serial FROM eden_nodes WHERE status='revoked'`)).rows.map(r => r.cert_serial);
        return {
          now: new Date().toISOString(), districtCert: id.cert,
          partner: partner && partner.status === "active" ? { nodeId: partner.id, cert: partner.cert } : null,
          bundles,
          host: host.map(f => ({ failoverId: f.id, schoolId: f.school_id, originNodeId: f.failed_node_id, originCert: f.cert, expiresAt: f.expires_at, status: f.status, packageSha256: f.package_sha256 })),
          handback: handback.map(f => ({ failoverId: f.id, originCert: f.cert })),
          returns: returns.map(f => ({ failoverId: f.id, partnerCert: f.cert })),
          revokedSerials: revoked
        };
      });
      res.json(out);
    } catch (e) { next(e); }
  });

  // Time limits are enforced on every heartbeat and every admin read.
  async function lifecycle(c) {
    const expired = (await c.query(`UPDATE eden_failovers SET status='handing_back', handback_reason='expired', handback_started_at=now()
      WHERE status='active' AND expires_at < now() RETURNING id`)).rows;
    for (const f of expired) await failoverEvent(c, f.id, "handback_started", "hub", { reason: "expired" });
    const stale = (await c.query(`UPDATE eden_failovers SET status='cancelled', closed_at=now() WHERE status='authorized' AND expires_at < now() RETURNING id`)).rows;
    for (const f of stale) await failoverEvent(c, f.id, "cancelled", "hub", { reason: "expired_before_activation" });
  }

  // ---- aggregates up -----------------------------------------------------------
  app.post("/api/eden/v1/messages", ready, nodeAuth, async (req, res, next) => {
    const messages = req.body?.messages;
    if (!Array.isArray(messages) || messages.length > 200) return err(res, 400, "invalid_messages");
    try {
      const out = await sys(async c => {
        const accepted = [], rejected = [];
        for (const m of messages) {
          const bytes = Buffer.byteLength(canonical(m ?? null));
          const logIt = (decision, reason) => c.query(`INSERT INTO eden_inbound_log(district_id,node_id,message_id,kind,decision,reason,bytes) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [D, req.node.id, UUID.test(String(m?.id)) ? m.id : null, typeof m?.kind === "string" ? m.kind.slice(0, 40) : null, decision, reason, bytes]);
          if (!m || !UUID.test(String(m.id)) || !Number.isInteger(m.seq) || m.seq < 1) { rejected.push({ id: m?.id ?? null, reason: "malformed" }); await logIt("rejected", "malformed"); continue; }
          // The hub re-checks the gate: a node that skipped it (or was tampered with) is refused.
          try { verifyReleased(m.payload, { schoolId: req.node.school_id }); }
          catch (e) { rejected.push({ id: m.id, reason: e.code || "invalid" }); await logIt("rejected", `gate: ${e.code || "invalid"}`); continue; }
          if (m.payload.kind !== m.kind || m.payload.period !== m.period) { rejected.push({ id: m.id, reason: "envelope_mismatch" }); await logIt("rejected", "envelope_mismatch"); continue; }
          if (m.kind === "consented_record_transfer") {
            // Explicit, consent-gated exception: logged, never merged into aggregates.
            const dup = await c.query(`SELECT 1 FROM eden_inbound_log WHERE node_id=$1 AND message_id=$2 AND decision='accepted'`, [req.node.id, m.id]);
            if (!dup.rowCount) await logIt("accepted", `consent_exception ${m.payload.exceptionId}`);
            accepted.push(m.id); continue;
          }
          const prev = (await c.query(`SELECT seq FROM eden_aggregates WHERE node_id=$1 AND kind=$2 AND period=$3`, [req.node.id, m.kind, m.period])).rows[0];
          if (prev && Number(prev.seq) >= m.seq) { accepted.push(m.id); await logIt(Number(prev.seq) === m.seq ? "duplicate" : "stale", null); continue; }
          await c.query(`INSERT INTO eden_aggregates(district_id,node_id,school_id,kind,period,seq,payload) VALUES($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (node_id,kind,period) DO UPDATE SET seq=EXCLUDED.seq, payload=EXCLUDED.payload, received_at=now()`,
            [D, req.node.id, req.node.school_id, m.kind, m.period, m.seq, JSON.stringify(m.payload)]);
          if (m.kind === "node_health") await c.query(`UPDATE eden_nodes SET last_health=$2 WHERE id=$1`, [req.node.id, JSON.stringify(m.payload.metrics)]);
          await logIt("accepted", null);
          accepted.push(m.id);
        }
        return { accepted, rejected };
      });
      res.json(out);
    } catch (e) { next(e); }
  });

  // ---- signed bundles down -------------------------------------------------------
  app.get("/api/eden/v1/bundles/:kind", ready, nodeAuth, async (req, res, next) => {
    if (!BUNDLE_KINDS.includes(req.params.kind)) return err(res, 404, "unknown_bundle_kind");
    try {
      const b = await sys(async c => (await c.query(`SELECT bundle FROM eden_bundles WHERE kind=$1 ORDER BY version DESC LIMIT 1`, [req.params.kind])).rows[0]);
      if (!b) return err(res, 404, "no_bundle");
      res.setHeader("Cache-Control", "no-store");
      res.json({ bundle: b.bundle, chain: [id.cert] });
    } catch (e) { next(e); }
  });

  // ---- DECN: sealed continuity package (node -> partner, via the hub) ----------
  app.put("/api/eden/v1/continuity", ready, nodeAuth, async (req, res, next) => {
    const { partnerNodeId, envelope, counts } = req.body || {};
    if (!UUID.test(String(partnerNodeId)) || envelope?.v !== "EDEN-SEAL-1" || envelope.from !== req.node.id || envelope.to !== partnerNodeId || envelope.purpose !== "decn_continuity")
      return err(res, 400, "invalid_continuity_package");
    if (partnerNodeId !== req.node.partner_node_id) return err(res, 409, "partner_not_assigned");
    try {
      const sha = sha256(canonical(envelope)), bytes = Buffer.byteLength(req.rawBody || "");
      await sys(c => c.query(`INSERT INTO eden_continuity_packages(node_id,district_id,partner_node_id,envelope,sha256,bytes,counts) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (node_id) DO UPDATE SET partner_node_id=EXCLUDED.partner_node_id, envelope=EXCLUDED.envelope, sha256=EXCLUDED.sha256, bytes=EXCLUDED.bytes, counts=EXCLUDED.counts, uploaded_at=now()`,
        [req.node.id, D, partnerNodeId, JSON.stringify(envelope), sha, bytes, JSON.stringify(counts || {})]));
      res.json({ ok: true, sha256: sha });
    } catch (e) { next(e); }
  });
  const partnerOf = async (c, fid, node) => (await c.query(`SELECT * FROM eden_failovers WHERE id=$1 AND partner_node_id=$2`, [fid, node.id])).rows[0];
  app.get("/api/eden/v1/failovers/:id/package", ready, nodeAuth, async (req, res, next) => {
    if (!UUID.test(req.params.id)) return err(res, 400, "invalid_id");
    try {
      const out = await sys(async c => {
        const f = await partnerOf(c, req.params.id, req.node);
        if (!f || !["authorized", "active"].includes(f.status)) return null;
        const p = (await c.query(`SELECT envelope,sha256 FROM eden_continuity_packages WHERE node_id=$1 AND partner_node_id=$2`, [f.failed_node_id, req.node.id])).rows[0];
        if (!p || p.sha256 !== f.package_sha256) return null;
        await failoverEvent(c, f.id, "package_released", `node:${req.node.id}`, { sha256: p.sha256 });
        return p;
      });
      if (!out) return err(res, 404, "no_package");
      res.json({ envelope: out.envelope });
    } catch (e) { next(e); }
  });
  app.post("/api/eden/v1/failovers/:id/activated", ready, nodeAuth, async (req, res, next) => {
    if (!UUID.test(req.params.id)) return err(res, 400, "invalid_id");
    try {
      const ok = await sys(async c => {
        const f = await partnerOf(c, req.params.id, req.node);
        if (!f || f.status !== "authorized") return false;
        await c.query(`UPDATE eden_failovers SET status='active', activated_at=now(), restored_counts=$2 WHERE id=$1`, [f.id, JSON.stringify(req.body?.counts || {})]);
        await failoverEvent(c, f.id, "activated", `node:${req.node.id}`, { counts: req.body?.counts || {} });
        return true;
      });
      ok ? res.json({ ok }) : err(res, 409, "not_authorized");
    } catch (e) { next(e); }
  });
  app.put("/api/eden/v1/failovers/:id/return", ready, nodeAuth, async (req, res, next) => {
    const { envelope, counts } = req.body || {};
    if (!UUID.test(req.params.id) || envelope?.v !== "EDEN-SEAL-1" || envelope.from !== req.node.id || envelope.purpose !== "decn_return") return err(res, 400, "invalid_return_package");
    try {
      const ok = await sys(async c => {
        const f = await partnerOf(c, req.params.id, req.node);
        if (!f || !["handing_back", "returned"].includes(f.status) || envelope.to !== f.failed_node_id) return false;
        const sha = sha256(canonical(envelope));
        await c.query(`UPDATE eden_failovers SET status='returned', return_envelope=$2, return_sha256=$3, returned_at=now() WHERE id=$1`, [f.id, JSON.stringify(envelope), sha]);
        await failoverEvent(c, f.id, "return_uploaded", `node:${req.node.id}`, { sha256: sha, counts: counts || {} });
        return true;
      });
      ok ? res.json({ ok }) : err(res, 409, "not_handing_back");
    } catch (e) { next(e); }
  });
  app.post("/api/eden/v1/failovers/:id/purged", ready, nodeAuth, async (req, res, next) => {
    if (!UUID.test(req.params.id)) return err(res, 400, "invalid_id");
    try {
      const ok = await sys(async c => {
        const f = await partnerOf(c, req.params.id, req.node);
        if (!f || f.status !== "returned") return false;
        await c.query(`UPDATE eden_failovers SET purge_counts=$2, purged_at=now() WHERE id=$1`, [f.id, JSON.stringify(req.body?.counts || {})]);
        await failoverEvent(c, f.id, "purged", `node:${req.node.id}`, { counts: req.body?.counts || {} });
        await maybeClose(c, f.id);
        return true;
      });
      ok ? res.json({ ok }) : err(res, 409, "not_returned");
    } catch (e) { next(e); }
  });
  app.get("/api/eden/v1/failovers/:id/return", ready, nodeAuth, async (req, res, next) => {
    if (!UUID.test(req.params.id)) return err(res, 400, "invalid_id");
    try {
      const f = await sys(async c => (await c.query(`SELECT return_envelope FROM eden_failovers WHERE id=$1 AND failed_node_id=$2 AND status='returned'`, [req.params.id, req.node.id])).rows[0]);
      if (!f?.return_envelope) return err(res, 404, "no_return_package");
      res.json({ envelope: f.return_envelope });
    } catch (e) { next(e); }
  });
  app.post("/api/eden/v1/failovers/:id/imported", ready, nodeAuth, async (req, res, next) => {
    if (!UUID.test(req.params.id)) return err(res, 400, "invalid_id");
    try {
      const ok = await sys(async c => {
        const f = (await c.query(`SELECT * FROM eden_failovers WHERE id=$1 AND failed_node_id=$2 AND status='returned'`, [req.params.id, req.node.id])).rows[0];
        if (!f) return false;
        await c.query(`UPDATE eden_failovers SET import_counts=$2, imported_at=now() WHERE id=$1`, [f.id, JSON.stringify(req.body?.counts || {})]);
        await failoverEvent(c, f.id, "imported", `node:${req.node.id}`, { counts: req.body?.counts || {} });
        await maybeClose(c, f.id);
        return true;
      });
      ok ? res.json({ ok }) : err(res, 409, "not_returned");
    } catch (e) { next(e); }
  });
  async function maybeClose(c, fid) {
    const f = (await c.query(`SELECT * FROM eden_failovers WHERE id=$1`, [fid])).rows[0];
    if (f.status === "returned" && f.imported_at && f.purged_at) {
      // The ciphertext is no longer needed once the origin merged it and the partner purged.
      await c.query(`UPDATE eden_failovers SET status='closed', closed_at=now(), return_envelope=NULL WHERE id=$1`, [fid]);
      await failoverEvent(c, fid, "closed", "hub", {});
    }
  }

  // =============================================================================
  // District admin (superintendent / IT): node health, sync, failover controls.
  // =============================================================================
  const adminRead = [requireSession, requirePermission("eden", "read")];
  const adminWrite = [requireSession, requireCsrf, requirePermission("eden", "manage")];
  app.get("/api/eden/admin/overview", ...adminRead, async (req, res, next) => {
    try {
      const data = await withTenantTransaction(req.actor, async c => {
        if (id) await lifecycle(c).catch(() => {});
        const nodes = (await c.query(`SELECT n.id,n.school_id,s.name AS school_name,n.name,n.status,n.version,n.enrolled_at,n.last_seen_at,n.last_health,n.partner_node_id,
            n.cert->>'notAfter' AS cert_expires, n.cert_serial,
            (SELECT uploaded_at FROM eden_continuity_packages p WHERE p.node_id=n.id) AS continuity_at,
            (SELECT counts FROM eden_continuity_packages p WHERE p.node_id=n.id) AS continuity_counts,
            (SELECT count(*)::int FROM eden_aggregates a WHERE a.node_id=n.id) AS aggregates,
            (SELECT max(received_at) FROM eden_aggregates a WHERE a.node_id=n.id) AS last_aggregate_at,
            (SELECT jsonb_object_agg(kind, version) FROM eden_node_bundles b WHERE b.node_id=n.id) AS bundles
          FROM eden_nodes n JOIN schools s ON s.id=n.school_id ORDER BY s.name, n.enrolled_at`)).rows;
        const failovers = (await c.query(`SELECT f.id,f.school_id,s.name AS school_name,f.failed_node_id,f.partner_node_id,f.status,f.reason,f.authorized_at,f.expires_at,f.activated_at,
            f.handback_reason,f.handback_started_at,f.returned_at,f.purged_at,f.imported_at,f.closed_at,f.restored_counts,f.purge_counts,f.import_counts,u.display_name AS authorized_by_name
          FROM eden_failovers f JOIN schools s ON s.id=f.school_id JOIN users u ON u.id=f.authorized_by ORDER BY f.authorized_at DESC LIMIT 20`)).rows;
        const events = (await c.query(`SELECT failover_id,event,actor,detail,at FROM eden_failover_events ORDER BY at DESC LIMIT 40`)).rows;
        const inbound = (await c.query(`SELECT l.node_id,l.kind,l.decision,l.reason,l.bytes,l.received_at FROM eden_inbound_log l ORDER BY l.received_at DESC LIMIT 40`)).rows;
        const tokens = (await c.query(`SELECT t.id,t.school_id,s.name AS school_name,t.name,t.created_at,t.expires_at,t.used_at,t.node_id FROM eden_enrollment_tokens t JOIN schools s ON s.id=t.school_id ORDER BY t.created_at DESC LIMIT 20`)).rows;
        const bundles = (await c.query(`SELECT kind,version,signer_kind,sha256,bytes,published_at FROM eden_bundles ORDER BY published_at DESC LIMIT 20`)).rows;
        const schools = (await c.query(`SELECT id,name FROM schools ORDER BY name`)).rows;
        return { nodes: nodes.map(n => ({ ...n, online: online(n) })), failovers, events, inbound, tokens, bundles, schools };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { ...data, hub: { ...status, districtCertExpires: id?.cert?.notAfter || null, rootFingerprint: id ? sha256(canonical(id.root)).slice(0, 16) : null,
        offlineAfterSeconds: config.edenNodeOfflineAfterMs / 1000, failoverMaxHours: config.edenFailoverMaxHours, consentExceptions: config.edenConsentExceptions } } });
    } catch (e) { next(e); }
  });
  app.get("/api/eden/admin/aggregates", ...adminRead, async (req, res, next) => {
    const kind = typeof req.query.kind === "string" && /^[a-z_]{3,40}$/.test(req.query.kind) ? req.query.kind : null;
    try {
      const rows = await withTenantTransaction(req.actor, async c => (await c.query(`SELECT a.node_id,a.school_id,s.name AS school_name,a.kind,a.period,a.seq,a.payload,a.received_at
        FROM eden_aggregates a JOIN schools s ON s.id=a.school_id WHERE ($1::text IS NULL OR a.kind=$1) ORDER BY a.received_at DESC LIMIT 100`, [kind])).rows);
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: rows });
    } catch (e) { next(e); }
  });
  app.post("/api/eden/admin/enrollment-tokens", ...adminWrite, ready, async (req, res, next) => {
    const { schoolId, name } = req.body || {};
    if (!UUID.test(String(schoolId)) || typeof name !== "string" || !name.trim() || name.length > 80) return err(res, 400, "invalid_token_request");
    try {
      const token = `eden_${crypto.randomBytes(24).toString("base64url")}`;
      const row = await withTenantTransaction(req.actor, async c => {
        const s = (await c.query(`SELECT id FROM schools WHERE id=$1`, [schoolId])).rows[0];
        if (!s) return null;
        const t = (await c.query(`INSERT INTO eden_enrollment_tokens(district_id,school_id,name,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '24 hours') RETURNING id,expires_at`,
          [req.actor.districtId, schoolId, name.trim(), sha256(token), req.actor.userId])).rows[0];
        await audit(c, req.actor, "eden_enrollment_token", "eden_enrollment_token", t.id, `school=${schoolId}`);
        return t;
      });
      if (!row) return err(res, 404, "school_not_found");
      res.status(201).json({ data: { id: row.id, token, expiresAt: row.expires_at, note: "Shown once. Give it to the school node installer (EDEN_ENROLLMENT_TOKEN)." } });
    } catch (e) { next(e); }
  });
  app.post("/api/eden/admin/nodes/:id/partner", ...adminWrite, async (req, res, next) => {
    const partner = req.body?.partnerNodeId ?? null;
    if (!UUID.test(req.params.id) || (partner !== null && !UUID.test(String(partner))) || partner === req.params.id) return err(res, 400, "invalid_partner");
    try {
      const ok = await withTenantTransaction(req.actor, async c => {
        if (partner && !(await c.query(`SELECT 1 FROM eden_nodes WHERE id=$1 AND status='active'`, [partner])).rowCount) return false;
        const r = await c.query(`UPDATE eden_nodes SET partner_node_id=$2 WHERE id=$1 AND status='active'`, [req.params.id, partner]);
        if (r.rowCount) await audit(c, req.actor, "eden_partner", "eden_node", req.params.id, `partner=${partner}`);
        return r.rowCount > 0;
      });
      ok ? res.json({ data: { ok: true } }) : err(res, 404, "node_not_found");
    } catch (e) { next(e); }
  });
  app.post("/api/eden/admin/nodes/:id/revoke", ...adminWrite, async (req, res, next) => {
    const reason = String(req.body?.reason || "").trim();
    if (!UUID.test(req.params.id) || reason.length < 5 || reason.length > 300) return err(res, 400, "reason_required");
    try {
      const ok = await withTenantTransaction(req.actor, async c => {
        const r = await c.query(`UPDATE eden_nodes SET status='revoked', revoked_at=now(), revoked_by=$2, revoke_reason=$3, partner_node_id=NULL WHERE id=$1 AND status='active'`, [req.params.id, req.actor.userId, reason]);
        await c.query(`UPDATE eden_nodes SET partner_node_id=NULL WHERE partner_node_id=$1`, [req.params.id]);
        if (r.rowCount) await audit(c, req.actor, "eden_revoke", "eden_node", req.params.id, reason);
        return r.rowCount > 0;
      });
      ok ? res.json({ data: { ok: true } }) : err(res, 404, "node_not_found");
    } catch (e) { next(e); }
  });
  // Explicit district authorization: a superintendent, with a reason, for a
  // node that is OFFLINE, to its assigned partner, for at most N hours.
  app.post("/api/eden/admin/failovers", requireSession, requireCsrf, requirePermission("eden", "authorize"), ready, async (req, res, next) => {
    const { failedNodeId, reason } = req.body || {};
    const hours = Number(req.body?.hours || 8);
    if (!UUID.test(String(failedNodeId)) || typeof reason !== "string" || reason.trim().length < 10 || reason.length > 300) return err(res, 400, "reason_required", { min: 10 });
    if (!Number.isFinite(hours) || hours < 0.01 || hours > config.edenFailoverMaxHours) return err(res, 400, "invalid_duration", { maxHours: config.edenFailoverMaxHours });
    try {
      const out = await withTenantTransaction(req.actor, async c => {
        const n = (await c.query(`SELECT * FROM eden_nodes WHERE id=$1`, [failedNodeId])).rows[0];
        if (!n || n.status !== "active") return { status: 404, error: "node_not_found" };
        if (online(n)) return { status: 409, error: "node_is_online", detail: "Failover is only for a node that has stopped reporting (prevents two nodes serving one school)." };
        if (!n.partner_node_id) return { status: 409, error: "no_partner_assigned" };
        const p = (await c.query(`SELECT * FROM eden_nodes WHERE id=$1`, [n.partner_node_id])).rows[0];
        if (!p || p.status !== "active" || !online(p)) return { status: 409, error: "partner_not_online" };
        const pkg = (await c.query(`SELECT sha256,uploaded_at,counts FROM eden_continuity_packages WHERE node_id=$1 AND partner_node_id=$2`, [n.id, p.id])).rows[0];
        if (!pkg) return { status: 409, error: "no_continuity_package" };
        const f = (await c.query(`INSERT INTO eden_failovers(district_id,school_id,failed_node_id,partner_node_id,reason,authorized_by,expires_at,package_sha256)
          VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(secs => $7),$8) RETURNING id,expires_at`,
          [req.actor.districtId, n.school_id, n.id, p.id, reason.trim(), req.actor.userId, Math.round(hours * 3600), pkg.sha256])).rows[0];
        await failoverEvent(c, f.id, "authorized", `user:${req.actor.userId}`, { hours, reason: reason.trim().slice(0, 200), packageAt: pkg.uploaded_at, counts: pkg.counts });
        await audit(c, req.actor, "eden_failover_authorize", "eden_failover", f.id, `failed=${n.id};partner=${p.id};hours=${hours}`);
        return { status: 201, body: { id: f.id, expiresAt: f.expires_at, partnerNodeId: p.id } };
      });
      if (out.error) return err(res, out.status, out.error, out.detail ? { detail: out.detail } : {});
      res.status(201).json({ data: out.body });
    } catch (e) {
      if (e.code === "23505") return err(res, 409, "failover_already_open");
      next(e);
    }
  });
  app.post("/api/eden/admin/failovers/:id/end", ...adminWrite, async (req, res, next) => {
    if (!UUID.test(req.params.id)) return err(res, 400, "invalid_id");
    try {
      const ok = await withTenantTransaction(req.actor, async c => {
        const f = (await c.query(`SELECT * FROM eden_failovers WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
        if (!f || !["authorized", "active"].includes(f.status)) return false;
        if (f.status === "authorized") await c.query(`UPDATE eden_failovers SET status='cancelled', closed_at=now(), ended_by=$2 WHERE id=$1`, [f.id, req.actor.userId]);
        else await c.query(`UPDATE eden_failovers SET status='handing_back', handback_reason='ended_by_district', handback_started_at=now(), ended_by=$2 WHERE id=$1`, [f.id, req.actor.userId]);
        await failoverEvent(c, f.id, f.status === "authorized" ? "cancelled" : "ended_early", `user:${req.actor.userId}`, {});
        await audit(c, req.actor, "eden_failover_end", "eden_failover", f.id, null);
        return true;
      });
      ok ? res.json({ data: { ok: true } }) : err(res, 409, "failover_not_open");
    } catch (e) { next(e); }
  });
  // Publish a district-signed bundle built from the district's own catalog.
  app.post("/api/eden/admin/bundles/publish", ...adminWrite, ready, async (req, res, next) => {
    const kind = req.body?.kind;
    if (!["catalog", "branding", "lessons", "content"].includes(kind)) return err(res, 400, "invalid_kind");
    try {
      const out = await withTenantTransaction(req.actor, async c => {
        const payload = await buildBundlePayload(c, kind);
        const v = (await c.query(`SELECT coalesce(max(version),0)+1 AS v FROM eden_bundles WHERE kind=$1`, [kind])).rows[0].v;
        const bundle = signBundle({ kind, version: Number(v), payload, signerCert: id.cert, signPrivate: id.signPrivate });
        const text = canonical(bundle);
        await c.query(`INSERT INTO eden_bundles(district_id,kind,version,signer_kind,sha256,bytes,bundle,published_by) VALUES($1,$2,$3,'district',$4,$5,$6,$7)`,
          [req.actor.districtId, kind, Number(v), sha256(text), Buffer.byteLength(text), text, req.actor.userId]);
        await audit(c, req.actor, "eden_bundle_publish", "eden_bundle", `${kind}:${v}`, `bytes=${Buffer.byteLength(text)}`);
        return { kind, version: Number(v), bytes: Buffer.byteLength(text), items: Object.values(payload).reduce((n, x) => n + (Array.isArray(x) ? x.length : 0), 0) };
      });
      res.status(201).json({ data: out });
    } catch (e) { next(e); }
  });
  // Import a ROOT-signed bundle (e.g. state standards) and relay it to nodes.
  app.post("/api/eden/admin/bundles/import", ...adminWrite, ready, async (req, res, next) => {
    const bundle = req.body?.bundle;
    try {
      const out = await withTenantTransaction(req.actor, async c => {
        const cur = (await c.query(`SELECT coalesce(max(version),0) AS v FROM eden_bundles WHERE kind=$1`, [String(bundle?.kind)])).rows[0];
        const v = verifyBundle(bundle, { root: id.root, chain: [id.cert], minVersion: Number(cur.v) });
        if (!v.ok) return { status: 400, error: v.reason };
        if (v.signer.kind !== "root") return { status: 400, error: "not_root_signed" };
        const text = canonical(bundle);
        await c.query(`INSERT INTO eden_bundles(district_id,kind,version,signer_kind,sha256,bytes,bundle,published_by) VALUES($1,$2,$3,'root',$4,$5,$6,$7)`,
          [req.actor.districtId, bundle.kind, bundle.version, sha256(text), Buffer.byteLength(text), text, req.actor.userId]);
        await audit(c, req.actor, "eden_bundle_import", "eden_bundle", `${bundle.kind}:${bundle.version}`, "root-signed");
        return { status: 201, body: { kind: bundle.kind, version: bundle.version } };
      });
      if (out.error) return err(res, out.status, out.error);
      res.status(201).json({ data: out.body });
    } catch (e) { next(e); }
  });
  return status;
}

/** District content that every node caches (no student data in any of it). */
export async function buildBundlePayload(c, kind) {
  if (kind === "catalog") {
    const apps = (await c.query(`SELECT id,name,vendor,description,category,launch_url,integration_type,data_sharing_scope,dpa_status,dpa_expires_on,coppa_compliant,ferpa_school_official,owner_school_id
      FROM apps WHERE status='active' ORDER BY name`)).rows;
    const licenses = (await c.query(`SELECT id,app_id,purchased_by_school_id,seat_limit,starts_on,ends_on FROM app_licenses WHERE status='active' ORDER BY id`)).rows;
    return { apps, licenses };
  }
  if (kind === "branding") {
    const profiles = (await c.query(`SELECT school_id,version,mascot_name,motto,primary_color,secondary_color,accent_color,font,tiles FROM branding_profiles WHERE status='published' ORDER BY school_id NULLS FIRST`)).rows;
    return { profiles };
  }
  if (kind === "lessons") {
    const lessons = (await c.query(`SELECT l.id,l.title,l.objective,l.content,c.subject,c.grade_level FROM lessons l JOIN courses c ON c.id=l.course_id
      WHERE l.status='published' AND l.approved_at IS NOT NULL ORDER BY c.subject,l.title`)).rows;
    return { lessons };
  }
  const standards = (await c.query(`SELECT framework,code,subject,grade_level,description,source_url FROM learning_standards ORDER BY code`)).rows;
  const sources = (await c.query(`SELECT id,title,creator,created_date,media_kind,archive,archive_url,rights,description FROM primary_sources WHERE status='approved' ORDER BY title`)).rows;
  return { standards, sources };
}

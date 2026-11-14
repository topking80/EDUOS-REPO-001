// EduOS 32.6.0 EDAL ledger API. Leaders verify the district chain and save
// checkpoints; learners, families and teachers can check the proof of a
// record they are already allowed to see. Nothing is sent anywhere: external
// anchoring is a documented plan (docs/UPGRADING-32.6.0.md), off by default.
import { requireSession, requireCsrf } from "./auth.js";
import { requirePermission } from "./policy.js";
import { withTenantTransaction } from "./db.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { verifyChain, checkpointHolds, verifyRecord, GENESIS } from "./edal.js";

const PAGE = 5000;
export async function readChain(client) {
  const all = [];
  for (let after = 0; ; ) {
    const page = await rows(client, `SELECT * FROM eduos_edal_chain($1,$2)`, [after, PAGE]);
    all.push(...page);
    if (page.length < PAGE) break;
    after = Number(page.at(-1).seq);
    if (all.length > 1_000_000) throw new HttpError(413, "chain_too_long_for_online_verify");
  }
  return all;
}
const run = fn => async (req, res, next) => {
  try { const data = await withTenantTransaction(req.actor, c => fn(c, req)); res.setHeader("Cache-Control", "no-store"); res.status(data?.__status || 200).json({ data: data?.__status ? data.data : data }); }
  catch (e) { sendError(res, next, e); }
};
const STATEMENT = "Tamper-evident hash chain stored in the EduOS database. It is not a blockchain and is not anchored externally yet; keep checkpoints outside EduOS to detect a full rewrite.";

export function registerEdalRoutes(app) {
  app.get("/api/edal/verify", requireSession, requirePermission("edal", "verify"), run(async (client, req) => {
    const head = await one(client, `SELECT * FROM eduos_edal_head_info()`);
    const chain = await readChain(client);
    const result = verifyChain(req.actor.districtId, chain, head || { seq: 0, head_hash: GENESIS });
    const cps = await rows(client, `SELECT id,seq,head_hash,note,anchor_kind,created_at FROM edal_checkpoints ORDER BY seq DESC, created_at DESC LIMIT 20`);
    const checkpoints = cps.map(c => ({ id: c.id, seq: Number(c.seq), headHash: c.head_hash, note: c.note, anchor: c.anchor_kind, createdAt: c.created_at, holds: checkpointHolds(chain, c) }));
    const byKind = chain.reduce((m, r) => ((m[r.kind] = (m[r.kind] || 0) + 1), m), {});
    await audit(client, req, "verify", "edal_chain", null, `ok=${result.ok && checkpoints.every(c => c.holds)};entries=${result.entries}`);
    return { ...result, ok: result.ok && checkpoints.every(c => c.holds), byKind, checkpoints, verifiedAt: new Date().toISOString(), statement: STATEMENT };
  }));

  app.get("/api/edal/checkpoints", requireSession, requirePermission("edal", "verify"), run(async client =>
    (await rows(client, `SELECT id,seq,head_hash,note,anchor_kind,created_at FROM edal_checkpoints ORDER BY created_at DESC LIMIT 50`))
      .map(c => ({ id: c.id, seq: Number(c.seq), headHash: c.head_hash, note: c.note, anchor: c.anchor_kind, createdAt: c.created_at }))));

  // Save the current head. Copy the returned JSON somewhere outside EduOS (or
  // print it); the CLI and the verify endpoint check that it still holds.
  app.post("/api/edal/checkpoints", requireSession, requireCsrf, requirePermission("edal", "checkpoint"), run(async (client, req) => {
    const note = req.body?.note ?? null;
    if (note !== null && !cleanText(note, 300)) throw new HttpError(400, "invalid_note");
    const chain = await readChain(client);
    const head = await one(client, `SELECT * FROM eduos_edal_head_info()`) || { seq: 0, head_hash: GENESIS };
    const v = verifyChain(req.actor.districtId, chain, head);
    if (!v.ok) throw new HttpError(409, "chain_does_not_verify", { problems: v.problems });
    const c = await one(client, `INSERT INTO edal_checkpoints(district_id,seq,head_hash,note,created_by) VALUES($1,$2,$3,$4,$5) RETURNING id,seq,head_hash,created_at`,
      [req.actor.districtId, v.headSeq, v.headHash, note, req.actor.userId]);
    await audit(client, req, "checkpoint", "edal_chain", c.id, `seq=${c.seq}`);
    return { __status: 201, data: { id: c.id, districtId: req.actor.districtId, seq: Number(c.seq), headHash: c.head_hash, createdAt: c.created_at, anchor: "none",
      keepThis: "Store this JSON outside EduOS (printed, emailed to an auditor by a person, or in another system). npm run edal:verify -- --checkpoint <file> checks it." } };
  }));

  // Hash-only export for offline verification (no payloads, so no learner data).
  app.get("/api/edal/export", requireSession, requirePermission("edal", "verify"), run(async (client, req) => {
    // District-wide (opaque learner ids included): district roles only.
    if (!["superintendent", "it_admin"].includes(req.actor.role)) throw new HttpError(403, "district_role_required");
    const chain = await readChain(client);
    const head = await one(client, `SELECT * FROM eduos_edal_head_info()`) || { seq: 0, head_hash: GENESIS };
    await audit(client, req, "export", "edal_chain", null, `entries=${chain.length}`);
    return { format: "EDAL1-chain", districtId: req.actor.districtId, head: { seq: Number(head.seq), headHash: head.head_hash },
      entries: chain.map(({ payload_state, ...r }) => ({ ...r, seq: Number(r.seq), payload_state })) };
  }));

  // Proof for one record (final grade, credential, milestone) the caller may already see.
  app.get("/api/edal/records/:id", requireSession, requirePermission("edal", "proof"), run(async (client, req) => {
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_entry_id");
    const e = await one(client, `SELECT id,seq,kind,school_id,subject_student_id,payload_hash,prev_hash,entry_hash,recorded_at FROM edal_entries WHERE id=$1`, [req.params.id]);
    if (!e) throw new HttpError(404, "record_not_found");
    const p = await one(client, `SELECT payload FROM edal_payloads WHERE entry_id=$1`, [e.id]);
    const n = await one(client, `SELECT * FROM eduos_edal_neighbors($1)`, [e.id]);
    const proof = verifyRecord(req.actor.districtId, e, p?.payload ?? null, n);
    await audit(client, req, "read", "edal_record", e.id, `ok=${proof.ok}`);
    return { entry: { ...e, seq: Number(e.seq) }, payload: p ? JSON.parse(p.payload) : null, headSeq: n ? Number(n.head_seq) : null, ...proof,
      statement: STATEMENT };
  }));
}

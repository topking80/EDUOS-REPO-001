// EduOS 32.6.0 EDAL ledger, step 1 (shared by the API and scripts/edal.js).
// A per-district, append-only hash chain in PostgreSQL. Each entry commits to
// its payload (sha256 of canonical JSON) and to the previous entry's hash, so
// changing, removing or reordering any entry breaks every later link. That is
// tamper-EVIDENT, not tamper-proof: someone who controls the database could
// rewrite the whole chain, which is why leaders keep checkpoints (the head
// hash at a moment) outside EduOS. It is not a blockchain: there is one
// writer, no consensus and no public network. External anchoring (e.g. an
// RFC 3161 timestamp of each checkpoint) is planned, not built.
import { createHash } from "node:crypto";

export const VERSION = "EDAL1";
export const GENESIS = "0".repeat(64);
export const KINDS = ["final_grade", "credential", "credential_revoked", "mastery_milestone"];
export const sha256 = s => createHash("sha256").update(String(s), "utf8").digest("hex");

/** Deterministic JSON: sorted keys, no whitespace, no undefined. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number in EDAL payload");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}
export function entryHash(e) {
  return sha256([VERSION, e.district_id, String(e.seq), e.kind, e.school_id || "", e.subject_student_id || "", e.payload_hash, e.prev_hash, e.recorded_at].join("|"));
}

/**
 * Verify a chain read in seq order (rows from eduos_edal_chain or the table).
 * Each row: {seq, kind, school_id, subject_student_id, payload_hash, prev_hash, entry_hash, recorded_at, payload_state?}
 * -> {ok, entries, headSeq, headHash, erased, problems:[{seq, problem}]}
 */
export function verifyChain(districtId, rows, head = null) {
  const problems = [];
  let prev = GENESIS, expectSeq = 1, erased = 0;
  for (const r of rows) {
    const seq = Number(r.seq);
    if (seq !== expectSeq) problems.push({ seq, problem: `sequence gap: expected ${expectSeq}` });
    if (r.prev_hash !== prev) problems.push({ seq, problem: "previous-hash link broken" });
    if (entryHash({ ...r, district_id: districtId, seq }) !== r.entry_hash) problems.push({ seq, problem: "entry hash does not match its contents" });
    if (r.payload_state === "mismatch") problems.push({ seq, problem: "stored payload does not match its hash" });
    if (r.payload_state === "erased") erased++;
    prev = r.entry_hash; expectSeq = seq + 1;
  }
  const last = rows.at(-1);
  if (head && Number(head.seq) !== (last ? Number(last.seq) : 0)) problems.push({ seq: Number(head.seq), problem: "chain head sequence does not match the last entry" });
  if (head && head.head_hash !== (last ? last.entry_hash : GENESIS)) problems.push({ seq: Number(head.seq), problem: "chain head hash does not match the last entry" });
  return { ok: problems.length === 0, entries: rows.length, headSeq: last ? Number(last.seq) : 0, headHash: last ? last.entry_hash : GENESIS, erased, problems: problems.slice(0, 50) };
}
/** Is a saved checkpoint still part of the chain? */
export function checkpointHolds(rows, checkpoint) {
  if (!checkpoint || Number(checkpoint.seq) === 0) return checkpoint?.headHash === GENESIS || checkpoint?.head_hash === GENESIS;
  const r = rows.find(x => Number(x.seq) === Number(checkpoint.seq));
  return Boolean(r) && r.entry_hash === (checkpoint.headHash || checkpoint.head_hash);
}

/**
 * Append inside the caller's tenant transaction. The head row is locked, so
 * concurrent appends in one district serialize; a trigger re-checks the link.
 */
export async function appendEntry(client, actor, { kind, schoolId = null, studentId = null, payload }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown EDAL kind ${kind}`);
  const head = (await client.query("SELECT seq, head_hash FROM eduos_edal_head()")).rows[0];
  const text = canonicalJson({ v: 1, kind, ...payload });
  const e = { district_id: actor.districtId, seq: Number(head.seq) + 1, kind, school_id: schoolId, subject_student_id: studentId,
    payload_hash: sha256(text), prev_hash: head.head_hash, recorded_at: new Date().toISOString() };
  e.entry_hash = entryHash(e);
  const row = (await client.query(`INSERT INTO edal_entries(district_id,seq,kind,school_id,subject_student_id,payload_hash,prev_hash,entry_hash,recorded_at,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,seq,entry_hash`,
    [e.district_id, e.seq, kind, schoolId, studentId, e.payload_hash, e.prev_hash, e.entry_hash, e.recorded_at, actor.userId])).rows[0];
  await client.query("INSERT INTO edal_payloads(entry_id,district_id,payload) VALUES($1,$2,$3)", [row.id, actor.districtId, text]);
  return { id: row.id, seq: Number(row.seq), entryHash: row.entry_hash, payloadHash: e.payload_hash };
}

/** Check one record: its own hash, its payload, and both links (from eduos_edal_neighbors). */
export function verifyRecord(districtId, entry, payloadText, neighbors) {
  const checks = [];
  checks.push(["entry hash matches contents", entryHash({ ...entry, district_id: districtId, seq: Number(entry.seq) }) === entry.entry_hash]);
  if (payloadText != null) checks.push(["payload matches its hash", sha256(payloadText) === entry.payload_hash]);
  checks.push(["links to the previous entry", neighbors?.prev_entry_hash === entry.prev_hash]);
  if (neighbors?.next_prev_hash != null) checks.push(["the next entry links to it", neighbors.next_prev_hash === entry.entry_hash]);
  return { ok: checks.every(c => c[1]), checks: checks.map(([check, ok]) => ({ check, ok })), erased: payloadText == null };
}

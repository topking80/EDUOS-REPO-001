// EduOS 32.7.0: THE egress point of a school node. Every byte a node sends up
// the EDEN tree leaves through this module (a static test enforces that no
// other file writes eden_outbox or calls the hub):
//   * aggregates  - only aggregation-gate output, checked when queued AND
//                   re-checked (with a fresh identifier block-list) at send;
//   * control     - heartbeat / acknowledgements with a fixed, people-free schema;
//   * sealed      - DECN packages encrypted to ONE partner node (the district
//                   relays ciphertext it cannot open), logged with counts only.
// Every decision (queued, sent, blocked, sealed) is written to the
// append-only eden_egress_log, which the node's admin screen shows.
import { verifyReleased, buildIdentifierIndex, GateError } from "./aggregation-gate.js";
import { canonical, sha256 } from "./crypto.js";
import { hubRequest, withSystem } from "./runtime.js";

const BATCH = 50;

export async function loadIdentifiers(client, schoolId) {
  const { rows: [r] } = await client.query("SELECT eduos_eden_identifiers($1) AS x", [schoolId]);
  return buildIdentifierIndex(r.x || {});
}
function cellStats(p) {
  if (!Array.isArray(p?.cells)) return { cells: null, suppressed: null };
  return { cells: p.cells.length, suppressed: p.cells.filter(c => c.count === null).length };
}
async function log(client, row) {
  await client.query(
    `INSERT INTO eden_egress_log(district_id,destination,kind,period,decision,reason,cells,cells_suppressed,bytes,sha256,outbox_id,actor_user_id)
     VALUES(eduos_ctx_district(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [row.destination || "district", row.kind, row.period ?? null, row.decision, row.reason ?? null, row.cells ?? null, row.suppressed ?? null,
      row.bytes ?? null, row.sha256 ?? null, row.outboxId ?? null, row.actorUserId ?? null]);
}
export const logBlocked = (client, { kind, period, reason, actorUserId }) =>
  log(client, { kind: String(kind || "unknown").slice(0, 40), period, decision: "blocked", reason: String(reason).slice(0, 200), actorUserId });

/** Queue gate output for the district. Throws GateError (and logs) if it is not. */
export async function queueRelease(client, payload, { identifiers, schoolId, actorUserId = null, consent = false }) {
  try { verifyReleased(payload, { identifiers, schoolId }); }
  catch (e) { await logBlocked(client, { kind: payload?.kind, period: payload?.period, reason: e.code || "invalid", actorUserId }); throw e; }
  if (payload.kind === "consented_record_transfer" && !consent) {
    await logBlocked(client, { kind: payload.kind, period: payload.period, reason: "consent_exceptions_disabled", actorUserId });
    throw new GateError("consent_exceptions_disabled");
  }
  const text = canonical(payload), hash = sha256(text);
  // An unchanged aggregate is not queued again; a changed one supersedes the pending copy.
  const same = await client.query(`SELECT id FROM eden_outbox WHERE kind=$1 AND period=$2 AND sha256=$3 AND superseded_at IS NULL ORDER BY seq DESC LIMIT 1`, [payload.kind, payload.period, hash]);
  if (same.rowCount && payload.kind !== "consented_record_transfer") return { id: same.rows[0].id, unchanged: true };
  if (payload.kind !== "consented_record_transfer")
    await client.query(`UPDATE eden_outbox SET superseded_at=now() WHERE kind=$1 AND period=$2 AND sent_at IS NULL AND superseded_at IS NULL`, [payload.kind, payload.period]);
  const { rows: [o] } = await client.query(
    `INSERT INTO eden_outbox(district_id,kind,period,payload,sha256) VALUES(eduos_ctx_district(),$1,$2,$3,$4) RETURNING id,seq`,
    [payload.kind, payload.period, text, hash]);
  const st = cellStats(payload);
  await log(client, { kind: payload.kind, period: payload.period, decision: payload.kind === "consented_record_transfer" ? "consent_exception" : "queued",
    cells: st.cells, suppressed: st.suppressed, bytes: Buffer.byteLength(text), sha256: hash, outboxId: o.id, actorUserId });
  return { id: o.id, seq: Number(o.seq) };
}

/**
 * Send pending outbox rows. Each payload is re-verified against a FRESH
 * identifier list right before it leaves (a learner enrolled after it was
 * queued is still protected). Returns { sent, blocked, pending, error }.
 */
export async function flushOutbox(identity, { districtId, schoolId }) {
  const pending = await withSystem("eden_agent", districtId, schoolId, async client => {
    const ids = await loadIdentifiers(client, schoolId);
    const { rows } = await client.query(`SELECT id,seq,kind,period,payload,sha256 FROM eden_outbox WHERE sent_at IS NULL AND superseded_at IS NULL ORDER BY seq LIMIT ${BATCH}`);
    const ok = [];
    for (const r of rows) {
      try {
        if (sha256(canonical(r.payload)) !== r.sha256) throw new GateError("outbox_tampered");
        verifyReleased(r.payload, { identifiers: ids, schoolId });
        if (r.kind === "consented_record_transfer") {
          const ex = await client.query(`SELECT 1 FROM eden_consent_exceptions WHERE id=$1 AND status='used'`, [r.payload.exceptionId]);
          if (!ex.rowCount) throw new GateError("consent_exception_not_recorded");
        }
        ok.push(r);
      } catch (e) {
        await client.query(`UPDATE eden_outbox SET superseded_at=now(), last_error=$2 WHERE id=$1`, [r.id, `blocked: ${e.code || "invalid"}`]);
        await logBlocked(client, { kind: r.kind, period: r.period, reason: `at_send: ${e.code || "invalid"}` });
      }
    }
    return ok;
  });
  if (!pending.length) return { sent: 0, blocked: 0, pending: 0 };
  const messages = pending.map(r => ({ id: r.id, seq: Number(r.seq), kind: r.kind, period: r.period, payload: r.payload }));
  let res;
  try { res = await hubRequest(identity, "POST", "/api/eden/v1/messages", { messages }); }
  catch (e) {
    await withSystem("eden_agent", districtId, schoolId, c => c.query(`UPDATE eden_outbox SET attempts=attempts+1, last_error=$2 WHERE id=ANY($1::uuid[])`,
      [pending.map(r => r.id), String(e.cause?.code || e.name || "network").slice(0, 200)]));
    return { sent: 0, blocked: 0, pending: pending.length, error: "uplink_unreachable" };
  }
  if (res.status !== 200 || !res.body) {
    await withSystem("eden_agent", districtId, schoolId, c => c.query(`UPDATE eden_outbox SET attempts=attempts+1, last_error=$2 WHERE id=ANY($1::uuid[])`,
      [pending.map(r => r.id), `hub_http_${res.status}`]));
    return { sent: 0, blocked: 0, pending: pending.length, error: `hub_http_${res.status}` };
  }
  const accepted = new Set(res.body.accepted || []);
  const rejected = new Map((res.body.rejected || []).map(x => [x.id, x.reason]));
  let sent = 0, blocked = 0;
  await withSystem("eden_agent", districtId, schoolId, async client => {
    for (const r of pending) {
      const bytes = Buffer.byteLength(canonical(r.payload)), st = cellStats(r.payload);
      if (accepted.has(r.id)) {
        await client.query(`UPDATE eden_outbox SET sent_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1`, [r.id]);
        await log(client, { kind: r.kind, period: r.period, decision: "sent", cells: st.cells, suppressed: st.suppressed, bytes, sha256: r.sha256, outboxId: r.id });
        sent++;
      } else if (rejected.has(r.id)) {
        await client.query(`UPDATE eden_outbox SET superseded_at=now(), last_error=$2 WHERE id=$1`, [r.id, `hub_rejected: ${String(rejected.get(r.id)).slice(0, 150)}`]);
        await logBlocked(client, { kind: r.kind, period: r.period, reason: `hub_rejected: ${rejected.get(r.id)}` });
        blocked++;
      }
    }
  });
  return { sent, blocked, pending: pending.length - sent - blocked };
}

// ---- control messages: fixed schema, no people -----------------------------
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, HEX = /^[0-9a-f]{64}$/;
const COUNTS = v => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length <= 40 &&
  Object.entries(v).every(([k, n]) => /^[a-z_]{1,40}$/.test(k) && Number.isInteger(n) && n >= 0 && n < 1e8);
const CONTROL = {
  heartbeat: b => VERSION.test(b.version) && typeof b.arch === "string" && /^[a-z0-9_]{1,20}$/.test(b.arch) &&
    b.bundles && Object.entries(b.bundles).every(([k, v]) => /^[a-z]{3,20}$/.test(k) && Number.isInteger(v)) &&
    (b.continuitySha256 === null || HEX.test(b.continuitySha256)) && Array.isArray(b.hosting) && b.hosting.every(x => UUID.test(x)) &&
    Number.isInteger(b.outboxPending) && Object.keys(b).every(k => ["version", "arch", "bundles", "continuitySha256", "hosting", "outboxPending"].includes(k)),
  activated: b => COUNTS(b.counts) && Object.keys(b).every(k => k === "counts"),
  purged: b => COUNTS(b.counts) && Object.keys(b).every(k => k === "counts"),
  imported: b => COUNTS(b.counts) && Object.keys(b).every(k => k === "counts")
};
/** Send a control message (heartbeat or a DECN acknowledgement). */
export async function sendControl(identity, kind, apiPath, body) {
  if (!CONTROL[kind] || !CONTROL[kind](body || {})) throw new GateError("control_message_invalid", kind);
  return hubRequest(identity, "POST", apiPath, body);
}
/** Download (GET, empty body) from the hub: bundles, sealed packages. */
export function download(identity, apiPath) { return hubRequest(identity, "GET", apiPath); }

/**
 * Upload a sealed DECN package (continuity -> partner, or return -> origin).
 * The envelope is ciphertext; only its metadata and record COUNTS are logged.
 */
export async function sendSealed(identity, { districtId, schoolId, kind, apiPath, envelope, counts, partnerNodeId }) {
  if (!["decn_continuity", "decn_return"].includes(kind)) throw new GateError("sealed_kind_not_allowed");
  if (!envelope || envelope.v !== "EDEN-SEAL-1" || !envelope.ct || !envelope.sig) throw new GateError("not_sealed");
  if (!COUNTS(counts)) throw new GateError("counts_invalid");
  const body = kind === "decn_continuity" ? { partnerNodeId, envelope, counts } : { envelope, counts };
  const text = canonical(body), hash = sha256(canonical(envelope));
  let res;
  try { res = await hubRequest(identity, "PUT", apiPath, body); }
  catch (e) { return { status: 0, error: "uplink_unreachable" }; }
  await withSystem("eden_agent", districtId, schoolId, client => log(client, { destination: "partner_sealed", kind, period: null,
    decision: res.status === 200 ? "sealed_package" : "blocked", reason: res.status === 200 ? `counts ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ").slice(0, 180)}` : `hub_http_${res.status}`,
    bytes: Buffer.byteLength(text), sha256: hash }));
  return res;
}

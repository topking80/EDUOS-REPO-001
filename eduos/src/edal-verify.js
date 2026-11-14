#!/usr/bin/env node
// EduOS 32.6.0 EDAL verifier (CLI).
//
//   Against the database (run as the migration OWNER, like db:retention):
//     DATABASE_URL=postgres://eduos_owner:...@db/eduos npm run edal:verify
//     make edal-verify
//   Offline, against an export from GET /api/edal/export (no database needed):
//     node src/edal-verify.js --file chain.json
//   Options:
//     --district <uuid>        only this district
//     --checkpoint <file|json> also check a saved checkpoint {districtId, seq, headHash}
//     --json                   machine-readable output
// Exit code 0 = every chain verifies (and the checkpoint holds), 1 = a problem
// was found, 2 = usage or connection error. It reads only hashes; it never
// prints payloads (which hold learner data) and makes no network calls other
// than to the database.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyChain, checkpointHolds, GENESIS } from "./edal.js";

export function parseArgs(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--file") o.file = argv[++i];
    else if (a === "--district") o.district = argv[++i];
    else if (a === "--checkpoint") o.checkpoint = argv[++i];
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}
export function loadCheckpoint(arg) {
  if (!arg) return null;
  const text = existsSync(arg) ? readFileSync(arg, "utf8") : arg;
  const c = JSON.parse(text);
  const cp = c.data ?? c;
  if (!/^[0-9a-f]{64}$/.test(cp.headHash || "") || !Number.isInteger(Number(cp.seq))) throw new Error("checkpoint needs seq and headHash");
  return cp;
}
export function verifyExport(doc, checkpoint = null) {
  const d = doc.data ?? doc;
  if (d.format !== "EDAL1-chain") throw new Error("not an EDAL1 chain export");
  const r = verifyChain(d.districtId, d.entries, { seq: d.head.seq, head_hash: d.head.headHash });
  if (checkpoint && (!checkpoint.districtId || checkpoint.districtId === d.districtId)) {
    r.checkpoint = checkpointHolds(d.entries, checkpoint);
    if (!r.checkpoint) { r.ok = false; r.problems.push({ seq: Number(checkpoint.seq), problem: "saved checkpoint is no longer part of this chain" }); }
  }
  return [{ districtId: d.districtId, ...r }];
}

async function verifyDatabase(opts, checkpoint) {
  const { pool } = await import("./db.js");
  const out = [];
  try {
    const districts = (await pool.query(`SELECT id FROM districts ${opts.district ? "WHERE id=$1" : ""} ORDER BY id`, opts.district ? [opts.district] : [])).rows;
    for (const { id } of districts) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT set_config('app.district_id',$1,true)", [id]);
        const head = (await client.query(`SELECT seq, head_hash FROM edal_heads WHERE district_id=$1`, [id])).rows[0] || { seq: 0, head_hash: GENESIS };
        const chain = (await client.query(`SELECT e.seq,e.kind,e.school_id,e.subject_student_id,e.payload_hash,e.prev_hash,e.entry_hash,e.recorded_at,
            CASE WHEN p.entry_id IS NULL THEN 'erased' WHEN encode(sha256(convert_to(p.payload,'UTF8')),'hex')=e.payload_hash THEN 'ok' ELSE 'mismatch' END AS payload_state
            FROM edal_entries e LEFT JOIN edal_payloads p ON p.entry_id=e.id WHERE e.district_id=$1 ORDER BY e.seq`, [id])).rows;
        const r = verifyChain(id, chain, head);
        const saved = (await client.query(`SELECT seq, head_hash FROM edal_checkpoints WHERE district_id=$1`, [id])).rows;
        const broken = saved.filter(c => !checkpointHolds(chain, c));
        for (const c of broken) r.problems.push({ seq: Number(c.seq), problem: "stored checkpoint no longer matches the chain" });
        if (checkpoint && (!checkpoint.districtId || checkpoint.districtId === id)) {
          r.checkpoint = checkpointHolds(chain, checkpoint);
          if (!r.checkpoint) r.problems.push({ seq: Number(checkpoint.seq), problem: "saved checkpoint is no longer part of this chain" });
        }
        r.ok = r.problems.length === 0;
        r.storedCheckpoints = saved.length;
        out.push({ districtId: id, ...r });
        await client.query("COMMIT");
      } finally { client.release(); }
    }
  } finally { await pool.end(); }
  return out;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 19).map(l => l.replace(/^\/\/ ?/, "")).join("\n")); return; }
  let results;
  try {
    const cp = loadCheckpoint(opts.checkpoint);
    results = opts.file ? verifyExport(JSON.parse(readFileSync(opts.file, "utf8")), cp) : await verifyDatabase(opts, cp);
  } catch (e) { console.error(`edal-verify: ${e.message}`); process.exit(2); }
  if (opts.json) console.log(JSON.stringify(results, null, 2));
  else for (const r of results) {
    console.log(`${r.ok ? "OK  " : "FAIL"} district ${r.districtId}: ${r.entries} entries, head #${r.headSeq} ${r.headHash.slice(0, 16)}…, ${r.erased} payload(s) erased under FERPA${r.checkpoint !== undefined ? `, checkpoint ${r.checkpoint ? "holds" : "BROKEN"}` : ""}`);
    for (const p of r.problems) console.log(`     #${p.seq}: ${p.problem}`);
  }
  if (!results.length) console.log("no districts found");
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

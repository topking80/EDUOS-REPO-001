#!/usr/bin/env node
// EduOS 32.7.0 school-node provisioning (owner role, one-shot).
//
// A school node's database should hold ONE school. After `migrate` (and, for
// local evaluation only, the synthetic demo seed) this removes every other
// school's learners and operational rows and disables their staff
// memberships, using eduos_node_prune_to_school() (owner session only).
//
//   DATABASE_URL=<owner URL> EDEN_DISTRICT_ID=<uuid> node src/eden/node-provision.js --school <uuid>
//     [--demo-seed]                 seed the synthetic demo district first, once (refused in production)
//     [--synthetic-students N]      add N clearly-fictional learners to the kept school (demo only),
//                                   so district aggregates have cells of 5+ to publish
//
// Idempotent: running it again prunes nothing new and adds no duplicates.
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRADES = ["4", "4", "3", "2", "4", "3", "2", "5", "4", "3", "2", "4", "5", "3", "2", "4", "5", "3", "2", "4", "5", "3", "4", "2"];
const FIRST = ["Avery", "Blake", "Casey", "Devon", "Emery", "Finley", "Gray", "Harper", "Indy", "Jules", "Kai", "Lane", "Morgan", "Nico", "Oakley", "Parker", "Quinn", "Reese", "Sage", "Tatum", "Uma", "Vale", "Wren", "Zion"];

export function parseArgs(argv) {
  const a = { school: null, demoSeed: false, synthetic: 0 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--school") a.school = argv[++i];
    else if (argv[i] === "--demo-seed") a.demoSeed = true;
    else if (argv[i] === "--synthetic-students") a.synthetic = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!UUID.test(a.school || "")) throw new Error("--school <uuid> is required");
  if (!Number.isInteger(a.synthetic) || a.synthetic < 0 || a.synthetic > GRADES.length) throw new Error(`--synthetic-students must be 0..${GRADES.length}`);
  return a;
}

export async function provision({ databaseUrl, districtId, school, demoSeed = false, synthetic = 0, env = process.env, log = console.log }) {
  const demo = demoSeed || synthetic > 0;
  if (demo && ((env.NODE_ENV || "development") === "production" || env.EDUOS_ALLOW_DEMO_SEED !== "true"))
    throw new Error("--demo-seed / --synthetic-students need EDUOS_ALLOW_DEMO_SEED=true and NODE_ENV other than production");
  if (!UUID.test(districtId || "")) throw new Error("EDEN_DISTRICT_ID must be the district UUID");
  const c = new pg.Client({ connectionString: databaseUrl }); await c.connect();
  try {
    if (demoSeed) {
      await c.query("SELECT set_config('app.district_id',$1,false)", [districtId]); // FORCE RLS applies to the owner too
      const n = (await c.query("SELECT count(*)::int n FROM schools WHERE district_id=$1", [districtId])).rows[0].n;
      if (n === 0) { const { seedDemo } = await import("../../dev/seed-demo.js"); await c.end(); await seedDemo({ databaseUrl, issuer: env.OIDC_ISSUER, env }); log("seeded the synthetic demo district"); return provision({ databaseUrl, districtId, school, synthetic, env, log }); }
      log("demo district already present; not seeding again");
    }
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.district_id',$1,true)", [districtId]);
    if (!(await c.query("SELECT 1 FROM schools WHERE id=$1 AND district_id=$2", [school, districtId])).rowCount) throw new Error("that school is not in this district");
    const pruned = (await c.query("SELECT eduos_node_prune_to_school($1) AS r", [school])).rows[0].r;
    let added = 0;
    for (let i = 0; i < synthetic; i++) {
      const id = `00000000-0000-4000-8000-${String(50001 + i).padStart(12, "0")}`;
      const r = await c.query(`INSERT INTO students(id,district_id,school_id,local_student_number,display_name,grade_level) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
        [id, districtId, school, `SYN-${String(i + 1).padStart(3, "0")}`, `${FIRST[i]} Synthetic`, GRADES[i]]);
      if (r.rowCount) {
        added++;
        await c.query(`INSERT INTO attendance_events(district_id,student_id,event_date,status) VALUES($1,$2,current_date,$3)`, [districtId, id, i % 9 === 4 ? "absent" : i % 11 === 6 ? "tardy" : "present"]);
      }
    }
    await c.query("COMMIT");
    log(`node provisioned for school ${school}: ${JSON.stringify(pruned)}${synthetic ? `, ${added} synthetic learners added` : ""}`);
    return { pruned, added };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { await c.end().catch(() => {}); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const a = parseArgs(process.argv.slice(2));
    await provision({ databaseUrl: process.env.DATABASE_URL, districtId: process.env.EDEN_DISTRICT_ID, school: a.school, demoSeed: a.demoSeed, synthetic: a.synthetic });
  } catch (e) { console.error(`node-provision: ${e.message}`); process.exit(1); }
}

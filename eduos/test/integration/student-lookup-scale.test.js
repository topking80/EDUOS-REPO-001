// Finding and removing student identifiers at district scale (db/043,
// src/student-identifiers.js): 100,000 students with realistic repeated first
// and last names, real PostgreSQL. The lookup must stay fast alone and under
// concurrent requests (the first version took 14 s for one lookup and 140 s
// for twenty here). The other integration files run at the same time, so the
// bounds are loose: they catch a return to scanning the roster, not
// milliseconds. Measured times are printed (about 0.2 s and 2.7 s alone).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, baseEnv, run, createDatabase, seed } from "./harness.js";
import { findStudentIdentifiers as lookup } from "../../src/student-identifiers.js";
import { removeIdentifiers } from "../../src/redact-names.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const FIRST = ["Maria", "José", "Wei", "Aisha", "Liam", "Olivia", "Noah", "Emma", "Mohammed", "Sofia", "Lucas", "Mia", "Ethan", "Ava", "Mateo", "Isabella", "Daniel", "Chloe", "Мария", "Yuki",
  "Fatima", "Omar", "Priya", "Arjun", "Hannah", "Diego", "Zoe", "Samuel", "Layla", "Kwame", "Ingrid", "Tomás", "Nia", "Kofi", "Elena", "Ravi", "Mei", "Jamal", "Sara", "Ben"];
const LAST = ["Smith", "Garcia", "Nguyen", "Johnson", "Lee", "Martinez", "Brown", "Kim", "Patel", "Rodriguez", "Davis", "Chen", "Lopez", "Wilson", "Khan", "Anderson", "Hernandez", "Okafor", "Иванова", "Tanaka",
  "O'Brien", "Okonkwo-Reyes", "de la Cruz", "Singh", "Ali", "Taylor", "Moore", "Jackson", "White", "Harris", "Clark", "Lewis", "Young", "Walker", "Hall", "Allen", "King", "Wright", "Scott", "Green",
  "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell", "Roberts", "Carter", "Phillips", "Evans", "Turner", "Torres", "Parker", "Collins", "Edwards", "Stewart", "Flores", "Morris", "Murphy", "Rivera"];

// The lookup runs in definers that match within the caller's district
// (db/179), so each call sets the district the way a tenant transaction does.
let pool;
async function findStudentIdentifiers(_pool, districtId, text) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.district_id', $1, true)", [districtId]);
    const r = await lookup(c, districtId, text);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

describe("student identifier lookup at district scale", { skip }, () => {
  let db;
  const filler = "The committee reviewed the reading intervention schedule and agreed the next steps for each year group before the holiday. ".repeat(60);
  const text = `Notes. Unusual Zephyrine Quillfeather (ZQ-0000042) joined; Garcia and Maria met Okonkwo-Reyes. ID 7/000/099. ${filler} Ends with Kwame.`;

  before(async () => {
    db = await createDatabase();
    const env = baseEnv({ EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, "http://idp.test");
    pool = new pg.Pool({ connectionString: db.adminUrl, max: 20 });
    // An idle pooled connection closed during teardown is not a test failure.
    pool.on("error", () => {});
    await pool.query(`INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level)
      SELECT $1, $2, (100 + g % 97) || '/' || lpad((g / 1000)::text, 3, '0') || '/' || lpad((g % 1000)::text, 3, '0'),
             ($3::text[])[1 + g % 40] || ' ' || ($4::text[])[1 + (g / 40) % 60], '5'
        FROM generate_series(1, 100000) g`, [ID.d1, ID.s1, FIRST, LAST]);
    await pool.query(`INSERT INTO students(district_id, school_id, local_student_number, display_name, grade_level) VALUES
      ($1,$2,'ZQ-0000042','Zephyrine Quillfeather','5'), ($1,$2,'7/000/099','Bartholomew Xylander','5')`, [ID.d1, ID.s1]);
    await pool.query("ANALYZE students");
  });
  after(async () => { await pool?.end(); await db?.drop(); });

  it("every student write keeps the token index current", async () => {
    const n = (await pool.query("SELECT count(DISTINCT student_id)::int AS n FROM student_redact_tokens WHERE district_id = $1", [ID.d1])).rows[0].n;
    const total = (await pool.query("SELECT count(*)::int AS n FROM students WHERE district_id = $1", [ID.d1])).rows[0].n;
    assert.equal(n, total);
    await pool.query("UPDATE students SET display_name = 'Renamed Person' WHERE local_student_number = 'ZQ-0000042'");
    assert.deepEqual((await findStudentIdentifiers(pool, ID.d1, "Zephyrine and Quillfeather")).names, []);
    assert.deepEqual((await findStudentIdentifiers(pool, ID.d1, "Renamed")).names, ["Renamed Person"]);
    await pool.query("UPDATE students SET display_name = 'Zephyrine Quillfeather' WHERE local_student_number = 'ZQ-0000042'");
  });

  it("finds and removes the right students among 100,000, quickly", async () => {
    const t0 = performance.now();
    const ids = await findStudentIdentifiers(pool, ID.d1, text);
    const lookupMs = performance.now() - t0;
    const t1 = performance.now();
    const out = removeIdentifiers(text, ids);
    const removeMs = performance.now() - t1;
    console.log(`# 100,000 students: lookup ${lookupMs.toFixed(0)} ms (${ids.names.length} candidate names), removal ${removeMs.toFixed(0)} ms`);
    for (const leak of ["Zephyrine", "Quillfeather", "ZQ-0000042", "Garcia", "Maria", "Okonkwo", "Reyes", "7/000/099", "Kwame"]) assert.ok(!out.includes(leak), `${leak} survived`);
    assert.match(out, /The committee reviewed the reading intervention schedule/);
    assert.ok(lookupMs < 6000, `lookup took ${lookupMs.toFixed(0)} ms`);
    assert.ok(removeMs < 6000, `removal took ${removeMs.toFixed(0)} ms`);
  });

  it("a text naming no one costs almost nothing", async () => {
    const t0 = performance.now();
    const ids = await findStudentIdentifiers(pool, ID.d1, filler);
    const ms = performance.now() - t0;
    console.log(`# 100,000 students: no-match lookup ${ms.toFixed(0)} ms (${ids.names.length} candidates)`);
    assert.ok(ms < 6000, `${ms.toFixed(0)} ms`);
  });

  it("20 staff at once", async () => {
    const t0 = performance.now();
    const all = await Promise.all(Array.from({ length: 20 }, () => findStudentIdentifiers(pool, ID.d1, text)));
    const ms = performance.now() - t0;
    console.log(`# 100,000 students: 20 concurrent lookups ${ms.toFixed(0)} ms in total`);
    assert.ok(all.every(x => x.names.includes("Zephyrine Quillfeather")));
    assert.ok(ms < 40000, `${ms.toFixed(0)} ms`);
  });
});

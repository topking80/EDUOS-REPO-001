// SEC-02 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §5.1): every table that
// holds a student's records must limit reads to that student's own people,
// not just to the district or school. Fails CI when a new table, or a changed
// policy, leaves student rows readable district- or school-wide by the runtime
// role, unless the table is on the reviewed list below with a reason.
//
// A table passes when the runtime role can't read it, or when no permissive
// read policy is "broad" (checks only district, school, role or table owner),
// or when a restrictive read policy that isn't broad narrows it.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, run, baseEnv, createDatabase } from "./harness.js";
import { isBroad, isOwnerOnly } from "./rls-coverage-rules.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

// Reviewed exceptions. Each needs a reason; SEC-01 removes the "pending" ones.
// An entry that starts passing must be removed (the test says so).
export const REVIEWED = {
  athlete_association_consents: "SEC-01 pending",
  activity_media_consents: "SEC-01 pending: limited to the school (plus district roles), not per student",
  activity_media_consent_history: "SEC-01 pending: limited to the school (plus district roles), not per student",
  activity_media_participants: "SEC-01 pending: limited to the school (plus district roles), not per student",
  eden_consent_exceptions: "Leaders only: a restrictive policy limits reads to the EDEN agent, the superintendent and the student's own school principal (records-transfer consent exceptions); no pupil, parent or teacher access",
};

describe("SEC-02 row-security coverage for student records", { skip }, () => {
  let db, admin, tables;
  before(async () => {
    db = await createDatabase();
    const m = await run(["src/migrate.js"], { ...baseEnv({ EDUOS_APP_ROLE: db.names.app }), DATABASE_URL: db.ownerUrl });
    assert.equal(m.code, 0, m.out);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    tables = (await admin.query(`
      SELECT k.relname AS name, k.relrowsecurity AS rls, k.relforcerowsecurity AS forced, has_table_privilege($1, k.oid, 'SELECT') AS app_select,
        coalesce((SELECT json_agg(json_build_object('name', p.policyname, 'permissive', p.permissive = 'PERMISSIVE', 'cmd', p.cmd, 'qual', p.qual))
          FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = k.relname), '[]') AS policies
      FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
      WHERE k.relkind = 'r' AND (k.relname = 'students' OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = k.oid AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname IN ('student_id', 'learner_id')))
      ORDER BY 1`, [db.names.app])).rows;
  });
  after(async () => { await admin?.end(); await db?.drop(); });

  const verdict = t => {
    if (!t.app_select) return { ok: true };
    const reads = t.policies.filter(p => ["SELECT", "ALL"].includes(p.cmd));
    const broad = reads.filter(p => p.permissive && isBroad(p.qual) && !isOwnerOnly(p.qual));
    const narrowing = reads.filter(p => !p.permissive && !isBroad(p.qual));
    return { ok: broad.length === 0 || narrowing.length > 0, broad: broad.map(p => p.name) };
  };

  it("finds the student tables, all with forced row security", () => {
    assert.ok(tables.length >= 80, `found ${tables.length}`);
    const weak = tables.filter(t => !t.rls || !t.forced).map(t => t.name);
    assert.deepEqual(weak, [], "row security enabled and forced");
  });

  it("every student table limits reads per student, or is on the reviewed list with a reason", () => {
    const failing = tables.filter(t => !verdict(t).ok);
    const unreviewed = failing.filter(t => !REVIEWED[t.name]).map(t => `${t.name} (broad: ${verdict(t).broad.join(", ") || "no USING"})`);
    assert.deepEqual(unreviewed, [], "these tables let the runtime role read student rows district- or school-wide. Add a per-student policy (see db/173, db/176), or add them to REVIEWED with a reason");
  });

  it("the reviewed list is current: every entry exists, still needs its exception, and has a reason", () => {
    const byName = new Map(tables.map(t => [t.name, t]));
    for (const [name, reason] of Object.entries(REVIEWED)) {
      assert.ok(byName.has(name), `${name} is on the reviewed list but isn't a student table any more`);
      assert.ok(typeof reason === "string" && reason.length >= 10, `${name} needs a reason`);
      assert.equal(verdict(byName.get(name)).ok, false, `${name} now limits reads per student: take it off the reviewed list`);
    }
  });
});

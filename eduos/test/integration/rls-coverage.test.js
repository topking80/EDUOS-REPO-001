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
  eden_consent_exceptions: "Leaders only: a restrictive policy limits reads to the EDEN agent, the superintendent and the student's own school principal (records-transfer consent exceptions); no pupil, parent or teacher access",
};

// Tables a chief of staff may reach (db/186); every other table with row security is closed to the role.
export const COS_OPEN = {
  cos_followups: "the role's own follow-up tracker, under its own policies",
  districts: "district name for the app and overview",
  schools: "school names for the overview and follow-ups",
  branding_profiles: "the app's look",
  user_preferences: "the role's own display settings",
  notification_outbox: "the role's own notifications (per-user policy)",
  users: "staff accounts only, via chief_of_staff_staff_only",
  memberships: "staff memberships only, via chief_of_staff_staff_only",
  district_users: "staff only, via chief_of_staff_staff_only",
  audit_events: "it writes its own audit rows and can't read the log (chief_of_staff_writes_only)",
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
    // no_chief_of_staff (db/186) shuts out one role; it narrows nothing per student.
    const narrowing = reads.filter(p => !p.permissive && !isBroad(p.qual) && p.name !== "no_chief_of_staff");
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

  // COS-01 (db/186): the Chief of Staff is coordination only, so every table
  // with row security is closed to the role except the reviewed few it needs.
  it("every table with row security is closed to the chief of staff, or reviewed as open", async () => {
    const rls = (await admin.query(`SELECT k.relname AS name,
        EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = k.relname AND p.policyname = 'no_chief_of_staff' AND p.permissive = 'RESTRICTIVE' AND p.cmd = 'ALL') AS closed
      FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
      WHERE k.relkind = 'r' AND k.relrowsecurity ORDER BY 1`)).rows;
    const open = rls.filter(t => !t.closed && !COS_OPEN[t.name]).map(t => t.name);
    assert.deepEqual(open, [], "a new table must call eduos_close_to_chief_of_staff('<table>') in its migration, or be reviewed in COS_OPEN with a reason");
    for (const [name, reason] of Object.entries(COS_OPEN)) {
      const t = rls.find(x => x.name === name);
      // A listed table without row security (districts) is open to every role by design.
      assert.ok((!t || !t.closed) && reason.length >= 10, `${name}: on COS_OPEN, open to the role, with a reason`);
    }
  });
});

// Staffing against a real PostgreSQL server, as the non-owner runtime role:
// every role, school boundaries, refused submissions and the status contract
// the apps rely on (coverage starts 'pending' and is decided from there).
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const day = (offsetDays, h = 8) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + offsetDays); d.setUTCHours(h, 0, 0, 0); return d.toISOString(); };
const coverage = (extra = {}) => ({ startsAt: day(2, 8), endsAt: day(2, 15), department: "instruction", roleNeeded: "Substitute teacher", details: "Room 12", ...extra });

describe("staffing against real PostgreSQL", { skip }, () => {
  let db, idp, server, s = {};
  const as = name => client(server.base, s[name]);
  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "vp1", "t1", "pa", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await idp?.close(); await db?.drop(); });

  it("families and learners can't see or use staffing", async () => {
    for (const who of ["pa", "pu"]) {
      assert.equal((await as(who)("GET", "/api/staff-management")).status, 403, who);
      assert.equal((await as(who)("POST", "/api/staff-management/absences", { startsAt: day(1, 0), endsAt: day(1, 23), reasonCategory: "personal" })).status, 403, who);
    }
  });

  it("a teacher requests time away; leaders see it with the employee's name; the teacher can't review it", async () => {
    const bad = await as("t1")("POST", "/api/staff-management/absences", { startsAt: day(3, 15), endsAt: day(3, 8), reasonCategory: "personal" });
    assert.equal(bad.status, 400); assert.equal(bad.body.error, "valid_absence_interval_required");
    const r = await as("t1")("POST", "/api/staff-management/absences", { startsAt: day(3, 0), endsAt: day(3, 23), reasonCategory: "professional_development" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.status, "pending");
    const id = r.body.data.id;

    const p1 = (await as("p1")("GET", "/api/staff-management")).body.data.absences.find(x => x.id === id);
    assert.equal(p1?.display_name, USERS.t1[1], "the principal can tell who asked");
    assert.equal(p1.school_id, ID.s1);
    assert.ok(!(await as("p2")("GET", "/api/staff-management")).body.data.absences.some(x => x.id === id), "another school's principal can't see it");
    assert.ok((await as("supt1")("GET", "/api/staff-management")).body.data.absences.some(x => x.id === id), "the district sees every school");
    assert.ok(!(await as("supt2")("GET", "/api/staff-management")).body.data.absences.some(x => x.id === id), "another district never does");

    assert.equal((await as("t1")("POST", `/api/staff-management/absences/${id}/review`, { decision: "approved" })).status, 403);
    assert.equal((await as("p2")("POST", `/api/staff-management/absences/${id}/review`, { decision: "approved" })).status, 404, "another school's principal can't decide it");
    assert.equal((await as("vp1")("POST", `/api/staff-management/absences/${id}/review`, { decision: "maybe" })).status, 400);
    const ok = await as("vp1")("POST", `/api/staff-management/absences/${id}/review`, { decision: "approved" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.data.status, "approved");
    assert.equal((await as("p1")("POST", `/api/staff-management/absences/${id}/review`, { decision: "denied" })).status, 404, "only pending requests can be decided");
  });

  it("coverage starts 'pending' and a school lead decides it from there", async () => {
    assert.equal((await as("t1")("POST", "/api/staff-management/coverage", coverage())).status, 403, "teachers can't request coverage");
    const bad = await as("p1")("POST", "/api/staff-management/coverage", coverage({ department: "nowhere" }));
    assert.equal(bad.status, 400); assert.equal(bad.body.error, "valid_coverage_fields_required");

    const r = await as("p1")("POST", "/api/staff-management/coverage", coverage());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.status, "pending", "the status the apps must offer Approve/Decline for");
    const listed = (await as("vp1")("GET", "/api/staff-management")).body.data.coverage.find(x => x.id === r.body.data.id);
    assert.equal(listed?.status, "pending");

    assert.equal((await as("p2")("POST", `/api/staff-management/coverage/${r.body.data.id}/decision`, { decision: "approved" })).status, 404);
    const ok = await as("vp1")("POST", `/api/staff-management/coverage/${r.body.data.id}/decision`, { decision: "approved" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body)); assert.equal(ok.body.data.status, "approved");
    const assign = await as("p1")("POST", `/api/staff-management/coverage/${r.body.data.id}/decision`, { decision: "assigned", assignedUserId: USERS.t1[0] });
    assert.equal(assign.status, 200, JSON.stringify(assign.body)); assert.equal(assign.body.data.assigned_user_id, USERS.t1[0]);
    assert.equal((await as("p1")("POST", `/api/staff-management/coverage/${r.body.data.id}/decision`, { decision: "declined" })).status, 404, "assigned is final");

    const other = await as("p1")("POST", "/api/staff-management/coverage", coverage());
    const wrongSchool = await as("p1")("POST", `/api/staff-management/coverage/${other.body.data.id}/decision`, { decision: "assigned", assignedUserId: USERS.p2[0] });
    assert.equal(wrongSchool.status, 400); assert.equal(wrongSchool.body.error, "assignee_not_active_in_school");
    const declined = await as("p1")("POST", `/api/staff-management/coverage/${other.body.data.id}/decision`, { decision: "declined" });
    assert.equal(declined.body.data.status, "declined");
  });

  it("a superintendent (no school on their membership) names a school, and it must be in their district", async () => {
    const none = await as("supt1")("POST", "/api/staff-management/coverage", coverage());
    assert.equal(none.status, 400); assert.equal(none.body.error, "school_required");
    const foreign = await as("supt1")("POST", "/api/staff-management/coverage", coverage({ schoolId: ID.sd2 }));
    assert.equal(foreign.status, 400); assert.equal(foreign.body.error, "school_not_in_district");

    const r = await as("supt1")("POST", "/api/staff-management/coverage", coverage({ schoolId: ID.s2 }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok((await as("p2")("GET", "/api/staff-management")).body.data.coverage.some(x => x.id === r.body.data.id), "lands at the school named");
    assert.ok(!(await as("p1")("GET", "/api/staff-management")).body.data.coverage.some(x => x.id === r.body.data.id));
    const decided = await as("supt1")("POST", `/api/staff-management/coverage/${r.body.data.id}/decision`, { decision: "assigned", assignedUserId: USERS.p2[0] });
    assert.equal(decided.status, 200, "the district decides at any of its schools, assigning someone from that school");
    assert.equal((await as("supt2")("POST", `/api/staff-management/coverage/${r.body.data.id}/decision`, { decision: "declined" })).status, 404, "never another district's");

    const away = await as("t1")("POST", "/api/staff-management/absences", { startsAt: day(5, 0), endsAt: day(5, 23), reasonCategory: "personal" });
    const reviewed = await as("supt1")("POST", `/api/staff-management/absences/${away.body.data.id}/review`, { decision: "denied" });
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body)); assert.equal(reviewed.body.data.status, "denied");

    const shift = await as("supt1")("POST", "/api/staff-management/shifts", { schoolId: ID.s1, staffUserId: USERS.t1[0], shiftDate: day(4).slice(0, 10), startsAt: day(4, 8), endsAt: day(4, 12), department: "instruction", assignment: "Morning cover, room 12" });
    assert.equal(shift.status, 201, JSON.stringify(shift.body));
    const notThere = await as("supt1")("POST", "/api/staff-management/shifts", { schoolId: ID.s2, staffUserId: USERS.t1[0], shiftDate: day(4).slice(0, 10), startsAt: day(4, 8), endsAt: day(4, 12), department: "instruction", assignment: "x" });
    assert.equal(notThere.body.error, "staff_member_not_active_in_school");
    assert.ok((await as("t1")("GET", "/api/staff-management")).body.data.shifts.some(x => x.id === shift.body.data.id), "the teacher sees their shift");
  });

  it("a school principal's schoolId in the body is ignored: they only act on their own school", async () => {
    const r = await as("p1")("POST", "/api/staff-management/coverage", coverage({ schoolId: ID.s2 }));
    assert.equal(r.status, 201);
    assert.ok((await as("p1")("GET", "/api/staff-management")).body.data.coverage.some(x => x.id === r.body.data.id));
    assert.ok(!(await as("p2")("GET", "/api/staff-management")).body.data.coverage.some(x => x.id === r.body.data.id));
  });
});

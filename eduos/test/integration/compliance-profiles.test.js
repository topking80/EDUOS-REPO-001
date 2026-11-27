// HSP-06 part 2: compliance profiles against real PostgreSQL, as the
// non-owner runtime role: platform-published templates with review metadata,
// adoption by a family or school, progress from their own attendance, the
// checklist, custom profiles, and isolation.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";
import { currentSchoolYear } from "../../src/compliance-requirements.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const SY = currentSchoolYear();
const today = () => new Date().toISOString().slice(0, 10);

describe("HSP-06 part 2 compliance profiles", { skip }, () => {
  let db, idp, server, admin, env, s = {}, ids = {}, tmp;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const H = "/api/homeschool", P = "/api/private-school";
  const switchTo = async (name, kind, membershipId) => {
    const r = await fetch(`${server.base}/api/session/context`, { method: "POST", headers: { "content-type": "application/json", cookie: s[name].cookie, "x-csrf-token": s[name].csrf },
      body: JSON.stringify({ kind, membershipId }) });
    const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j));
    s[name] = { cookie: r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => !c.endsWith("=")), csrf: j.csrfToken };
  };
  const contextOf = async (name, kind) => (await as(name)("GET", "/api/session/contexts")).body.data.contexts.find(c => c.kind === kind).membershipId;
  const template = (over = {}) => {
    const t = JSON.parse(fs.readFileSync(new URL("../../docs/compliance-templates/EXAMPLE-not-a-real-requirement.json", import.meta.url)));
    delete t._comment; t.lastReviewedOn = today(); return { ...t, ...over };
  };
  const publish = async t => { fs.writeFileSync(tmp, JSON.stringify(t)); return run(["src/compliance-template.js", "publish", "--file", tmp], { ...env, DATABASE_URL: db.ownerUrl }); };

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eduos-template-")), "template.json");
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["pa", "pb", "p1", "t1", "supt1"]) s[n] = await login(server.base, idp, n, { email_verified: true });
    const f = ok(await as("pa")("POST", `${H}/families`, { name: "Ortiz Homeschool", jurisdiction: "US-TX" }), 201); await switchTo("pa", "homeschool_family", f.membershipId); ids.fam = f.familyId;
    ids.mia = ok(await as("pa")("POST", `${H}/learners`, { displayName: "Mia", gradeBand: "4" }), 201).id;
    ids.leo = ok(await as("pa")("POST", `${H}/learners`, { displayName: "Leo", gradeBand: "2" }), 201).id;
    ok(await as("pa")("POST", `${H}/learners/${ids.mia}/attendance`, { day: today(), minutes: 300 }), 201);
    for (const [who, role] of [["t1", "co_educator"], ["pb", "guardian_viewer"]]) {
      const t = ok(await as("pa")("POST", `${H}/invitations`, { email: USERS[who][2], role, learnerIds: [ids.mia, ids.leo] }), 201).token;
      ok(await as(who)("POST", `${H}/invitations/accept`, { token: t })); await switchTo(who, "homeschool_family", await contextOf(who, "homeschool_family"));
    }
    const r = ok(await as("p1")("POST", `${P}/schools`, { legalName: "Hillside Academy, Inc.", displayName: "Hillside Academy", campusName: "Main" }), 201);
    await switchTo("p1", "private_school", r.membershipId); ids.school = r.schoolId;
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); });

  it("only the platform publishes templates, and only with sources, an authority, a recent review and a reviewer", async () => {
    const bad = await publish(template({ sources: [], reviewedBy: "" }));
    assert.notEqual(bad.code, 0); assert.match(bad.out, /sources/);
    const stale = await publish(template({ lastReviewedOn: "2023-01-01" }));
    assert.notEqual(stale.code, 0); assert.match(stale.out, /18 months/);
    assert.equal((await publish(template())).code, 0);
    assert.equal((await publish(template({ appliesTo: "private_school", title: "Example State private school planning template" }))).code, 0);
    const app = new pg.Client(db.appUrl); await app.connect();
    try { await assert.rejects(app.query("INSERT INTO compliance_templates(jurisdiction, applies_to, title, version, requirements, sources, authority_name, authority_url, effective_from, last_reviewed_on, reviewed_by) VALUES ('US-ZZ','homeschool_family','X','2026.9','{}','[{}]','Someone','https://x','2026-01-01','2026-01-01','Me')"), /permission denied/); }
    finally { await app.end(); }
    await assert.rejects(admin.query("UPDATE compliance_templates SET requirements='{}'"), /publish a new version/);
    const list = ok(await as("pa")("GET", `${H}/compliance/templates`));
    assert.equal(list.length, 1); ids.template = list[0].id;
    assert.deepEqual([list[0].authority.name, list[0].reviewedBy, list[0].sources.length], ["Example State Department of Education", "Name of the reviewer and their organization", 1]);
    assert.equal((await as("pb")("GET", `${H}/compliance/templates`)).body.error, "not_allowed", "a guardian viewer doesn't plan compliance");
  });

  it("a family's owner adopts a template; progress comes from its own attendance; deadlines and the checklist are tracked", async () => {
    const none = ok(await as("pa")("GET", `${H}/compliance`));
    assert.equal(none.profile, null); assert.match(none.disclaimer, /not legal advice/);
    assert.equal((await as("t1")("POST", `${H}/compliance`, { schoolYear: SY, templateId: ids.template })).body.error, "family_owner_only");
    ids.profile = ok(await as("pa")("POST", `${H}/compliance`, { schoolYear: SY, templateId: ids.template }), 201).id;
    assert.equal((await as("pa")("POST", `${H}/compliance`, { schoolYear: SY, templateId: ids.template })).body.error, "already_have_a_profile_for_that_year");
    const p = ok(await as("t1")("GET", `${H}/compliance`));
    assert.match(p.profile.provenance, /last reviewed \d{4}-\d{2}-\d{2} by Name of the reviewer/);
    assert.deepEqual(p.instruction.progress.map(x => [x.learner, x.days, x.hours, x.daysMet]), [["Leo", 0, 0, false], ["Mia", 1, 5, false]]);
    assert.equal(p.deadlines[0].key, "notice_of_intent");
    assert.deepEqual(p.documents[0].perLearner.map(x => [x.learner, x.status]), [["Leo", "to_do"], ["Mia", "to_do"]]);
    // A co-educator ticks items; per-learner documents need a learner.
    assert.equal((await as("t1")("PUT", `${H}/compliance/${ids.profile}/checklist/attendance_record`, { status: "done" })).body.error, "learner_required");
    ok(await as("t1")("PUT", `${H}/compliance/${ids.profile}/checklist/attendance_record`, { status: "done", learnerId: ids.mia, evidenceRef: "Binder, shelf 2" }));
    ok(await as("t1")("PUT", `${H}/compliance/${ids.profile}/checklist/notice_of_intent`, { status: "done", doneOn: today() }));
    assert.equal((await as("t1")("PUT", `${H}/compliance/${ids.profile}/checklist/nope`, { status: "done" })).status, 404);
    assert.equal((await as("pb")("PUT", `${H}/compliance/${ids.profile}/checklist/notice_of_intent`, { status: "to_do" })).body.error, "not_allowed");
    const after = ok(await as("pa")("GET", `${H}/compliance`));
    assert.deepEqual([after.deadlines[0].status, after.deadlines[0].flag], ["done", null]);
    assert.deepEqual(after.documents[0].perLearner.find(x => x.learner === "Mia"), { learnerId: ids.mia, learner: "Mia", status: "done", doneOn: today(), evidenceRef: "Binder, shelf 2", note: null });
    ok(await as("pa")("POST", `${H}/compliance/${ids.profile}/retention`, { years: 7 }));
    assert.equal(ok(await as("pa")("GET", `${H}/compliance`)).profile.retentionYears, 7);
    // Retiring the template leaves the adopted copy as it was.
    await run(["src/compliance-template.js", "retire", "--id", ids.template], { ...env, DATABASE_URL: db.ownerUrl });
    const kept = ok(await as("pa")("GET", `${H}/compliance`));
    assert.equal(kept.profile.template.retired, true); assert.equal(kept.instruction.required.days, 180);
    assert.deepEqual(ok(await as("pa")("GET", `${H}/compliance/templates`)), []);
    const { rows } = await admin.query("SELECT action FROM family_audit_events WHERE family_id=$1 AND resource_type='compliance_profile'", [ids.fam]);
    for (const a of ["adopt", "check", "set_retention"]) assert.ok(rows.some(r => r.action === a), a);
  });

  it("a school sets up its own requirements, labelled as set by the school", async () => {
    assert.equal((await as("p1")("POST", `${P}/compliance`, { schoolYear: SY, label: "Our plan", requirements: { instruction: { days: 0 } } })).body.error, "invalid_requirements");
    const id = ok(await as("p1")("POST", `${P}/compliance`, { schoolYear: SY, label: "Hillside board policy", requirements: { instruction: { days: 175 },
      documents: [{ key: "immunization_records", label: "Immunization records on file" }], retentionYears: 5 } }), 201).id;
    const p = ok(await as("p1")("GET", `${P}/compliance`));
    assert.deepEqual([p.profile.custom, p.profile.provenance, p.profile.retentionYears], [true, "Set by your school. Not reviewed by EduOS.", 5]);
    assert.equal(p.instruction.progress[0].learner, "School");
    ok(await as("p1")("PUT", `${P}/compliance/${id}/checklist/immunization_records`, { status: "done", evidenceRef: "Front office cabinet" }));
    ok(await as("p1")("POST", `${P}/compliance/${id}/end`, {}));
    assert.equal(ok(await as("p1")("GET", `${P}/compliance`)).profile, null);
  });

  it("other families, schools and districts see none of it", async () => {
    const other = ok(await as("supt1")("POST", `${H}/families`, { name: "Other Family" }), 201); await switchTo("supt1", "homeschool_family", other.membershipId);
    assert.equal(ok(await as("supt1")("GET", `${H}/compliance`)).profile, null);
    assert.equal((await as("supt1")("PUT", `${H}/compliance/${ids.profile}/checklist/notice_of_intent`, { status: "to_do" })).status, 404);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','superintendent',true)", [ID.d1, USERS.supt1[0]]);
      for (const t of ["compliance_profiles", "compliance_checklist"]) assert.equal((await app.query(`SELECT * FROM ${t}`)).rowCount, 0, t);
      await app.query("ROLLBACK");
      await assert.rejects(app.query("DELETE FROM compliance_profiles"), /permission denied/);
    } finally { await app.end(); }
  });
});

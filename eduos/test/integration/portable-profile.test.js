// TEACH-05: the portable teacher profile against real PostgreSQL, as the
// runtime role: rights claims need evidence and a reviewer; a package holds the
// teacher's own work and licenses and nothing that names a student; the school
// keeps a copy unless a claim was approved; the teacher brings it into another
// district, which reviews every item; approved items become the teacher's
// library there; tampering and re-use are refused.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const C1 = "c0000000-0000-4000-8000-0000000000c1", UA = "c0000000-0000-4000-8000-0000000000e1", UB = "c0000000-0000-4000-8000-0000000000e2";
const L1 = "c0000000-0000-4000-8000-0000000000f1", L2 = "c0000000-0000-4000-8000-0000000000f2";
const C2 = "c0000000-0000-4000-8000-0000000000c2", U2 = "c0000000-0000-4000-8000-0000000000e3";

describe("TEACH-05 portable teacher profile against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, claim, pkg, inD2, imp, library;
  const as = name => client(server.base, s[name]);
  const D2 = () => client(server.base, inD2);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, PORTFOLIO_SIGNING_SECRET: "p".repeat(40) });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    const q = (sql, p) => admin.query(sql, p);
    await q(`INSERT INTO courses(id,district_id,school_id,teacher_user_id,title,subject,grade_level) VALUES ($1,$2,$3,$4,'Math 3','Math','3')`, [C1, ID.d1, ID.s1, USERS.t1[0]]);
    await q(`INSERT INTO course_units(id,district_id,course_id,seq,title,summary) VALUES ($1,$3,$4,1,'Fractions','Halves and quarters'),($2,$3,$4,2,'Class stories',null)`, [UA, UB, ID.d1, C1]);
    await q(`INSERT INTO lessons(id,district_id,course_id,unit_id,seq,title,objective,content,status,created_by,approved_by,approved_at) VALUES
      ($1,$3,$4,$5,1,'Halves','Show halves','Fold a strip in two.','published',$7,$8,now()),
      ($2,$3,$4,$6,1,'Our week','Retell','Alice A shared her weekend.','published',$7,null,null)`, [L1, L2, ID.d1, C1, UA, UB, USERS.t1[0], USERS.p1[0]]);
    await q(`INSERT INTO coaching_plans(district_id,owner_user_id,kind,title,sport,level,body) VALUES ($1,$2,'practice','Tuesday practice','Soccer','JV',$3)`,
      [ID.d1, USERS.t1[0], { summary: "Possession", items: [{ kind: "drill", title: "Rondo", minutes: 10 }] }]);
    await q(`INSERT INTO educator_licenses(district_id,user_id,state_code,license_number,license_type,expires_on,status,verified_by,verified_at) VALUES ($1,$2,'TX','TX-1','Standard',current_date+400,'verified',$3,now())`,
      [ID.d1, USERS.t1[0], USERS.supt1[0]]);
    // The teacher is onboarded by another district (D2) too, with a course there.
    await q(`INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($1,$2,$3,'teacher',false)`, [USERS.t1[0], ID.d2, ID.sd2]);
    await q(`INSERT INTO courses(id,district_id,school_id,teacher_user_id,title,subject,grade_level) VALUES ($1,$2,$3,$4,'Math 4','Math','4')`, [C2, ID.d2, ID.sd2, USERS.t1[0]]);
    await q(`INSERT INTO course_units(id,district_id,course_id,seq,title) VALUES ($1,$2,$3,1,'Start')`, [U2, ID.d2, C2]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a rights claim needs evidence and someone else to review it", async () => {
    const body = { itemKind: "unit", itemId: UA, claimType: "copyright", statement: "I wrote and registered this unit before joining the district." };
    assert.equal((await as("t1")("POST", "/api/portfolio/claims", body)).body.error, "evidence_required");
    assert.equal((await as("tp")("POST", "/api/portfolio/claims", { ...body, registration: "TX0009999999" })).body.error, "not_your_work");
    claim = ok(await as("t1")("POST", "/api/portfolio/claims", { ...body, registration: "TX0009999999", evidenceUrl: "https://publicrecords.copyright.gov/x" }), 201);
    assert.equal((await as("t1")("POST", "/api/portfolio/claims", { ...body, registration: "TX0009999999" })).status, 409, "one open claim per work");
    assert.equal((await as("t1")("POST", `/api/portfolio/claims/${claim.id}/decision`, { decision: "approved" })).status, 403);
    assert.deepEqual(ok(await as("p2")("GET", "/api/portfolio/claims")), [], "another school's principal doesn't review it");
    assert.equal((await as("p1")("POST", `/api/portfolio/claims/${claim.id}/decision`, { decision: "rejected" })).body.error, "reason_required");
    ok(await as("p1")("POST", `/api/portfolio/claims/${claim.id}/decision`, { decision: "approved", note: "Registration checked" }));
    const mine = ok(await as("t1")("GET", "/api/portfolio/claims"));
    assert.deepEqual([mine[0].status, mine[0].reviewedBy], ["approved", "Principal S1"]);
    assert.equal(ok(await as("supt1")("GET", "/api/portfolio/claims?status=approved")).length, 1);
  });

  it("a package holds the teacher's own work and licenses, never a student's name; the school keeps copies unless rights were approved", async () => {
    const pv = ok(await as("t1")("GET", "/api/portfolio/preview"));
    assert.deepEqual(pv.items.map(i => [i.kind, i.title, i.schoolKeepsCopy]), [["unit", "Fractions", false], ["coaching_plan", "Tuesday practice", true]]);
    assert.deepEqual(pv.excluded, [{ kind: "unit", title: "Class stories", reason: "may_mention_students" }]);
    assert.equal(pv.items[0].approval.by, "Principal S1");
    assert.equal((await as("p1")("POST", "/api/portfolio/packages", {})).status, 403);
    pkg = ok(await as("t1")("POST", "/api/portfolio/packages", {}), 201);
    assert.deepEqual([pkg.items, pkg.licenses, pkg.schoolKeeps, pkg.signed], [2, 1, 1, true]);
    const stored = (await admin.query(`SELECT manifest::text AS m FROM portfolio_packages WHERE id=$1`, [pkg.id])).rows[0].m;
    assert.doesNotMatch(stored, /Alice|S1-A/, "nothing that names a student");
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM lessons`)).rows[0].n, 2, "the school's lessons are untouched");
  });

  it("the teacher brings it into another district, which reviews every item", async () => {
    const m = ok(await as("t1")("GET", "/api/memberships")).find(x => (x.district_id || x.districtId) === ID.d2);
    const sw = await as("t1")("POST", "/api/session/membership", { membershipId: m.id });
    assert.equal(sw.status, 200, JSON.stringify(sw.body));
    inD2 = { cookie: sw.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith("eduos_session=") && !c.endsWith("=")), csrf: sw.body.csrfToken };
    assert.equal(ok(await D2()("GET", "/api/portfolio/packages")).length, 1, "the package follows the teacher");
    imp = ok(await D2()("POST", "/api/portfolio/imports", { packageId: pkg.id }), 201);
    assert.deepEqual([imp.items, imp.signed], [2, true]);
    assert.equal((await D2()("POST", "/api/portfolio/imports", { packageId: pkg.id })).status, 409, "brought in once");
    assert.deepEqual(ok(await as("supt1")("GET", "/api/portfolio/imports")), [], "the old district doesn't see it");
    const waiting = ok(await as("supt2")("GET", "/api/portfolio/imports"));
    assert.deepEqual(waiting[0].items.map(i => [i.title, i.approval?.district ?? null, i.rights?.type ?? null]), [["Fractions", "D1", "copyright"], ["Tuesday practice", null, null]]);
    assert.equal((await as("supt2")("POST", `/api/portfolio/imports/${imp.id}/review`, { decisions: [{ index: 0, decision: "approved" }] })).body.error, "decide_every_item");
    ok(await as("supt2")("POST", `/api/portfolio/imports/${imp.id}/review`, { decisions: [{ index: 0, decision: "approved" }, { index: 1, decision: "rejected" }], note: "Plan not needed here" }));
    assert.equal((await as("supt2")("POST", `/api/portfolio/imports/${imp.id}/review`, { decisions: [{ index: 0, decision: "approved" }, { index: 1, decision: "approved" }] })).status, 404, "reviewed once");
  });

  it("approved items become the teacher's library and copy into their course; licenses come in to be verified here", async () => {
    library = ok(await D2()("GET", "/api/portfolio/library"));
    assert.deepEqual(library.map(l => [l.kind, l.title, l.origin, l.approvedBy, l.rights?.registration]), [["unit", "Fractions", "D1", "Supt D2", "TX0009999999"]]);
    const copied = ok(await D2()("POST", `/api/portfolio/library/${library[0].id}/copy`, { courseId: C2 }), 201);
    assert.equal(copied.lessons, 1);
    const l = (await admin.query(`SELECT l.title,l.status,l.district_id FROM lessons l JOIN course_units u ON u.id=l.unit_id WHERE u.id=$1`, [copied.unitId])).rows;
    assert.deepEqual(l.map(x => [x.title, x.status, x.district_id]), [["Halves", "draft", ID.d2]]);
    assert.equal((await D2()("POST", `/api/portfolio/library/${library[0].id}/copy`, { courseId: C1 })).status, 404, "only into their courses here");
    assert.equal(ok(await D2()("POST", `/api/portfolio/imports/${imp.id}/licenses`, {}), 201).added, 1);
    const lic = (await admin.query(`SELECT status,district_id FROM educator_licenses WHERE user_id=$1 ORDER BY created_at`, [USERS.t1[0]])).rows;
    assert.deepEqual(lic.map(x => [x.status, x.district_id]), [["verified", ID.d1], ["self_reported", ID.d2]], "this district verifies for itself");
    assert.equal(ok(await D2()("POST", `/api/portfolio/imports/${imp.id}/licenses`, {}), 201).added, 0);
  });

  it("a changed package fails its check; a withdrawn one can't be brought in; nobody else reads a teacher's packages", async () => {
    s.t1 = await login(server.base, idp, "t1", { email_verified: true }); // switching profiles retired the earlier session
    const second = ok(await as("t1")("POST", "/api/portfolio/packages", {}), 201);
    await admin.query(`UPDATE portfolio_packages SET manifest=jsonb_set(manifest,'{items,0,title}','"Changed"') WHERE id=$1`, [second.id]);
    assert.equal((await D2()("POST", "/api/portfolio/imports", { packageId: second.id })).body.error, "package_failed_its_check");
    const third = ok(await as("t1")("POST", "/api/portfolio/packages", {}), 201);
    ok(await as("t1")("POST", `/api/portfolio/packages/${third.id}/withdraw`, {}));
    assert.equal((await D2()("POST", "/api/portfolio/imports", { packageId: third.id })).status, 404);
    assert.equal((await as("tp")("POST", "/api/portfolio/imports", { packageId: pkg.id })).status, 404);
    await admin.query(`SET ROLE ${db.names.app}`);
    try {
      await admin.query(`SELECT set_config('app.user_id','${USERS.tp[0]}',false), set_config('app.district_id','${ID.d1}',false)`);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM portfolio_packages`)).rows[0].n, 0, "packages are the owner's only");
    } finally { await admin.query("RESET ROLE"); }
  });
});

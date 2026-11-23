// RANK-01: a school's U.S. News indicator figures against real PostgreSQL, as
// the runtime role: principals enter their own school's figures with a source,
// the superintendent verifies (not their own), changes keep history, the
// district view shows what's in and missing; no rank is computed.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("RANK-01 U.S. News indicators against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, entry;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const put = (who, school, year, ind, body) => as(who)("PUT", `/api/rankings/schools/${school}/${year}/${ind}`, body);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "vp1", "t1", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("lists the six indicators with their weights; teachers don't see the dashboard", async () => {
    const d = ok(await as("p1")("GET", "/api/rankings/indicators"));
    assert.deepEqual(d.indicators.map(i => [i.key, i.weight]), [["college_readiness", 30], ["curriculum_breadth", 10], ["assessment_proficiency", 20],
      ["assessment_performance", 20], ["underserved_performance", 10], ["graduation_rate", 10]]);
    assert.match(d.note, /doesn't compute or predict a rank/);
    assert.equal((await as("t1")("GET", "/api/rankings/indicators")).status, 403);
  });

  it("a principal enters their own school's figures, each with a source", async () => {
    const body = { values: { seniors: 200, tookExam: 120, qualified: 90 }, sourceNote: "College Board AP school report, 2024-25" };
    assert.equal((await put("p1", ID.s1, "2024-25", "college_readiness", { ...body, sourceNote: "" })).body.error, "source_required");
    assert.equal((await put("p1", ID.s1, "2024-25", "college_readiness", { ...body, values: { seniors: 200, tookExam: 100, qualified: 120 } })).body.error, "check_the_figures");
    assert.equal((await put("p1", ID.s2, "2024-25", "college_readiness", body)).status, 404, "not another school");
    assert.equal((await put("vp1", ID.s1, "2024-25", "college_readiness", body)).status, 403);
    entry = ok(await put("p1", ID.s1, "2024-25", "college_readiness", body));
    assert.deepEqual(entry.shown, { "Took an exam": 60, "Qualifying score": 45 });
    ok(await put("p1", ID.s1, "2024-25", "graduation_rate", { values: { rate: 91.4, cohortStart: 2021 }, sourceUrl: "https://example.gov/report-card" }));
    ok(await put("p1", ID.s1, "2023-24", "graduation_rate", { values: { rate: 89 }, sourceUrl: "https://example.gov/report-card" }));
    ok(await put("supt1", ID.s2, "2024-25", "assessment_proficiency", { values: { math: 55, reading: 62 }, sourceNote: "State report card" }));
  });

  it("the superintendent verifies (not their own entry); a change is a new entry, the old one kept", async () => {
    assert.equal((await as("p1")("POST", `/api/rankings/entries/${entry.id}/verify`, {})).status, 403);
    ok(await as("supt1")("POST", `/api/rankings/entries/${entry.id}/verify`, {}));
    const own = ok(await as("supt1")("GET", `/api/rankings/schools/${ID.s2}`)).indicators.find(i => i.key === "assessment_proficiency").byYear[0];
    assert.equal((await as("supt1")("POST", `/api/rankings/entries/${own.id}/verify`, {})).body.error, "someone_else_verifies");

    const changed = ok(await put("p1", ID.s1, "2024-25", "college_readiness", { values: { seniors: 200, tookExam: 125, qualified: 92 }, sourceNote: "Corrected AP report" }));
    assert.equal(changed.verifiedBy ?? null, null, "a change needs verifying again");
    const d = ok(await as("p1")("GET", `/api/rankings/schools/${ID.s1}`));
    assert.deepEqual(d.years, ["2024-25", "2023-24"]);
    assert.equal(d.changesKept, 1);
    // The database keeps verifying with the superintendent, whatever the route.
    await assert.rejects(admin.query(`SET ROLE ${db.names.app}; SELECT set_config('app.district_id','${ID.d1}',false), set_config('app.user_id','a0000000-0000-4000-8000-000000000003',false),
      set_config('app.role','principal',false), set_config('app.school_id','${ID.s1}',false);
      UPDATE school_ranking_entries SET verified_by='a0000000-0000-4000-8000-000000000003',verified_at=now() WHERE id='${changed.id}'`), /only the superintendent verifies/)
      .finally(() => admin.query("RESET ROLE"));
    assert.deepEqual(d.indicators.find(i => i.key === "graduation_rate").byYear.map(e => e?.values.rate), [91.4, 89]);
  });

  it("the district view shows what's in and missing; nobody outside the school or district sees it", async () => {
    const v = ok(await as("supt1")("GET", "/api/rankings/schools?year=2024-25"));
    const s1 = v.schools.find(x => x.id === ID.s1), s2 = v.schools.find(x => x.id === ID.s2);
    assert.deepEqual([s1.entered, s1.weightCovered, s1.verified], [2, 40, 0]);
    assert.deepEqual(s1.missing, ["curriculum_breadth", "assessment_proficiency", "assessment_performance", "underserved_performance"]);
    assert.equal(s2.weightCovered, 20);
    assert.deepEqual(ok(await as("p1")("GET", "/api/rankings/schools")).schools.map(x => x.name), ["S1"], "a principal: their school");
    assert.equal((await as("p2")("GET", `/api/rankings/schools/${ID.s1}`)).status, 404);
    assert.equal(ok(await as("supt2")("GET", "/api/rankings/schools")).schools.every(x => x.entered === 0), true, "another district sees none of it");
    assert.equal(ok(await as("vp1")("GET", `/api/rankings/schools/${ID.s1}`)).name, "S1", "the vice principal reads");
  });
});

// LRH-01: the district learning-resource catalog against real PostgreSQL, as
// the runtime role: catalog managers, licence review by a second person,
// publication gates, collections, school choice, and who sees what.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const TABLES = ["learning_resources", "learning_resource_collections", "learning_resource_collection_items", "learning_resource_school_selections"];
const SHA = "a".repeat(64);

describe("LRH-01 learning-resource catalog", { skip }, () => {
  let db, idp, server, admin, s = {}, ids = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const resource = (over = {}) => ({ title: "Fractions picture book", resourceType: "ebook", sourceName: "Example Open Library", sourceUrl: "https://example.org/fractions",
    licenseName: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", gradeMin: "2", gradeMax: "4", subjects: ["Math"], version: "2026.1", ...over });
  const titles = async who => ok(await as(who)("GET", "/api/resources")).map(r => r.title).sort();

  before(async () => {
    db = await createDatabase(); idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const n of ["supt1", "supt1b", "supt2", "p1", "p2", "t1", "pa", "pu"]) s[n] = await login(server.base, idp, n, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only district catalog managers describe resources; tables hold no student records", async () => {
    const { rows } = await admin.query("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname = ANY($1) AND relkind='r'", [TABLES]);
    assert.equal(rows.length, TABLES.length); for (const r of rows) assert.ok(r.relforcerowsecurity, r.relname);
    const cols = await admin.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_name = ANY($1) AND column_name ~ '(student|learner|pupil|guardian)'", [TABLES]);
    assert.deepEqual(cols.rows, []);
    for (const who of ["p1", "t1", "pa", "pu"]) assert.equal((await as(who)("POST", "/api/resources", resource())).body.error, "catalog_managers_only", who);
    assert.deepEqual((await as("supt1")("POST", "/api/resources", resource({ sourceUrl: "http://example.org/x", gradeMin: "5", gradeMax: "2" }))).body.fields,
      ["sourceUrl (https)", "gradeMin after gradeMax"]);
    ids.a = ok(await as("supt1")("POST", "/api/resources", resource()), 201).id;
    ids.b = ok(await as("supt1")("POST", "/api/resources", resource({ title: "Teaching fractions (guide)", audience: "staff", sha256: SHA })), 201).id;
    ids.c = ok(await as("supt1")("POST", "/api/resources", resource({ title: "Algebra reference", gradeMin: "9", gradeMax: "12", sha256: SHA })), 201).id;
    ids.d = ok(await as("supt1")("POST", "/api/resources", resource({ title: "Evacuation procedures", audience: "emergency_staff", gradeMin: "k", gradeMax: "12", sha256: SHA })), 201).id;
  });

  it("nothing is published without a licence approved by someone else and a checksum", async () => {
    assert.equal((await as("supt1")("POST", `/api/resources/${ids.a}/publish`, {})).body.error, "licence_not_approved");
    assert.equal((await as("supt1")("POST", `/api/resources/${ids.a}/license-review`, { decision: "approved", note: "Checked CC BY 4.0 terms" })).body.error, "someone_else_reviews_the_licence");
    ok(await as("supt1b")("POST", `/api/resources/${ids.a}/license-review`, { decision: "approved", note: "Checked CC BY 4.0 terms; attribution shown" }));
    assert.equal((await as("supt1")("POST", `/api/resources/${ids.a}/publish`, {})).body.error, "checksum_required");
    const patched = ok(await as("supt1")("PATCH", `/api/resources/${ids.a}`, { sha256: SHA }));
    assert.equal(patched.license.status, "unreviewed", "a changed file sends the licence back for review");
    await assert.rejects(admin.query("UPDATE learning_resources SET status='published', published_at=now() WHERE id=$1", [ids.a]), /check constraint/, "the database refuses too");
    for (const id of [ids.a, ids.b, ids.c, ids.d]) ok(await as("supt1b")("POST", `/api/resources/${id}/license-review`, { decision: "approved", note: "Licence terms and attribution checked" }));
    for (const id of [ids.a, ids.b, ids.c, ids.d]) ok(await as("supt1")("POST", `/api/resources/${id}/publish`, {}));
    assert.equal((await as("supt1")("PATCH", `/api/resources/${ids.a}`, { title: "New title" })).body.error, "only_drafts_change");
    const cat = ok(await as("supt1")("GET", "/api/resources/catalog"));
    assert.equal(cat.resources.length, 4); assert.ok(cat.resources.every(r => r.status === "published" && r.license.status === "approved"));
  });

  it("the superintendent publishes a collection; a school lead chooses it for their school", async () => {
    ids.k = ok(await as("supt1")("POST", "/api/resource-collections", { name: "Grade 3 math and safety", reviewBy: "2027-06-30" }), 201).id;
    for (const id of [ids.a, ids.b, ids.c, ids.d]) ok(await as("supt1")("POST", `/api/resource-collections/${ids.k}/items`, { resourceId: id }), 201);
    assert.deepEqual(ok(await as("p1")("GET", "/api/resource-collections/available")), [], "a draft collection isn't offered");
    ok(await as("supt1")("POST", `/api/resource-collections/${ids.k}/publish`, {}));
    const avail = ok(await as("p1")("GET", "/api/resource-collections/available"));
    assert.deepEqual([avail[0].name, avail[0].items, avail[0].selected], ["Grade 3 math and safety", 4, false]);
    assert.equal((await as("t1")("POST", `/api/resource-collections/${ids.k}/select`, {})).body.error, "school_leads_only");
    for (const who of ["t1", "pu", "pa"]) assert.deepEqual(await titles(who), [], `${who} sees nothing before the school chooses`);
    ok(await as("p1")("POST", `/api/resource-collections/${ids.k}/select`, {}));
  });

  it("each person sees only what their school chose, within their audience and grade", async () => {
    assert.deepEqual(await titles("t1"), ["Algebra reference", "Evacuation procedures", "Fractions picture book", "Teaching fractions (guide)"]);
    assert.deepEqual(await titles("pa"), ["Algebra reference", "Fractions picture book"], "families: everyone-audience only");
    assert.deepEqual(await titles("pu"), ["Fractions picture book"], "a grade 3 student: their grade, everyone-audience");
    assert.equal((await as("pu")("GET", `/api/resources/${ids.b}`)).status, 404);
    assert.equal((await as("pu")("GET", `/api/resources/${ids.a}`)).body.data.license.status, undefined, "licence review notes stay with the managers");
    assert.deepEqual(await titles("p2"), [], "another school didn't choose it");
    assert.deepEqual(await titles("supt2"), [], "another district");
    assert.equal((await as("supt2")("GET", `/api/resources/${ids.a}`)).status, 404);
    assert.deepEqual(ok(await as("t1")("GET", "/api/resources?grade=10")).map(r => r.title).sort(), ["Algebra reference", "Evacuation procedures"]);
    assert.deepEqual(ok(await as("t1")("GET", "/api/resources?q=fraction")).map(r => r.title).sort(), ["Fractions picture book", "Teaching fractions (guide)"]);
  });

  it("retiring removes a resource from everyone's view; unchoosing removes the collection; all audited", async () => {
    ok(await as("supt1b")("POST", `/api/resources/${ids.a}/retire`, { reason: "Replaced by a newer edition" }));
    assert.deepEqual(await titles("pu"), []);
    ok(await as("p1")("POST", `/api/resource-collections/${ids.k}/unselect`, {}));
    assert.deepEqual(await titles("t1"), []);
    const { rows } = await admin.query("SELECT DISTINCT action FROM audit_events WHERE district_id=$1 AND resource_type LIKE 'learning_resource%'", [ID.d1]);
    for (const a of ["create", "update", "license_approved", "publish", "add_item", "select", "unselect", "retire"]) assert.ok(rows.some(r => r.action === a), a);
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role','teacher',true), set_config('app.school_id',$3,true)", [ID.d1, USERS.t1[0], ID.s1]);
      await assert.rejects(app.query("INSERT INTO learning_resources(district_id, title, resource_type, source_name, source_url, license_name, grade_min, grade_max, version, created_by) VALUES ($1,'X','pdf','S','https://x.org','L','1','2','1',$2)", [ID.d1, USERS.t1[0]]), /row-level security/);
      await app.query("ROLLBACK");
      await assert.rejects(app.query("DELETE FROM learning_resources"), /permission denied/);
    } finally { await app.end(); }
  });
});

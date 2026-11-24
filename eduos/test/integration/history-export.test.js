// TC-05 (export): downloading a copy of a student's history, against real
// PostgreSQL as the runtime role. The copy is exactly what the person can see;
// it's a direct download (no stored copy, no link); it's logged and audited;
// teachers and emergency access can't download; other students and districts
// stay closed; custody restrictions apply; limits stop bulk copying.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const CO = "a0000000-0000-4000-8000-0000000000f3";

describe("TC-05 safe export against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, owner, s = {};
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const download = async (who, format = "json", student = ID.alice) => {
    const r = await fetch(`${server.base}/api/history/export?format=${format}${student ? `&studentId=${student}` : ""}`, { headers: { cookie: s[who].cookie } });
    const text = await r.text();
    return { status: r.status, headers: r.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  const entry = (title, classification, audience, source, author, student = ID.alice, body = "") => owner.query(
    `INSERT INTO student_history_entries(district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,audience,status,source_type,author_user_id)
     VALUES ($1,$2,$3,'event',$4,$5,$6,now(),$7,'published',$8,$9)`, [ID.d1, ID.s1, student, classification, title, body, audience, source, author]);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($2,$1,'co1','Counselor S1','co1@d1.test')", [idp.issuer, CO]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($2,$1,$3,'counselor',true)", [ID.d1, CO, ID.s1]);
    await admin.query(`INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]);
    owner = new pg.Client(db.ownerUrl); await owner.connect();
    await owner.query(`SELECT set_config('app.district_id',$1,false)`, [ID.d1]);
    await entry("Report card <script>alert(1)</script>", "official_record", "school", "school", USERS.p1[0], ID.alice, "Reading: strong\nMath: growing");
    await entry("Science fair", "student_portfolio", "family", "student", USERS.pu[0]);
    await entry("Grandma's visit", "family_memory", "family", "guardian", USERS.pa[0]);
    await entry("Private note", "official_record", "private", "school", USERS.p1[0]);
    await entry("Bob's award", "official_record", "school", "school", USERS.p1[0], ID.bob);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "t1", "pa", "pb", "pu", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.co1 = await login(server.base, idp, "co1", { email: "co1@d1.test", email_verified: true });
  });
  after(async () => { await server?.stop(); await owner?.end(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a guardian's copy is exactly what they can see, as a download that isn't cached or stored", async () => {
    const r = await download("pa");
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get("content-disposition"), /^attachment; filename="history-Alice-A-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.json.format, "eduos-history-export-1");
    assert.deepEqual(r.json.items.map(i => i.title).sort(), ["Grandma's visit", "Report card <script>alert(1)</script>", "Science fair"]);
    assert.equal(r.json.exportedBy.as, "guardian");
    assert.equal(r.json.sha256, crypto.createHash("sha256").update(JSON.stringify(r.json.items)).digest("hex"));
    const view = ok(await as("pa")("GET", `/api/history/portfolio?studentId=${ID.alice}`)).items.map(i => i.title).sort();
    assert.deepEqual(r.json.items.map(i => i.title).sort(), view, "the same as the portfolio");
  });

  it("the web page escapes everything and can't run anything", async () => {
    const r = await download("pu", "html", null);
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
    assert.doesNotMatch(r.text, /<script>/);
    assert.match(r.text, /Report card &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(r.text, /Reading: strong<br>Math: growing/);
    assert.doesNotMatch(r.text, /Private note|Bob's award/);
  });

  it("teachers and emergency access read only; other students and districts stay closed", async () => {
    assert.equal((await download("t1")).json.error, "export_not_allowed");
    ok(await as("co1")("POST", `/api/students/${ID.alice}/emergency-access`, { reason: "Student in crisis; need prior safety plan on record" }), 201);
    assert.equal((await download("co1")).json.error, "export_not_allowed");
    assert.equal((await download("pb")).status, 404, "another family");
    assert.equal((await download("supt2")).status, 404, "another district");
    assert.equal((await download("pa", "json", null)).json.error, "student_required", "one student per request; no bulk");
    assert.equal((await download("pa", "pdf")).status, 400);
  });

  it("the school's leader downloads official records; every download is logged and shows under Who looked", async () => {
    const r = await download("p1");
    assert.equal(r.status, 200);
    assert.equal(r.json.exportedBy.as, "school_lead");
    const log = ok(await as("pa")("GET", `/api/students/${ID.alice}/history-access-log`));
    assert.deepEqual(log.filter(l => l.action === "export_history").map(l => l.access).sort(), ["guardian", "school_lead", "student"]);
    const audits = (await admin.query("SELECT actor_user_id FROM audit_events WHERE action='export' AND resource_type='student_history' AND resource_id=$1", [ID.alice])).rows;
    assert.equal(audits.length, 3, "guardian, student, principal");
  });

  it("five downloads per student per hour per person", async () => {
    for (let i = 0; i < 4; i++) assert.equal((await download("pa")).status, 200, `download ${i + 2}`);
    const r = await download("pa");
    assert.equal(r.status, 429); assert.equal(r.json.error, "too_many_for_this_student");
  });

  it("a custody restriction ends the guardian's downloads too", async () => {
    ok(await as("p1")("POST", `/api/students/${ID.alice}/custody-restrictions`, { userId: USERS.pa[0], kind: "court_order", basis: "Order 2026-114 received" }), 201);
    await admin.query("DELETE FROM history_access_log WHERE user_id=$1", [USERS.pa[0]]);
    assert.equal((await download("pa")).status, 404);
  });
});

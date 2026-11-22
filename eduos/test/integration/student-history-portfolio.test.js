// TC-04 portfolio through the real API: only items accepted into the history
// appear, each viewer sees only what the database rules allow, and filters,
// search and paging never widen that.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TC-04 student history portfolio", { skip }, () => {
  let db, idp, server, app, admin;
  const s = {};
  const as = name => client(server.base, s[name]);
  const ctx = async (who, role, school, fn) => {
    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true),
        set_config('app.role',$3,true), set_config('app.user_id',$4,true)`, [ID.d1, school ? ID[school] : "", role, USERS[who][0]]);
      const r = await fn(app); await app.query("COMMIT"); return r;
    } catch (e) { await app.query("ROLLBACK"); throw e; }
  };
  const entry = (c, { kind, audience, status, source, author, title, at, type = "event", id = null }) => c.query(
    `INSERT INTO student_history_entries(id,district_id,school_id,student_id,entry_type,classification,title,body,occurred_at,audience,status,source_type,author_user_id)
     VALUES(coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,'notes',$8,$9,$10,$11,$12)`,
    [id, ID.d1, ID.s1, ID.alice, type, kind, title, at, audience, status, source, author]);
  const portfolio = (who, query = "") => as(who)("GET", `/api/history/portfolio${query}`);
  const titles = r => r.body.data.items.map(i => i.title);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$3)",
      [ID.d1, ID.s1, USERS.t1[0], ID.alice]);
    app = new pg.Client(db.appUrl); await app.connect();
    // Alice's history, in every state.
    await ctx("pa", "parent", "s1", async c => {
      await entry(c, { kind: "family_memory", audience: "family", status: "published", source: "guardian", author: USERS.pa[0], title: "Family day", at: "2025-09-10T12:00:00Z" });
      await entry(c, { kind: "family_memory", audience: "private", status: "published", source: "guardian", author: USERS.pa[0], title: "Private note", at: "2025-10-01T12:00:00Z" });
      await entry(c, { kind: "family_memory", audience: "family", status: "draft", source: "guardian", author: USERS.pa[0], title: "Unfinished draft", at: "2025-10-02T12:00:00Z" });
    });
    await ctx("p1", "principal", "s1", c => entry(c, { kind: "official_record", audience: "school", status: "published", source: "school", author: USERS.p1[0],
      title: "Honor roll 100%", at: "2026-10-01T12:00:00Z", type: "achievement" }));
    // Two teacher items: one accepted by the family, one still waiting for them.
    const ids = { accepted: "c0000000-0000-4000-8000-0000000000d1", waiting: "c0000000-0000-4000-8000-0000000000d2" };
    for (const [key, title] of [["accepted", "Volcano project"], ["waiting", "Waiting for family"]]) {
      await ctx("t1", "teacher", "s1", async c => {
        await entry(c, { id: ids[key], kind: "teacher_artifact", audience: "family", status: "draft", source: "teacher", author: USERS.t1[0], title, at: "2026-10-15T12:00:00Z", type: "project" });
        await c.query("SELECT eduos_history_submit($1)", [ids[key]]);
      });
      await ctx("p1", "principal", "s1", c => c.query("SELECT eduos_history_review($1,'approve',NULL,NULL)", [ids[key]]));
    }
    await ctx("pa", "parent", "s1", c => c.query("SELECT eduos_history_family_decide($1,'accept',NULL,NULL)", [ids.accepted]));
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["pa", "pb", "pu", "t1", "p1", "p2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await app?.end(); await admin?.end(); await server?.stop(); await idp?.close(); await db?.drop?.(); });

  it("Alice's parent sees everything accepted, newest first, grouped by school year; nothing pending or in draft", async () => {
    const r = await portfolio("pa", `?studentId=${ID.alice}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(titles(r), ["Volcano project", "Honor roll 100%", "Private note", "Family day"]);
    assert.deepEqual(r.body.data.items.map(i => i.schoolYear), ["2026-27", "2026-27", "2025-26", "2025-26"]);
    assert.deepEqual(r.body.data.facets.years, ["2026-27", "2025-26"]);
    assert.equal(r.body.data.facets.total, 4);
    assert.equal(r.body.data.student.name, "Alice A");
  });

  it("Alice sees her own history without naming herself, but not her parent's private note", async () => {
    const r = await portfolio("pu");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(titles(r), ["Volcano project", "Honor roll 100%", "Family day"]);
    assert.equal(r.body.data.facets.total, 3, "the counts don't leak hidden items either");
  });

  it("her teacher sees the school record and their own item, not family memories", async () => {
    assert.deepEqual(titles(await portfolio("t1", `?studentId=${ID.alice}`)), ["Volcano project", "Honor roll 100%"]);
  });

  it("another family and another school's principal get not found", async () => {
    assert.equal((await portfolio("pb", `?studentId=${ID.alice}`)).status, 404);
    assert.equal((await portfolio("p2", `?studentId=${ID.alice}`)).status, 404);
    assert.equal((await portfolio("pb", `?studentId=${ID.bob}`)).status, 200, "Parent Bob's own child works");
  });

  it("filters and search narrow the visible items, never widen them", async () => {
    const q = (who, params) => portfolio(who, `?studentId=${ID.alice}&${params}`).then(titles);
    assert.deepEqual(await q("pa", "kind=family_memory"), ["Private note", "Family day"]);
    assert.deepEqual(await q("pa", "year=2025-26&type=event"), ["Private note", "Family day"]);
    assert.deepEqual(await q("pa", "q=honor"), ["Honor roll 100%"]);
    assert.deepEqual(await q("pa", "q=100%25"), ["Honor roll 100%"], "a % in the search is literal");
    assert.deepEqual(await q("pa", "q=%25"), ["Honor roll 100%"]);
    assert.deepEqual(await q("t1", "kind=family_memory"), [], "a filter can't reveal hidden kinds");
    assert.deepEqual(await q("t1", "q=private"), []);
    assert.equal((await portfolio("pa", `?studentId=${ID.alice}&kind=secret`)).status, 400);
    assert.equal((await portfolio("pa", `?studentId=${ID.alice}&cursor=bm9wZQ`)).status, 400);
  });

  it("pages through a long history without gaps or repeats", async () => {
    await ctx("p1", "principal", "s1", async c => {
      for (let i = 0; i < 55; i++) await entry(c, { kind: "official_record", audience: "school", status: "published", source: "school", author: USERS.p1[0],
        title: `Record ${String(i).padStart(2, "0")}`, at: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), type: "achievement" });
    });
    const seen = [];
    let cursor = null, pages = 0;
    do {
      const r = await portfolio("pa", `?studentId=${ID.alice}${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      seen.push(...titles(r)); cursor = r.body.data.nextCursor; pages++;
    } while (cursor && pages < 5);
    assert.equal(pages, 2);
    assert.equal(seen.length, 59);
    assert.equal(new Set(seen).size, 59);
  });
});

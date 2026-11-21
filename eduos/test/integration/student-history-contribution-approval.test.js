// TC-02 end to end, through the real API and the database privacy rules
// (db/088): a guardian submits a family memory, a reviewer approves it, and
// the published memory is visible to the child's family only. The reviewer
// can't read it back; another family can't see it or submit for the child.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("TC-02 approval end to end", { skip }, () => {
  let db, idp, server, app;
  const s = {};
  const as = name => client(server.base, s[name]);
  // What `who`, signed in as `role` at `school`, can read in Alice's history.
  const historyTitles = async (who, role, school) => {
    await app.query("BEGIN");
    try {
      await app.query(`SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true),
        set_config('app.role',$3,true), set_config('app.user_id',$4,true)`, [ID.d1, school ? ID[school] : "", role, USERS[who][0]]);
      return (await app.query("SELECT title FROM student_history_entries WHERE student_id=$1 ORDER BY title", [ID.alice])).rows.map(r => r.title);
    } finally { await app.query("ROLLBACK"); }
  };
  const submit = (who, title) => as(who)("POST", `/api/family/children/${ID.alice}/history-contributions`,
    { title, body: "A day to remember", occurredAt: "2026-06-01T12:00:00Z" });
  const review = (who, id, decision) => as(who)("PATCH", `/api/students/${ID.alice}/history-contributions/${id}`, { decision });

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const m = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, idp.issuer);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["pa", "pb", "p1", "supt1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await server?.stop(); await idp?.close(); await db?.drop?.(); });

  it("a principal approves; the memory reaches Alice's family only", async () => {
    const sub = await submit("pa", "First day of school");
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const ok = await review("p1", sub.body.data.id, "approve");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.status, "approved");
    assert.match(ok.body.data.history_entry_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await historyTitles("pa", "parent", "s1"), ["First day of school"], "Alice's parent sees it");
    assert.deepEqual(await historyTitles("pb", "parent", "s1"), [], "another family doesn't");
    assert.deepEqual(await historyTitles("p1", "principal", "s1"), [], "the approver can't read family memories");
  });

  it("a superintendent can approve too", async () => {
    const sub = await submit("pa", "Science fair");
    assert.equal(sub.status, 201, JSON.stringify(sub.body));
    const ok = await review("supt1", sub.body.data.id, "approve");
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(await historyTitles("pa", "parent", "s1"), ["First day of school", "Science fair"]);
  });

  it("another family can't submit for Alice, and a rejection publishes nothing", async () => {
    const other = await submit("pb", "Not my child");
    assert.equal(other.status, 404, JSON.stringify(other.body));
    const sub = await submit("pa", "Rejected memory");
    assert.equal((await review("p1", sub.body.data.id, "reject")).status, 200);
    assert.ok(!(await historyTitles("pa", "parent", "s1")).includes("Rejected memory"));
  });
});

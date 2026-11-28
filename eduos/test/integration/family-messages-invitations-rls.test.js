// SEC-01 part 2 (db/177): family messages and guardian invitations, as the runtime role.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, run, baseEnv, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const H1 = "a".repeat(64), H2 = "b".repeat(64), I1 = "1a000000-0000-4000-8000-000000000001", I2 = "1a000000-0000-4000-8000-000000000002";

describe("family messages and guardian invitations row security (177)", { skip }, () => {
  let db, admin, app;
  const as = async (who, role, school, fn, extra = {}) => {
    await app.query("BEGIN");
    try {
      await app.query("SELECT set_config('app.district_id',$1,true), set_config('app.user_id',$2,true), set_config('app.role',$3,true), set_config('app.school_id',$4,true)",
        [who === "supt2" ? ID.d2 : ID.d1, USERS[who][0], role, school || ""]);
      if (extra.token) await app.query("SELECT set_config('app.invitation_token_hash',$1,true)", [extra.token]);
      return await fn();
    } finally { await app.query("ROLLBACK"); }
  };
  const bodies = (who, role, school) => as(who, role, school, async () => (await app.query("SELECT body FROM family_messages ORDER BY body")).rows.map(r => r.body));
  const invites = (who, role, school, extra) => as(who, role, school, async () => (await app.query("SELECT id FROM guardian_invitations ORDER BY id")).rows.map(r => r.id), extra);

  before(async () => {
    db = await createDatabase();
    const m = await run(["src/migrate.js"], { ...baseEnv({ EDUOS_APP_ROLE: db.names.app }), DATABASE_URL: db.ownerUrl }); assert.equal(m.code, 0, m.out);
    await seed(db.adminUrl, "https://idp.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query(`INSERT INTO family_messages(district_id,student_id,sender_user_id,recipient_user_id,body) VALUES
      ($1,$2,$3,$4,'pa to t1 about Alice'), ($1,$2,$4,$3,'t1 to pa about Alice'), ($1,$5,$6,$4,'pb to t1 about Bob'), ($1,$7,$8,$9,'p2 to p2s about Carol')`,
      [ID.d1, ID.alice, USERS.pa[0], USERS.t1[0], ID.bob, USERS.pb[0], ID.carol, USERS.p2[0], USERS.p2s[0]]);
    await admin.query(`INSERT INTO guardian_invitations(id,district_id,school_id,student_id,invited_by,invited_email,relationship,token_hash,expires_at) VALUES
      ($1,$3,$4,$5,$6,'new.parent@d1.test','guardian',$7,now()+interval '7 days'), ($2,$3,$8,$9,$10,'other@d1.test','parent',$11,now()+interval '7 days')`,
      [I1, I2, ID.d1, ID.s1, ID.alice, USERS.p1[0], H1, ID.s2, ID.carol, USERS.p2[0], H2]);
    app = new pg.Client(db.appUrl); await app.connect();
  });
  after(async () => { await app?.end(); await admin?.end(); await db?.drop(); });

  it("messages: the sender, the recipient, and the student's school leaders", async () => {
    assert.deepEqual(await bodies("pa", "parent", ID.s1), ["pa to t1 about Alice", "t1 to pa about Alice"]);
    assert.deepEqual(await bodies("pb", "parent", ID.s1), ["pb to t1 about Bob"]);
    assert.deepEqual(await bodies("t1", "teacher", ID.s1), ["pa to t1 about Alice", "pb to t1 about Bob", "t1 to pa about Alice"]);
    assert.deepEqual(await bodies("tp", "teacher", ID.s1), [], "a teacher outside the conversation");
    assert.deepEqual(await bodies("pu", "pupil", ID.s1), []);
    assert.deepEqual(await bodies("p1", "principal", ID.s1), ["pa to t1 about Alice", "pb to t1 about Bob", "t1 to pa about Alice"], "records export at their school");
    assert.deepEqual(await bodies("p2", "principal", ID.s2), ["p2 to p2s about Carol"]);
    assert.equal((await bodies("supt1", "superintendent", null)).length, 4);
    assert.deepEqual(await bodies("supt2", "superintendent", null), []);
  });

  it("messages: send only as yourself; only the recipient marks read; a sent message can't change", async () => {
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("INSERT INTO family_messages(district_id,student_id,sender_user_id,recipient_user_id,body) VALUES($1,$2,$3,$4,'forged')",
      [ID.d1, ID.alice, USERS.t1[0], USERS.pa[0]])), /row-level security/);
    await assert.rejects(as("pu", "pupil", ID.s1, () => app.query("INSERT INTO family_messages(district_id,student_id,sender_user_id,recipient_user_id,body) VALUES($1,$2,$3,$4,'hi')",
      [ID.d1, ID.alice, USERS.pu[0], USERS.t1[0]])), /row-level security/, "students don't use family messaging");
    assert.equal(await as("pa", "parent", ID.s1, async () => (await app.query("UPDATE family_messages SET read_at=now() WHERE body='pa to t1 about Alice'")).rowCount), 0, "the sender can't mark it read");
    assert.equal(await as("t1", "teacher", ID.s1, async () => (await app.query("UPDATE family_messages SET read_at=now() WHERE body='pa to t1 about Alice'")).rowCount), 1);
    await assert.rejects(as("t1", "teacher", ID.s1, () => app.query("UPDATE family_messages SET body='edited' WHERE body='pa to t1 about Alice'")), /cannot be changed/);
  });

  it("invitations: school leaders manage their school's; a parent sees only the one whose secret they hold", async () => {
    assert.deepEqual(await invites("p1", "principal", ID.s1), [I1]);
    assert.deepEqual(await invites("vp1", "principal", ID.s1), [I1]);
    assert.deepEqual(await invites("supt1", "superintendent", null), [I1, I2]);
    assert.deepEqual(await invites("t1", "teacher", ID.s1), []);
    assert.deepEqual(await invites("pa", "parent", ID.s1), [], "no secret, nothing");
    assert.deepEqual(await invites("pa", "parent", ID.s1, { token: H1 }), [I1]);
    assert.deepEqual(await invites("pa", "parent", ID.s1, { token: "c".repeat(64) }), []);
    await assert.rejects(as("pa", "parent", ID.s1, () => app.query("UPDATE guardian_invitations SET status='accepted', accepted_by=$1, accepted_at=now() WHERE id=$2", [USERS.pb[0], I1]), { token: H1 }),
      /row-level security/, "accepted as someone else");
    assert.equal(await as("pa", "parent", ID.s1, async () => (await app.query("UPDATE guardian_invitations SET status='accepted', accepted_by=$1, accepted_at=now() WHERE id=$2", [USERS.pa[0], I1])).rowCount, { token: H1 }), 1);
    assert.equal(await as("p2", "principal", ID.s2, async () => (await app.query("UPDATE guardian_invitations SET status='revoked' WHERE id=$1", [I1])).rowCount), 0, "another school's invitation");
    await assert.rejects(as("p1", "principal", ID.s1, () => app.query(`INSERT INTO guardian_invitations(district_id,school_id,student_id,invited_by,invited_email,relationship,token_hash,expires_at)
      VALUES($1,$2,$3,$4,'x@d1.test','parent',$5,now())`, [ID.d1, ID.s2, ID.carol, USERS.p1[0], "d".repeat(64)])), /row-level security/, "for another school");
  });
});

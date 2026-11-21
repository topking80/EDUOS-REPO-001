// TC-02 real-PostgreSQL coverage for guardian contribution RLS and grants.
import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, baseEnv, run, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to run PostgreSQL integration tests";

describe("TC-02 guardian history contributions against real PostgreSQL", { skip }, () => {
  let db, admin, app;
  before(async () => {
    db = await createDatabase();
    const env = baseEnv({ EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, "https://tc02.integration.test");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    app = new pg.Client(db.appUrl); await app.connect();
    await admin.query(`
      INSERT INTO student_user_links(district_id,user_id,student_id,relationship,status)
      VALUES ($1,$2,$3,'guardian','active')
    `, [ID.d1, USERS.p2s[0], ID.carol]);
  });
  after(async () => {
    await app?.end();
    await admin?.end();
    await db?.drop();
  });

  const scoped = async (schoolId, role, userId, work) => {
    await app.query("BEGIN");
    try {
      await app.query(
        "SELECT set_config('app.district_id',$1,true), set_config('app.school_id',$2,true), set_config('app.role',$3,true), set_config('app.user_id',$4,true)",
        [ID.d1, schoolId || "", role, userId]
      );
      const value = await work();
      await app.query("COMMIT");
      return value;
    } catch (error) {
      await app.query("ROLLBACK");
      throw error;
    }
  };

  it("allows a guardian linked at another school while denying unlinked students", async () => {
    const contribution = await scoped(ID.s1, "parent", USERS.p2s[0], async () => {
      const inserted = await app.query(`
        INSERT INTO student_history_contributions
          (district_id,school_id,student_id,guardian_user_id,title,body,occurred_at)
        VALUES ($1,$2,$3,$4,'Family memory','A school milestone',now())
        RETURNING id
      `, [ID.d1, ID.s2, ID.carol, USERS.p2s[0]]);
      await assert.rejects(app.query(`
        INSERT INTO student_history_contributions
          (district_id,school_id,student_id,guardian_user_id,title,body,occurred_at)
        VALUES ($1,$2,$3,$4,'Unlinked child','Must fail',now())
      `, [ID.d1, ID.s1, ID.alice, USERS.p2s[0]]), error => error.code === "42501");
      const visible = await app.query(
        "SELECT count(*)::int AS n FROM student_history_contributions WHERE id=$1",
        [inserted.rows[0].id]
      );
      assert.equal(visible.rows[0].n, 1);
      return inserted.rows[0].id;
    });

    const hidden = await scoped(ID.s1, "principal", USERS.p1[0], async () =>
      app.query("SELECT count(*)::int AS n FROM student_history_contributions WHERE id=$1", [contribution]));
    assert.equal(hidden.rows[0].n, 0);
  });

  it("limits runtime updates to review columns and blocks destructive event-log writes", async () => {
    for (const [column, expected] of [["status", true], ["reviewed_by", true], ["review_note", true], ["title", false], ["body", false]]) {
      const result = await admin.query(
        "SELECT has_column_privilege($1,'student_history_contributions',$2,'UPDATE') AS allowed",
        [db.names.app, column]
      );
      assert.equal(result.rows[0].allowed, expected, `UPDATE privilege for ${column}`);
    }
    const deletePrivilege = await admin.query(
      "SELECT has_table_privilege($1,'student_history_contributions','DELETE') AS allowed",
      [db.names.app]
    );
    assert.equal(deletePrivilege.rows[0].allowed, false);
    const eventUpdate = await admin.query(
      "SELECT has_table_privilege($1,'student_history_contribution_events','UPDATE') AS allowed",
      [db.names.app]
    );
    assert.equal(eventUpdate.rows[0].allowed, false);
  });
});

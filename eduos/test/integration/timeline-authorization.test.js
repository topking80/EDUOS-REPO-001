// Timeline authorization foundation against real PostgreSQL, using the
// non-owner / non-BYPASSRLS runtime role. No HTTP API exists in this phase.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const COURSE = "f2000000-0000-4000-8000-000000000001";
const ENTRY = {
  parentPrivate: "f1000000-0000-4000-8000-000000000001",
  parentFamily: "f1000000-0000-4000-8000-000000000002",
  pupilPrivate: "f1000000-0000-4000-8000-000000000003",
  teacherEducators: "f1000000-0000-4000-8000-000000000004",
  teacherClassroom: "f1000000-0000-4000-8000-000000000005",
  principalSchool: "f1000000-0000-4000-8000-000000000006"
};

describe("37.10.0 Timeline authorization foundation / RLS", { skip }, () => {
  let db, idp, admin, app;
  const context = async ({ district = ID.d1, role, user, school = ID.s1 }, sql, params = []) => {
    await app.query("BEGIN");
    try {
      await app.query(
        "SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role',$3,true),set_config('app.school_id',$4,true)",
        [district, user, role, school ?? ""]
      );
      return (await app.query(sql, params)).rows;
    } finally {
      await app.query("ROLLBACK");
    }
  };
  const insert = async (actor, id, visibility, courseId = null) => context(actor,
    `INSERT INTO timeline_entries(id,district_id,school_id,student_id,course_id,created_by,entry_type,title,body,visibility,occurred_at)
     VALUES($1,$2,$3,$4,$5,$6,'reflection','A private timeline note','Test content not emitted in audit data',$7,now())
     RETURNING id`,
    [id, ID.d1, ID.s1, ID.alice, courseId, actor.user, visibility]
  );
  const ids = async actor => (await context(actor,
    "SELECT id FROM timeline_entries ORDER BY id"
  )).map(x => x.id);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query(
      "INSERT INTO teacher_student_rosters(district_id,school_id,teacher_user_id,student_id,created_by) VALUES($1,$2,$3,$4,$5)",
      [ID.d1, ID.s1, USERS.t1[0], ID.alice, USERS.p1[0]]
    );
    await admin.query(
      "INSERT INTO courses(id,district_id,school_id,teacher_user_id,title,subject,grade_level) VALUES($1,$2,$3,$4,'Timeline class','Reading','3')",
      [COURSE, ID.d1, ID.s1, USERS.t1[0]]
    );
    await admin.query(
      "INSERT INTO course_enrollments(course_id,district_id,student_id,status) VALUES($1,$2,$3,'active')",
      [COURSE, ID.d1, ID.alice]
    );
    app = new pg.Client(db.appUrl); await app.connect();
  });

  after(async () => {
    await app?.end(); await admin?.end(); await idp?.close(); await db?.drop?.();
  });

  it("migrates with FORCE RLS and explicit runtime grants; writes remain draft-only and append-only", async () => {
    const flags = (await admin.query(
      "SELECT c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.oid='timeline_entries'::regclass"
    )).rows[0];
    assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
    assert.equal((await admin.query("SELECT has_table_privilege($1,'timeline_entries','SELECT') AS v", [db.names.app])).rows[0].v, true);
    assert.equal((await admin.query("SELECT has_table_privilege($1,'timeline_entries','INSERT') AS v", [db.names.app])).rows[0].v, true);
    assert.equal((await admin.query("SELECT has_table_privilege($1,'timeline_entries','UPDATE') AS v", [db.names.app])).rows[0].v, false);
    assert.equal((await admin.query("SELECT has_table_privilege($1,'timeline_entries','DELETE') AS v", [db.names.app])).rows[0].v, false);
  });

  it("permits only scoped authors to create draft entries for their linked learner or roster", async () => {
    assert.equal((await insert({ role: "parent", user: USERS.pa[0] }, ENTRY.parentPrivate, "private")).length, 1);
    assert.equal((await insert({ role: "parent", user: USERS.pa[0] }, ENTRY.parentFamily, "family")).length, 1);
    assert.equal((await insert({ role: "pupil", user: USERS.pu[0] }, ENTRY.pupilPrivate, "private")).length, 1);
    assert.equal((await insert({ role: "teacher", user: USERS.t1[0] }, ENTRY.teacherEducators, "educators")).length, 1);
    assert.equal((await insert({ role: "teacher", user: USERS.t1[0] }, ENTRY.teacherClassroom, "classroom", COURSE)).length, 1);
    assert.equal((await insert({ role: "principal", user: USERS.p1[0] }, ENTRY.principalSchool, "school")).length, 1);
    await assert.rejects(
      insert({ role: "teacher", user: USERS.t1[0] }, "f1000000-0000-4000-8000-000000000007", "educators"),
      /row-level security|policy/i
    );
    await assert.rejects(
      context({ role: "parent", user: USERS.pa[0] },
        `INSERT INTO timeline_entries(district_id,school_id,student_id,created_by,entry_type,title,body,visibility,occurred_at)
         VALUES($1,$2,$3,$4,'reflection','Forged author','No','family',now())`,
        [ID.d1, ID.s1, ID.alice, USERS.pu[0]]),
      /row-level security|policy/i
    );
  });

  it("keeps private content private and enforces family, educator, classroom, and school audiences", async () => {
    const parent = { role: "parent", user: USERS.pa[0] };
    const pupil = { role: "pupil", user: USERS.pu[0] };
    const teacher = { role: "teacher", user: USERS.t1[0] };
    const principal = { role: "principal", user: USERS.p1[0] };
    const superintendent = { role: "superintendent", user: USERS.supt1[0], school: null };
    const parentRows = await ids(parent);
    assert.ok(parentRows.includes(ENTRY.parentPrivate));
    assert.ok(parentRows.includes(ENTRY.parentFamily));
    assert.ok(!parentRows.includes(ENTRY.pupilPrivate));
    assert.ok(!parentRows.includes(ENTRY.teacherEducators));
    const pupilRows = await ids(pupil);
    assert.ok(pupilRows.includes(ENTRY.pupilPrivate));
    assert.ok(pupilRows.includes(ENTRY.parentFamily));
    assert.ok(!pupilRows.includes(ENTRY.parentPrivate));
    const teacherRows = await ids(teacher);
    assert.ok(teacherRows.includes(ENTRY.teacherEducators));
    assert.ok(teacherRows.includes(ENTRY.teacherClassroom));
    assert.ok(!teacherRows.includes(ENTRY.parentPrivate));
    assert.ok(!teacherRows.includes(ENTRY.pupilPrivate));
    const principalRows = await ids(principal);
    assert.deepEqual(principalRows, [ENTRY.principalSchool]);
    assert.deepEqual(await ids(superintendent), []);
    assert.deepEqual(await ids({ role: "principal", user: USERS.p2[0], school: ID.s2 }), []);
    assert.deepEqual(await ids({ district: ID.d2, role: "superintendent", user: USERS.supt2[0], school: null }), []);
  });

  it("rechecks current relationships and preserves family history after a school transfer", async () => {
    await admin.query("UPDATE students SET school_id=$2 WHERE id=$1", [ID.alice, ID.s2]);
    assert.ok((await ids({ role: "parent", user: USERS.pa[0] })).includes(ENTRY.parentPrivate),
      "active guardian retains historical access after school transfer");
    await admin.query("UPDATE course_enrollments SET status='dropped' WHERE course_id=$1 AND student_id=$2", [COURSE, ID.alice]);
    await admin.query("DELETE FROM teacher_student_rosters WHERE district_id=$1 AND teacher_user_id=$2 AND student_id=$3", [ID.d1, USERS.t1[0], ID.alice]);
    const teacherRows = await ids({ role: "teacher", user: USERS.t1[0] });
    assert.ok(!teacherRows.includes(ENTRY.teacherEducators), "removed roster immediately removes educator access");
    assert.ok(!teacherRows.includes(ENTRY.teacherClassroom), "dropped enrollment immediately removes classroom access");
    await admin.query(
      "UPDATE student_user_links SET status='disabled' WHERE district_id=$1 AND user_id=$2 AND student_id=$3 AND relationship='parent'",
      [ID.d1, USERS.pa[0], ID.alice]
    );
    assert.deepEqual(await ids({ role: "parent", user: USERS.pa[0] }), [],
      "revoked guardian cannot read even entries they originally authored");
  });
});

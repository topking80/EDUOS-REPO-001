// 37.6.0 enrollment funnel against real PostgreSQL (runtime role): a family
// applies, uploads a document, the principal reviews, offers within capacity,
// waitlists the next family, the family accepts, and enrollment creates the
// student and the guardian link. Scope, the status machine, document checks
// and the FERPA purge are checked along the way.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const YEAR = "2027-28";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

describe("37.6.0 enrollment funnel against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, appA, appB;
  const as = name => client(server.base, s[name]);
  const upload = (who, id, body, type = "application/pdf", kind = "proof_of_residence") => fetch(`${server.base}/api/enrollment/applications/${id}/documents?kind=${kind}&filename=lease.pdf`, {
    method: "POST", headers: { cookie: s[who].cookie, "x-csrf-token": s[who].csrf, "content-type": type }, body }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "pa", "pb", "pu", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only families apply and only school leaders run the board", async () => {
    assert.equal((await as("pa")("GET", "/api/enrollment/options")).status, 200);
    for (const who of ["t1", "pu"]) assert.equal((await as(who)("POST", "/api/enrollment/applications", {})).status, 403, who);
    for (const who of ["t1", "pa", "pu"]) assert.equal((await as(who)("GET", "/api/enrollment/board")).status, 403, who);
    assert.equal((await as("p1")("PUT", "/api/enrollment/capacity", { schoolYear: YEAR, gradeLevel: "K", seats: 1 })).status, 200);
  });

  it("a family applies, uploads a checked document and sends it to review; others can't see it", async () => {
    const r = await as("pa")("POST", "/api/enrollment/applications", { schoolId: ID.s1, schoolYear: YEAR, gradeLevel: "K", childFirstName: "Zoe", childLastName: "Applicant", childBirthDate: "2022-03-04" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    appA = r.body.data.id;
    assert.equal(r.body.data.status, "applied");
    // Not a PDF despite the header; too large; wrong kind.
    assert.equal((await upload("pa", appA, Buffer.from("<html>hi</html>xxxx"))).status, 415);
    assert.equal((await upload("pa", appA, PDF, "application/pdf", "selfie")).status, 400);
    assert.equal((await upload("pa", appA, Buffer.concat([PDF, Buffer.alloc(2 * 1024 * 1024)]))).status, 413);
    assert.equal((await upload("pb", appA, PDF)).status, 404, "another family");
    const up = await upload("pa", appA, PDF);
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.data.filename, "lease.pdf");
    const doc = await fetch(`${server.base}/api/enrollment/documents/${up.body.data.id}`, { headers: { cookie: s.p1.cookie } });
    assert.equal(doc.status, 200);
    assert.equal(doc.headers.get("content-security-policy"), "default-src 'none'; sandbox");
    assert.deepEqual(Buffer.from(await doc.arrayBuffer()), PDF);
    for (const who of ["pb", "p2", "t1"]) assert.equal((await fetch(`${server.base}/api/enrollment/documents/${up.body.data.id}`, { headers: { cookie: s[who].cookie } })).status, who === "t1" ? 403 : 404, who);
    assert.equal((await as("pb")("GET", `/api/enrollment/applications/${appA}`)).status, 404);
    assert.equal((await as("p2")("GET", `/api/enrollment/applications/${appA}`)).status, 404, "other school's principal");
    assert.equal((await as("supt2")("GET", `/api/enrollment/applications/${appA}`)).status, 404, "other district");
    const mine = await as("pa")("GET", "/api/enrollment/mine");
    assert.equal(mine.body.data.applications[0].files.length, 1);
    assert.equal((await as("pb")("GET", "/api/enrollment/mine")).body.data.applications.length, 0);
  });

  it("the status machine: families can't offer themselves a seat; staff move it through review", async () => {
    assert.equal((await as("pa")("POST", `/api/enrollment/applications/${appA}/status`, { to: "offered" })).status, 409);
    assert.equal((await as("p1")("POST", `/api/enrollment/applications/${appA}/status`, { to: "enrolled" })).status, 400);
    assert.equal((await as("p1")("POST", `/api/enrollment/applications/${appA}/status`, { to: "review" })).status, 200);
    // The SQL trigger refuses a jump the API would never send.
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      for (const [k, v] of [["app.district_id", ID.d1], ["app.user_id", USERS.pa[0]], ["app.role", "parent"], ["app.school_id", ID.s1]]) await app.query("SELECT set_config($1,$2,true)", [k, v]);
      await assert.rejects(app.query("UPDATE enrollment_applications SET status='accepted' WHERE id=$1", [appA]), /not allowed/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
    assert.equal((await as("p1")("POST", `/api/enrollment/applications/${appA}/status`, { to: "offered" })).status, 200);
  });

  it("capacity: the next family is waitlisted when seats run out", async () => {
    const r = await as("pb")("POST", "/api/enrollment/applications", { schoolId: ID.s1, schoolYear: YEAR, gradeLevel: "K", childFirstName: "Yan", childLastName: "Second" });
    appB = r.body.data.id;
    await as("p1")("POST", `/api/enrollment/applications/${appB}/status`, { to: "review" });
    const full = await as("p1")("POST", `/api/enrollment/applications/${appB}/status`, { to: "offered" });
    assert.equal(full.status, 409);
    assert.equal(full.body.error, "no_seats_left_use_waitlist");
    assert.equal((await as("p1")("POST", `/api/enrollment/applications/${appB}/status`, { to: "waitlisted" })).status, 200);
    const mine = (await as("pb")("GET", "/api/enrollment/mine")).body.data.applications[0];
    assert.equal(mine.waitlistPosition, 1);
    const board = (await as("p1")("GET", `/api/enrollment/board?year=${YEAR}`)).body.data;
    assert.deepEqual(board.capacity.map(c => [c.grade, c.seats, c.committed, c.waitlisted, c.full]), [["K", 1, 1, 1, true]]);
    assert.equal((await as("p2")("GET", `/api/enrollment/board?year=${YEAR}`)).body.data.columns.flatMap(c => c.items).length, 0, "S2 principal sees no S1 applications");
  });

  it("the family accepts and enrollment creates the student and the guardian link", async () => {
    assert.equal((await as("p1")("POST", `/api/enrollment/applications/${appA}/enroll`, {})).status, 409, "not accepted yet");
    assert.equal((await as("pa")("POST", `/api/enrollment/applications/${appA}/status`, { to: "accepted" })).status, 200);
    const e = await as("p1")("POST", `/api/enrollment/applications/${appA}/enroll`, {});
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.match(e.body.data.studentNumber, /^ENR-2027-[0-9A-F]{8}$/);
    assert.equal(e.body.data.guardianLinked, true);
    const stu = await admin.query("SELECT display_name, grade_level, school_id FROM students WHERE id=$1", [e.body.data.studentId]);
    assert.deepEqual(stu.rows[0], { display_name: "Zoe Applicant", grade_level: "K", school_id: ID.s1 });
    const link = await admin.query("SELECT relationship FROM student_user_links WHERE student_id=$1 AND user_id=$2", [e.body.data.studentId, USERS.pa[0]]);
    assert.equal(link.rows[0].relationship, "guardian");
    const n = await admin.query("SELECT count(*)::int AS n FROM notification_outbox WHERE kind='enrollment' AND recipient_user_id=$1", [USERS.pa[0]]);
    assert.ok(n.rows[0].n >= 2);
    const events = await admin.query("SELECT to_status FROM enrollment_events WHERE application_id=$1 ORDER BY at", [appA]);
    assert.deepEqual(events.rows.map(r => r.to_status), ["applied", "review", "offered", "accepted", "enrolled"]);
    await assert.rejects(admin.query("UPDATE enrollment_events SET note='x' WHERE application_id=$1", [appA]));
    // FERPA purge removes the application, history and documents.
    await admin.query("BEGIN"); await admin.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
    const out = (await admin.query("SELECT eduos_purge_student($1) AS j", [e.body.data.studentId])).rows[0].j;
    await admin.query("COMMIT");
    assert.equal(out.enrollment_applications, 1);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM enrollment_documents WHERE application_id=$1", [appA])).rows[0].n, 0);
  });

  it("retention: the feature function runs from the retention job and removes closed applications", async () => {
    const w = await as("pb")("POST", `/api/enrollment/applications/${appB}/status`, { to: "withdrawn" });
    assert.equal(w.status, 200, JSON.stringify(w.body));
    await admin.query("ALTER TABLE enrollment_applications DISABLE TRIGGER enrollment_applications_guard");
    await admin.query("UPDATE enrollment_applications SET updated_at=now()-interval '400 days' WHERE id=$1", [appB]);
    await admin.query("ALTER TABLE enrollment_applications ENABLE TRIGGER enrollment_applications_guard");
    const r = await run(["src/retention.js"], { ...baseEnv(), DATABASE_URL: db.ownerUrl });
    assert.equal(r.code, 0, r.out);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM enrollment_applications WHERE id=$1", [appB])).rows[0].n, 0);
  });
});

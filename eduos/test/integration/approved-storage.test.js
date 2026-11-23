// TEACH-06: approved storage against real PostgreSQL, as the runtime role:
// district IT approves a teacher's storage device (the unlock code is shown
// once); a package saves only to an approved device, encrypted to it; the
// district cloud only when the superintendent turns it on; every offload is
// logged; a file opens with its code, arrives as a package from outside, and
// goes through the new district's review.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const IT = "a0000000-0000-4000-8000-0000000000f1";
const C1 = "c0000000-0000-4000-8000-0000000000c1", UA = "c0000000-0000-4000-8000-0000000000e1", L1 = "c0000000-0000-4000-8000-0000000000f1";

describe("TEACH-06 approved storage against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, pkg, drive, other, code, file;
  const as = name => client(server.base, s[name]);
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
    await q("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($2,$1,'it1','District IT','it1@d1.test')", [idp.issuer, IT]);
    await q("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($2,$1,NULL,'it_admin',true)", [ID.d1, IT]);
    await q(`INSERT INTO courses(id,district_id,school_id,teacher_user_id,title,subject,grade_level) VALUES ($1,$2,$3,$4,'Math 3','Math','3')`, [C1, ID.d1, ID.s1, USERS.t1[0]]);
    await q(`INSERT INTO course_units(id,district_id,course_id,seq,title) VALUES ($1,$2,$3,1,'Fractions')`, [UA, ID.d1, C1]);
    await q(`INSERT INTO lessons(id,district_id,course_id,unit_id,seq,title,objective,content,status,created_by) VALUES ($1,$2,$3,$4,1,'Halves','Show halves','Fold a strip in two.','published',$5)`,
      [L1, ID.d1, C1, UA, USERS.t1[0]]);
    await q(`INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($1,$2,$3,'teacher',false)`, [USERS.t1[0], ID.d2, ID.sd2]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.it1 = await login(server.base, idp, "it1", { email: "it1@d1.test", email_verified: true });
    pkg = ok(await as("t1")("POST", "/api/portfolio/packages", {}), 201);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("a teacher asks for a storage device to be approved; only district IT approves, and the unlock code is shown once", async () => {
    drive = ok(await as("t1")("POST", "/api/storage/devices", { name: "Blue drive", kind: "usb_drive", serial: "SN-42" }), 201);
    other = ok(await as("t1")("POST", "/api/storage/devices", { name: "Old laptop", kind: "laptop" }), 201);
    assert.equal((await as("t1")("POST", `/api/storage/devices/${drive.id}/decision`, { decision: "approved" })).status, 403);
    assert.equal((await as("supt1")("POST", `/api/storage/devices/${drive.id}/decision`, { decision: "approved" })).status, 403);
    assert.deepEqual(ok(await as("p1")("GET", "/api/storage/devices")).map(d => d.name).sort(), ["Blue drive", "Old laptop"], "the teacher's principal sees them");
    assert.deepEqual(ok(await as("p2")("GET", "/api/storage/devices")), []);
    assert.deepEqual(ok(await as("tp")("GET", "/api/storage/devices")), [], "another teacher sees none");
    const a = ok(await as("it1")("POST", `/api/storage/devices/${drive.id}/decision`, { decision: "approved", note: "Encrypted model" }));
    code = a.unlockCode;
    assert.match(code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/);
    assert.equal((await as("it1")("POST", `/api/storage/devices/${drive.id}/decision`, { decision: "approved" })).status, 404, "decided once");
    const stored = (await admin.query(`SELECT public_key,key_fingerprint FROM storage_devices WHERE id=$1`, [drive.id])).rows[0];
    assert.ok(stored.public_key && stored.key_fingerprint, "EduOS keeps the public key only");
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(code.replace(/-/g, "").slice(0, 12)));
  });

  it("a package saves only to the teacher's approved device, encrypted to it; the district cloud only when it's on", async () => {
    assert.equal((await as("t1")("POST", `/api/portfolio/packages/${pkg.id}/offload`, { target: "device", deviceId: other.id })).body.error, "storage_not_approved");
    assert.equal((await as("tp")("POST", `/api/portfolio/packages/${pkg.id}/offload`, { target: "device", deviceId: drive.id })).status, 404, "not their package");
    const out = ok(await as("t1")("POST", `/api/portfolio/packages/${pkg.id}/offload`, { target: "device", deviceId: drive.id }));
    file = out.file;
    assert.equal(out.device, "Blue drive");
    assert.doesNotMatch(JSON.stringify(file), /Halves|Fold a strip/, "the content is encrypted");

    assert.equal((await as("t1")("POST", `/api/portfolio/packages/${pkg.id}/offload`, { target: "cloud" })).body.error, "district_cloud_off");
    assert.equal((await as("p1")("PUT", "/api/storage/settings", { cloudEnabled: true, retentionDays: 400 })).status, 403);
    ok(await as("supt1")("PUT", "/api/storage/settings", { cloudEnabled: true, retentionDays: 400 }));
    const cloud = ok(await as("t1")("POST", `/api/portfolio/packages/${pkg.id}/offload`, { target: "cloud" }));
    assert.ok(cloud.keepUntil);
    assert.equal((await as("t1")("POST", `/api/portfolio/packages/${pkg.id}/offload`, { target: "cloud" })).status, 409, "kept once");
    assert.equal(ok(await as("t1")("GET", "/api/portfolio/cloud")).length, 1);
  });

  it("every offload is logged for IT, the superintendent and the teacher's principal", async () => {
    for (const who of ["it1", "supt1", "p1"]) assert.deepEqual(ok(await as(who)("GET", "/api/storage/offloads")).map(o => [o.owner, o.target, o.device ?? null]).sort(),
      [["Teacher S1", "cloud", null], ["Teacher S1", "device", "Blue drive"]], who);
    assert.deepEqual(ok(await as("p2")("GET", "/api/storage/offloads")), []);
    assert.equal((await as("t1")("GET", "/api/storage/offloads")).status, 403);
  });

  it("a file opens only with its code, arrives as a package from outside, and goes through the new district's review", async () => {
    // As if on another EduOS: the original package isn't there.
    ok(await as("t1")("POST", `/api/portfolio/packages/${pkg.id}/withdraw`, {}));
    const m = ok(await as("t1")("GET", "/api/memberships")).find(x => (x.district_id || x.districtId) === ID.d2);
    const sw = await as("t1")("POST", "/api/session/membership", { membershipId: m.id });
    const D2 = client(server.base, { cookie: sw.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith("eduos_session=") && !c.endsWith("=")), csrf: sw.body.csrfToken });
    const wrong = await D2("POST", "/api/portfolio/files/open", { file, code: "A".repeat(52) });
    assert.equal(wrong.body.error, "wrong_code_or_damaged_file");
    const ct = Buffer.from(file.ct, "base64"); ct[5] ^= 1;
    assert.equal((await D2("POST", "/api/portfolio/files/open", { file: { ...file, ct: ct.toString("base64") }, code })).body.error, "wrong_code_or_damaged_file");
    const opened = ok(await D2("POST", "/api/portfolio/files/open", { file, code }), 201);
    assert.deepEqual([opened.fromOutside, opened.signed, opened.signer.thisEduos, opened.items], [true, true, true, 1]);
    const listed = ok(await D2("GET", "/api/portfolio/packages")).find(p => p.id === opened.packageId);
    assert.deepEqual([listed.district, listed.fromHere], ["D1 (another EduOS)", false]);
    ok(await D2("POST", "/api/portfolio/imports", { packageId: opened.packageId }), 201);
    const waiting = ok(await as("supt2")("GET", "/api/portfolio/imports"));
    assert.deepEqual(waiting.map(i => [i.fromDistrict, i.items.map(x => x.title).join()]), [["D1 (another EduOS)", "Fractions"]]);
  });

  it("a retired device can't take new copies", async () => {
    s.t1 = await login(server.base, idp, "t1", { email_verified: true });
    const p2 = ok(await as("t1")("POST", "/api/portfolio/packages", {}), 201);
    ok(await as("t1")("POST", `/api/storage/devices/${drive.id}/retire`, {}));
    assert.equal((await as("t1")("POST", `/api/portfolio/packages/${p2.id}/offload`, { target: "device", deviceId: drive.id })).body.error, "storage_not_approved");
  });
});

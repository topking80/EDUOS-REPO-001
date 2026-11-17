// 37.6.0 marketplace against real PostgreSQL (runtime role): vendor listing ->
// privacy review -> school request -> district approval through the existing
// licensing, with the fee hook; scope and privacy gates checked throughout.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const ALL = { dpa_signed: true, coppa: true, ferpa_school_official: true, data_minimized: true, no_ads_or_profiling: true, no_tracking_or_biometrics: true, deletion_on_request: true, security_reviewed: true };

describe("37.6.0 marketplace against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, vendorId, listingId, requestId;
  const as = name => client(server.base, s[name]);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "t1", "pa", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("only the district adds vendors and listings; families and learners can't browse", async () => {
    for (const who of ["p1", "t1"]) assert.equal((await as(who)("POST", "/api/marketplace/vendors", { name: "X" })).status, 403, who);
    for (const who of ["pa", "pu"]) assert.equal((await as(who)("GET", "/api/marketplace")).status, 403, who);
    const v = await as("supt1")("POST", "/api/marketplace/vendors", { name: "MathCo", website: "https://mathco.example" });
    assert.equal(v.status, 201); vendorId = v.body.data.id;
    assert.equal((await as("supt1")("POST", "/api/marketplace/listings", { vendorId, name: "Math Garden", category: "Math", description: "Adaptive practice.", launchUrl: "http://insecure.example" })).status, 400);
    const l = await as("supt1")("POST", "/api/marketplace/listings", { vendorId, name: "Math Garden", category: "Math", description: "Adaptive practice.", launchUrl: "https://mathgarden.example/launch", dataSharingScope: "roster_basic", pricingNote: "Per seat" });
    assert.equal(l.status, 201); listingId = l.body.data.id;
  });

  it("schools don't see a listing until its privacy review is approved; approval needs every checklist item", async () => {
    assert.equal((await as("p1")("GET", "/api/marketplace")).body.data.listings.length, 0);
    assert.equal((await as("p1")("POST", `/api/marketplace/listings/${listingId}/request`, { reason: "Grade 3 math" })).status, 404);
    const partial = await as("supt1")("POST", `/api/marketplace/listings/${listingId}/review`, { status: "approved", checklist: { ...ALL, no_tracking_or_biometrics: false } });
    assert.equal(partial.status, 409);
    assert.deepEqual(partial.body.missing, ["no_tracking_or_biometrics"]);
    assert.equal((await as("supt1")("POST", `/api/marketplace/listings/${listingId}/review`, { status: "changes_requested" })).status, 400, "note required");
    assert.equal((await as("supt1")("POST", `/api/marketplace/listings/${listingId}/review`, { status: "approved", checklist: ALL, dpaExpiresOn: "2099-06-30" })).status, 200);
    const seen = (await as("t1")("GET", "/api/marketplace")).body.data.listings;
    assert.equal(seen.length, 1); assert.equal(seen[0].requestable, true);
    assert.equal((await as("supt2")("GET", "/api/marketplace")).body.data.listings.length, 0, "another district");
  });

  it("a school requests; the generic PATCH can't approve it; the district approves through licensing", async () => {
    const r = await as("t1")("POST", `/api/marketplace/listings/${listingId}/request`, { reason: "Grade 3 math practice", seats: 30, scope: "district" });
    assert.equal(r.status, 201); requestId = r.body.data.id;
    assert.equal((await as("p1")("POST", `/api/marketplace/listings/${listingId}/request`, { reason: "again" })).status, 409, "already pending at S1");
    assert.equal((await admin.query("SELECT requested_scope FROM app_requests WHERE id=$1", [requestId])).rows[0].requested_scope, "school", "teachers can't ask for the district");
    assert.equal((await as("supt1")("PATCH", `/api/app-requests/${requestId}`, { decision: "approved" })).status, 409);
    assert.equal((await as("p1")("POST", `/api/marketplace/requests/${requestId}/approve`, {})).status, 403);
    const a = await as("supt1")("POST", `/api/marketplace/requests/${requestId}/approve`, { endsOn: "2027-06-30" });
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(a.body.data.fee.status, "deferred");
    const lic = await admin.query("SELECT seat_limit, purchased_by_school_id, ends_on::text FROM app_licenses WHERE id=$1", [a.body.data.licenseId]);
    assert.deepEqual(lic.rows[0], { seat_limit: 30, purchased_by_school_id: null, ends_on: "2027-06-30" });
    const asg = await admin.query("SELECT scope, school_id FROM app_assignments WHERE id=$1", [a.body.data.assignmentId]);
    assert.deepEqual(asg.rows[0], { scope: "school", school_id: ID.s1 });
    const app = await admin.query("SELECT dpa_status, coppa_compliant, ferpa_school_official, data_sharing_scope FROM apps WHERE id=$1", [a.body.data.appId]);
    assert.deepEqual(app.rows[0], { dpa_status: "signed", coppa_compliant: true, ferpa_school_official: true, data_sharing_scope: "roster_basic" });
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM marketplace_fee_events WHERE listing_id=$1", [listingId])).rows[0].n, 1);
    assert.equal((await as("supt1")("POST", `/api/marketplace/requests/${requestId}/approve`, {})).status, 409, "not pending");
    // The app now shows in the teacher's catalog through the existing assignment.
    const apps = await as("t1")("GET", "/api/apps?limit=100");
    assert.ok(JSON.stringify(apps.body).includes("Math Garden"));
  });

  it("the database refuses to approve a marketplace request whose privacy review was withdrawn", async () => {
    const r = await as("p2")("POST", `/api/marketplace/listings/${listingId}/request`, { reason: "S2 too" });
    assert.equal(r.status, 201);
    assert.equal((await as("supt1")("POST", `/api/marketplace/listings/${listingId}/review`, { status: "in_review", checklist: ALL })).status, 200);
    assert.equal((await as("supt1")("POST", `/api/marketplace/requests/${r.body.data.id}/approve`, {})).status, 409);
    await assert.rejects(admin.query("UPDATE app_requests SET status='approved', decided_at=now() WHERE id=$1", [r.body.data.id]), /privacy review not approved/);
    // Denying still works through the existing queue.
    assert.equal((await as("supt1")("PATCH", `/api/app-requests/${r.body.data.id}`, { decision: "denied", note: "Under review" })).status, 200);
    await assert.rejects(admin.query("UPDATE marketplace_privacy_reviews SET note='x'"));
  });
});

// SAFE-04: National Weather Service prompts against real PostgreSQL, with a
// mock api.weather.gov. Off until the superintendent turns it on; only the
// school's coordinates are sent; a new matching warning alerts leaders and
// waits for a person to start or dismiss; nothing starts on its own; alerts
// that disappear end; another school or district sees nothing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const feature = (id, event, extra = {}) => ({ id, properties: { id, event, status: "Actual", messageType: "Alert", severity: "Extreme",
  headline: `${event} issued for Test County until 8:15PM`, areaDesc: "Test County", instruction: "TAKE COVER NOW!", effective: new Date().toISOString(),
  expires: new Date(Date.now() + 3600e3).toISOString(), ...extra } });

describe("SAFE-04 National Weather Service prompts against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, nws, s = {}, sweep, alert, requests = [], features = [];
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };

  before(async () => {
    nws = http.createServer((req, res) => { requests.push({ url: req.url, ua: req.headers["user-agent"] });
      res.writeHead(200, { "content-type": "application/geo+json" }); res.end(JSON.stringify({ type: "FeatureCollection", features })); });
    await new Promise(r => nws.listen(0, "127.0.0.1", r));
    process.env.WEATHER_API_TEST_BASE = `http://127.0.0.1:${nws.address().port}`;
    process.env.WEATHER_ALERTS_USER_AGENT = "EduOS test (it@d1.test)";
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "vp1", "t1", "supt1", "supt2"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    // The sweep as the API runs it: the runtime role, no session. (Importing it loads the config.)
    for (const [k, v] of Object.entries({ ...env, DATABASE_URL: db.appUrl })) if (process.env[k] === undefined) process.env[k] = v;
    const { sweepWeather } = await import("../../src/weather-alerts.js");
    const pool = new pg.Pool({ connectionString: db.appUrl, max: 2 });
    sweep = () => sweepWeather({ db: pool, log: { error: () => {} } });
    sweep.pool = pool;
  });
  after(async () => { await sweep?.pool?.end(); await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); nws?.close();
    delete process.env.WEATHER_API_TEST_BASE; delete process.env.WEATHER_ALERTS_USER_AGENT; });

  it("off until the superintendent turns it on; locations are set by the school's leaders", async () => {
    ok(await as("vp1")("PUT", "/api/safety/weather/points", { schoolId: ID.s1, lat: 39.73925, lon: -104.99031 }));
    assert.equal((await as("p1")("PUT", "/api/safety/weather/points", { schoolId: ID.s2, lat: 1, lon: 1 })).status, 404, "not another school");
    assert.equal((await as("p1")("PUT", "/api/safety/weather/points", { schoolId: ID.s1, lat: 91, lon: 0 })).body.error, "invalid_location");
    assert.equal((await as("t1")("GET", "/api/safety/weather")).status, 403);
    assert.equal((await as("p1")("PUT", "/api/safety/weather/settings", { enabled: true })).status, 403);
    features = [feature("urn:oid:1", "Tornado Warning")];
    assert.equal((await sweep()).schools, 0, "off: nothing is asked");
    assert.equal(requests.length, 0);
    ok(await as("supt1")("PUT", "/api/safety/weather/settings", { enabled: true }));
    const d = ok(await as("p1")("GET", "/api/safety/weather"));
    assert.equal(d.enabled, true); assert.deepEqual(d.schools.map(x => [x.name, x.lat, x.lon]), [["S1", 39.7393, -104.9903]]);
  });

  it("a sweep sends only the coordinates; a tornado warning prompts the leaders and starts nothing", async () => {
    features = [feature("urn:oid:1", "Tornado Warning"), feature("urn:oid:2", "Wind Advisory"), feature("urn:oid:3", "Test Message", { status: "Test" })];
    const r = await sweep();
    assert.deepEqual([r.schools, r.newWarnings, r.failed], [1, 1, 0]);
    assert.deepEqual(requests.map(x => x.url), ["/alerts/active?point=39.7393%2C-104.9903"]);
    assert.equal(requests[0].ua, "EduOS test (it@d1.test)");
    for (const u of [USERS.p1[0], USERS.vp1[0], USERS.supt1[0]])
      assert.ok((await admin.query("SELECT 1 FROM notification_outbox WHERE recipient_user_id=$1 AND title LIKE 'Tornado Warning for S1%'", [u])).rowCount, u);
    assert.equal((await admin.query("SELECT 1 FROM notification_outbox WHERE recipient_user_id=$1 AND title LIKE 'Tornado Warning%'", [USERS.t1[0]])).rowCount, 0, "not teachers");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM safety_incidents")).rows[0].n, 0, "nothing starts on its own");
    const st = ok(await as("p1")("GET", "/api/safety/status"));
    assert.deepEqual(st.weather.map(w => [w.event, w.hazard, w.suggestedKind, w.prompt]), [["Tornado Warning", "tornado", "shelter", true]]);
    alert = st.weather[0];
    assert.equal(ok(await as("t1")("GET", "/api/safety/status")).weather.length, 0, "teachers aren't prompted");
    assert.equal(ok(await as("p2")("GET", "/api/safety/status")).weather.length, 0, "another school");
    assert.equal(ok(await as("supt2")("GET", "/api/safety/status")).weather.length, 0, "another district");
    const all = ok(await as("p1")("GET", "/api/safety/weather")).alerts;
    assert.deepEqual(all.map(a => [a.event, a.level, a.prompt]).sort(), [["Tornado Warning", "warning", true], ["Wind Advisory", "advisory", false]]);
    assert.equal((await sweep()).newWarnings, 0, "the same warning doesn't alert twice");
  });

  it("a leader starts the shelter from it (the usual two steps), and it's recorded", async () => {
    const i = ok(await as("vp1")("POST", "/api/safety/incidents", { kind: "shelter", isDrill: false, hazard: "tornado" }), 201);
    ok(await as("vp1")("POST", `/api/safety/incidents/${i.id}/confirm`, { kind: "shelter", isDrill: false, hazard: "tornado" }));
    const other = ok(await as("p2")("POST", "/api/safety/incidents", { kind: "hold", isDrill: true }), 201);
    assert.equal((await as("p2")("POST", `/api/safety/weather/${alert.id}/started`, { incidentId: other.id })).status, 404, "another school's leader");
    assert.equal((await as("vp1")("POST", `/api/safety/weather/${alert.id}/started`, { incidentId: other.id })).body.error, "incident_does_not_match");
    ok(await as("vp1")("POST", `/api/safety/weather/${alert.id}/started`, { incidentId: i.id }));
    assert.equal((await as("p1")("POST", `/api/safety/weather/${alert.id}/dismiss`, { note: "too late" })).body.error, "already_decided");
    assert.equal(ok(await as("p1")("GET", "/api/safety/status")).weather.length, 0, "no longer waiting");
    ok(await as("p1")("POST", `/api/safety/incidents/${i.id}/all-clear`, { kind: "shelter" }));
  });

  it("another warning is dismissed with a reason; warnings NWS drops end", async () => {
    features = [feature("urn:oid:1", "Tornado Warning"), feature("urn:oid:4", "Severe Thunderstorm Warning")];
    assert.equal((await sweep()).newWarnings, 1);
    const w = ok(await as("supt1")("GET", "/api/safety/status")).weather;
    assert.deepEqual(w.map(x => x.event), ["Severe Thunderstorm Warning"]);
    assert.equal((await as("p1")("POST", `/api/safety/weather/${w[0].id}/dismiss`, { note: "" })).body.error, "note_required");
    ok(await as("p1")("POST", `/api/safety/weather/${w[0].id}/dismiss`, { note: "Storm cell north of our area" }));
    features = [];
    await sweep();
    assert.equal(ok(await as("p1")("GET", "/api/safety/weather")).alerts.length, 0, "ended");
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM school_weather_alerts WHERE ended_at IS NOT NULL")).rows[0].n, 3, "kept, ended");
  });

  it("the runtime role can't write alerts directly; NWS errors don't stop the sweep", async () => {
    const app = new pg.Client(db.appUrl); await app.connect();
    try {
      await app.query("BEGIN");
      await app.query(`SELECT set_config('app.district_id',$1,true),set_config('app.user_id',$2,true),set_config('app.role','principal',true),set_config('app.school_id',$3,true)`, [ID.d1, USERS.p1[0], ID.s1]);
      await assert.rejects(app.query(`INSERT INTO school_weather_alerts(district_id,school_id,nws_id,event,level) VALUES ($1,$2,'x','Tornado Warning','warning')`, [ID.d1, ID.s1]), /permission denied|row-level security/);
      await app.query("ROLLBACK");
    } finally { await app.end(); }
    const { sweepWeather } = await import("../../src/weather-alerts.js");
    const r = await sweepWeather({ db: sweep.pool, log: { error: () => {} }, fetchAlertsImpl: async () => { throw new Error("NWS answered 503"); } });
    assert.deepEqual([r.locations, r.failed], [1, 1]);
  });

  it("refreshes all guidance fields when NWS updates an existing alert ID", async () => {
    features = [feature("urn:oid:8", "Tornado Warning")];
    await sweep();
    const first = ok(await as("p1")("GET", "/api/safety/weather")).alerts.find(x => x.event === "Tornado Warning");
    features = [feature("urn:oid:8", "Tornado Warning", {
      severity: "Moderate", headline: "Updated tornado warning", areaDesc: "Updated County",
      instruction: "Move to the lowest interior room immediately",
      expires: new Date(Date.now() + 7200e3).toISOString()
    })];
    await sweep();
    const updated = ok(await as("p1")("GET", "/api/safety/weather")).alerts.find(x => x.id === first.id);
    assert.equal(updated.severity, "Moderate");
    assert.equal(updated.headline, "Updated tornado warning");
    assert.equal(updated.area, "Updated County");
    assert.equal(updated.instruction, "Move to the lowest interior room immediately");
  });

  it("allows only one simultaneous leader decision and rejects ended or expired alerts", async () => {
    features = [feature("urn:oid:9", "Tornado Warning")];
    await sweep();
    const concurrent = ok(await as("p1")("GET", "/api/safety/weather")).alerts.find(x => x.event === "Tornado Warning");
    const [oneDecision, otherDecision] = await Promise.all([
      as("p1")("POST", `/api/safety/weather/${concurrent.id}/dismiss`, { note: "Reviewed by principal" }),
      as("vp1")("POST", `/api/safety/weather/${concurrent.id}/dismiss`, { note: "Reviewed by vice principal" })
    ]);
    assert.deepEqual([oneDecision.status, otherDecision.status].sort(), [200, 409]);

    features = [feature("urn:oid:10", "Tornado Warning")];
    await sweep();
    const ended = ok(await as("p1")("GET", "/api/safety/weather")).alerts.find(x => x.event === "Tornado Warning");
    features = [];
    await sweep();
    assert.equal((await as("p1")("POST", `/api/safety/weather/${ended.id}/dismiss`, { note: "Late action" })).status, 410);

    features = [feature("urn:oid:11", "Tornado Warning")];
    await sweep();
    const expired = ok(await as("p1")("GET", "/api/safety/weather")).alerts.find(x => x.event === "Tornado Warning");
    await admin.query("UPDATE school_weather_alerts SET expires=now()-interval '1 minute' WHERE id=$1", [expired.id]);
    assert.equal((await as("p1")("POST", `/api/safety/weather/${expired.id}/dismiss`, { note: "Late action" })).status, 410);
  });
});

// SPORTS-02: MaxPreps / Hudl connectors against real PostgreSQL and a mock
// vendor: sports leads connect the school's account, IT approves, nothing
// moves before; the roster sent holds only opted-in athletes; results come back
// for the coach to approve as a draft; film comes back as Hudl links; a changed
// key needs approving again; keys are encrypted and never returned.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client, freePort } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const IT = "a0000000-0000-4000-8000-0000000000f1";
const KEY = "hudl-partner-token-0123456789";

describe("SPORTS-02 sports connectors against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, vendor, base, s = {}, team, event, conn, seen = [], offerFilm = true;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };

  before(async () => {
    // The mock vendor: records what it's sent, returns results and film.
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    vendor = http.createServer((req, res) => {
      let body = ""; req.on("data", d => { body += d; });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end("{}"); }
        if (req.url.endsWith("/film") && !offerFilm) { res.writeHead(404); return res.end("{}"); }
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url.endsWith("/results")) return res.end(JSON.stringify({ results: [
          { ref: event, opponent: "Central", homeScore: 3, awayScore: 1, teamStats: { shots: 12, corners: 5, "bad key!": 1, playerName: "x" } },
          { ref: "00000000-0000-4000-8000-000000000000", opponent: "Not ours", homeScore: 1, awayScore: 0 }] }));
        if (req.url.endsWith("/film")) return res.end(JSON.stringify({ film: [{ ref: event, title: "Home opener: full game", url: "https://www.hudl.com/video/3/123" },
          { title: "Elsewhere", url: "https://example.org/video" }] }));
        res.end("{}");
      });
    });
    await new Promise(r => vendor.listen(port, "127.0.0.1", r));

    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, INTEGRATIONS_KEY: "i".repeat(40), SPORTS_CONNECTOR_TEST_BASE: base });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("INSERT INTO users(id,oidc_issuer,oidc_subject,display_name,email) VALUES ($2,$1,'it1','District IT','it1@d1.test')", [idp.issuer, IT]);
    await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES ($2,$1,NULL,'it_admin',true)", [ID.d1, IT]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    s.it1 = await login(server.base, idp, "it1", { email: "it1@d1.test", email_verified: true });
    team = ok(await as("p1")("POST", "/api/activities", { kind: "sport", title: "Varsity Soccer", status: "published" }), 201);
    ok(await as("p1")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" }), 201);
    await admin.query(`INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,jersey_number,position,added_by) VALUES
      ($1,$2,$3,$4,9,'Forward',$6),($1,$2,$3,$5,4,'Keeper',$6)`, [ID.d1, ID.s1, team.id, ID.alice, ID.bob, USERS.p1[0]]);
    event = (await admin.query(`INSERT INTO school_events(district_id,school_id,activity_id,title,starts_at,ends_at,venue,status,created_by)
      VALUES ($1,$2,$3,'Home opener','2026-09-05 22:00+00','2026-09-06 00:00+00','Main field','completed',$4) RETURNING id`, [ID.d1, ID.s1, team.id, USERS.p1[0]])).rows[0].id;
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); vendor?.close(); });

  it("a sports lead connects the school's account; only IT approves; the key is never returned", async () => {
    const body = { service: "hudl", baseUrl: base, key: KEY, sendRoster: true, sendSchedule: true, pullResults: true, pullFilm: true };
    assert.equal((await as("t1")("POST", "/api/sports/connectors", body)).body.error, "sports_leads_only", "a coach isn't the school's sports lead");
    assert.equal((await as("p1")("POST", "/api/sports/connectors", { ...body, baseUrl: "https://example.org/api" })).body.error, "invalid_connector", "the vendor's site only");
    assert.equal((await as("p1")("POST", "/api/sports/connectors", { ...body, service: "maxpreps", pullFilm: true })).body.error, "invalid_connector", "film is Hudl's");
    conn = ok(await as("p1")("POST", "/api/sports/connectors", body), 201);
    assert.deepEqual([conn.status, conn.keyHint], ["pending", "…6789"]);
    assert.doesNotMatch(JSON.stringify(ok(await as("it1")("GET", "/api/sports/connectors"))), new RegExp(KEY));
    const stored = (await admin.query(`SELECT secret_enc FROM sports_connectors WHERE id=$1`, [conn.id])).rows[0].secret_enc;
    assert.ok(!stored.includes(KEY), "encrypted at rest");
    assert.deepEqual(ok(await as("p2")("GET", "/api/sports/connectors")), [], "another school's");
    ok(await as("t1")("PUT", `/api/activities/${team.id}/connectors/hudl/team`, { externalTeamId: "team-123" }));
    assert.equal((await as("t1")("POST", `/api/activities/${team.id}/connectors/hudl/sync`, {})).body.error, "connector_not_approved", "nothing moves before IT approves");
    assert.equal(seen.length, 0);
    assert.equal((await as("p1")("POST", `/api/sports/connectors/${conn.id}/decision`, { decision: "approved" })).status, 403);
    ok(await as("it1")("POST", `/api/sports/connectors/${conn.id}/decision`, { decision: "approved", note: "Checked the account" }));
  });

  it("a sync sends the opted-in roster and the schedule, and brings results and film back", async () => {
    await admin.query(`INSERT INTO athlete_sharing_consents(district_id,school_id,student_id,service,granted_by) VALUES ($1,$2,$3,'hudl',$4)`, [ID.d1, ID.s1, ID.alice, USERS.pa[0]]);
    const out = ok(await as("t1")("POST", `/api/activities/${team.id}/connectors/hudl/sync`, {}));
    assert.deepEqual(out.results.map(r => [r.action, r.ok, r.count, r.withheld]), [["send_roster", true, 1, 1], ["send_schedule", true, 1, 0], ["pull_results", true, 1, 0], ["pull_film", true, 1, 0]]);
    const roster = seen.find(x => x.url === "/eduos/v1/teams/team-123/roster");
    assert.equal(roster.auth, `Bearer ${KEY}`);
    assert.deepEqual(roster.body.athletes, [{ jersey: 9, firstName: "Alice", lastName: "A", grade: "3", position: "Forward" }], "only the opted-in athlete");
    assert.equal(seen.find(x => x.url.endsWith("/schedule")).body.events[0].ref, event);

    const v = ok(await as("t1")("GET", `/api/activities/${team.id}/connectors`));
    assert.deepEqual(v.waiting.map(w => [w.opponent, w.homeScore, w.awayScore, w.teamStats]), [["Central", 3, 1, { shots: 12, corners: 5 }]], "team totals only");
    assert.deepEqual(v.film.map(f => f.url), ["https://www.hudl.com/video/3/123"], "Hudl links only");
    assert.equal((await admin.query(`SELECT count(*)::int AS n FROM activity_event_results`)).rows[0].n, 0, "nothing published by the vendor");
    assert.deepEqual(ok(await as("pa")("GET", `/api/activities/${team.id}/film`)).map(f => [f.title, f.event]), [["Home opener: full game", "Home opener"]]);

    // An account that doesn't offer film: the rest still runs; film says "not offered", not a failure.
    offerFilm = false;
    const partial = ok(await as("t1")("POST", `/api/activities/${team.id}/connectors/hudl/sync`, {}));
    assert.deepEqual(partial.results.map(r => [r.action, r.ok, r.offered]), [["send_roster", true, true], ["send_schedule", true, true], ["pull_results", true, true], ["pull_film", false, false]]);
    assert.equal(partial.results[3].message, "not offered by this account");
    offerFilm = true;
  });

  it("the coach approves a result into a draft; hides film; others can't", async () => {
    const v = ok(await as("t1")("GET", `/api/activities/${team.id}/connectors`));
    assert.equal((await as("tp")("POST", `/api/sports/inbound/${v.waiting[0].id}/decision`, { decision: "approved" })).status, 404);
    ok(await as("t1")("POST", `/api/sports/inbound/${v.waiting[0].id}/decision`, { decision: "approved" }));
    const r = (await admin.query(`SELECT status,home_score,away_score,summary FROM activity_event_results WHERE event_id=$1`, [event])).rows[0];
    assert.deepEqual([r.status, r.home_score, r.away_score, r.summary], ["draft", 3, 1, "Team stats: shots 12, corners 5"]);
    ok(await as("t1")("POST", `/api/sports/film/${v.film[0].id}/hide`, {}));
    assert.deepEqual(ok(await as("pa")("GET", `/api/activities/${team.id}/film`)), []);
  });

  it("changing the key needs approving again; pause, resume and revoke; every run is logged", async () => {
    const changed = ok(await as("p1")("PUT", `/api/sports/connectors/${conn.id}`, { baseUrl: base, key: "a-new-token-987654", sendRoster: true, sendSchedule: true, pullResults: true, pullFilm: true }));
    assert.deepEqual([changed.status, changed.keyHint], ["pending", "…7654"]);
    assert.equal((await as("t1")("POST", `/api/activities/${team.id}/connectors/hudl/sync`, {})).body.error, "connector_not_approved");
    ok(await as("it1")("POST", `/api/sports/connectors/${conn.id}/decision`, { decision: "approved" }));
    const bad = ok(await as("t1")("POST", `/api/activities/${team.id}/connectors/hudl/sync`, {}));
    assert.ok(bad.results.every(r => !r.ok && /refused the key/.test(r.message)), "the vendor refused the new key: logged, nothing stored");
    ok(await as("p1")("POST", `/api/sports/connectors/${conn.id}/pause`, {}));
    assert.equal((await as("t1")("POST", `/api/activities/${team.id}/connectors/hudl/sync`, {})).body.error, "connector_not_approved");
    ok(await as("p1")("POST", `/api/sports/connectors/${conn.id}/resume`, {}));
    ok(await as("p1")("POST", `/api/sports/connectors/${conn.id}/revoke`, {}));
    assert.equal((await as("t1")("POST", `/api/activities/${team.id}/connectors/hudl/sync`, {})).body.error, "connector_not_set_up");
    const runs = (await admin.query(`SELECT count(*)::int AS n FROM sports_connector_runs`)).rows[0].n;
    assert.equal(runs, 12);
  });
});

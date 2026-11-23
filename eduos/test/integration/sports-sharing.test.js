// SPORTS-01: MaxPreps / Hudl against real PostgreSQL, as the runtime role:
// team links on those sites only; families opt each child in or out per
// service; roster files hold only opted-in athletes and can't carry formulas;
// schedule files carry published results; every export is logged.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("SPORTS-01 MaxPreps and Hudl against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, team;
  const as = name => client(server.base, s[name]);
  const ok = (r, code = 200) => { assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data; };
  const file = async (who, service, kind) => {
    const r = await fetch(`${server.base}/api/activities/${team.id}/exports/${service}/${kind}.csv`, { headers: { cookie: s[who].cookie } });
    return { status: r.status, text: await r.text(), withheld: r.headers.get("x-withheld-count"), type: r.headers.get("content-type"), disposition: r.headers.get("content-disposition") };
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["p1", "p2", "t1", "tp", "pa", "pb", "pu", "supt1"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    team = ok(await as("p1")("POST", "/api/activities", { kind: "sport", title: "Varsity Soccer", status: "published" }), 201);
    ok(await as("p1")("POST", `/api/activities/${team.id}/staff`, { userId: USERS.t1[0], staffRole: "coach" }), 201);
    await admin.query(`INSERT INTO activity_roster_entries(district_id,school_id,activity_id,student_id,jersey_number,position,added_by) VALUES
      ($1,$2,$3,$4,9,'Forward',$6),($1,$2,$3,$5,4,'Keeper',$6)`, [ID.d1, ID.s1, team.id, ID.alice, ID.bob, USERS.p1[0]]);
    const ev = (await admin.query(`INSERT INTO school_events(district_id,school_id,activity_id,title,starts_at,ends_at,venue,status,created_by)
      VALUES ($1,$2,$3,'Home opener','2026-09-05 22:00+00','2026-09-06 00:00+00','Main field','completed',$4) RETURNING id`, [ID.d1, ID.s1, team.id, USERS.p1[0]])).rows[0].id;
    await admin.query(`INSERT INTO activity_event_results(district_id,school_id,activity_id,event_id,opponent,home_score,away_score,status,recorded_by)
      VALUES ($1,$2,$3,$4,'Central',3,1,'published',$5)`, [ID.d1, ID.s1, team.id, ev, USERS.t1[0]]);
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("the team's coach links MaxPreps and Hudl pages, on those sites only; everyone at the school sees them", async () => {
    ok(await as("t1")("PUT", `/api/activities/${team.id}/links/maxpreps`, { url: "https://www.maxpreps.com/ny/x/varsity-soccer/" }));
    assert.equal((await as("t1")("PUT", `/api/activities/${team.id}/links/hudl`, { url: "https://www.maxpreps.com/x" })).body.error, "link_must_be_on_that_service");
    ok(await as("p1")("PUT", `/api/activities/${team.id}/links/hudl`, { url: "https://www.hudl.com/team/v2/123" }));
    assert.equal((await as("tp")("PUT", `/api/activities/${team.id}/links/hudl`, { url: "https://www.hudl.com/team/v2/9" })).body.error, "team_managers_only");
    assert.deepEqual(ok(await as("pu")("GET", `/api/activities/${team.id}/links`)).map(l => [l.name, l.url]),
      [["Hudl", "https://www.hudl.com/team/v2/123"], ["MaxPreps", "https://www.maxpreps.com/ny/x/varsity-soccer/"]]);
    assert.equal((await as("p2")("GET", `/api/activities/${team.id}/links`)).status, 404, "another school's");
  });

  it("families opt each child in or out per service", async () => {
    const mine = ok(await as("pa")("GET", "/api/family/sports-sharing"));
    assert.deepEqual(mine.map(k => [k.name, k.teams, k.maxpreps, k.hudl]), [["Alice A", ["Varsity Soccer"], null, null]]);
    ok(await as("pa")("PUT", `/api/family/sports-sharing/${ID.alice}`, { maxpreps: true }));
    assert.equal(ok(await as("pa")("GET", "/api/family/sports-sharing"))[0].maxpreps.by, "Parent A");
    assert.equal((await as("pa")("PUT", `/api/family/sports-sharing/${ID.bob}`, { maxpreps: true })).status, 404, "not their child");
    assert.equal((await as("t1")("PUT", `/api/family/sports-sharing/${ID.alice}`, { maxpreps: true })).status, 403);
  });

  it("a roster file holds only opted-in athletes, and nothing a spreadsheet would run", async () => {
    const sum = ok(await as("t1")("GET", `/api/activities/${team.id}/exports`));
    assert.deepEqual(sum.services, { maxpreps: { included: 1, withheld: 1 }, hudl: { included: 0, withheld: 2 } });
    await admin.query(`UPDATE activity_roster_entries SET position='=HYPERLINK("http://x")' WHERE student_id=$1`, [ID.alice]);
    const mp = await file("t1", "maxpreps", "roster");
    assert.equal(mp.status, 200);
    assert.match(mp.type, /text\/csv/); assert.match(mp.disposition, /Varsity-Soccer-maxpreps-roster\.csv/);
    assert.equal(mp.text, `Jersey,First Name,Last Name,Grade,Position\r\n9,Alice,A,3,"'=HYPERLINK(""http://x"")"\r\n`);
    assert.equal(mp.withheld, "1");
    const hudl = await file("t1", "hudl", "roster");
    assert.equal(hudl.text, "Jersey,First Name,Last Name,Grade,Position\r\n", "no one opted in for Hudl");
    ok(await as("pa")("PUT", `/api/family/sports-sharing/${ID.alice}`, { maxpreps: false }));
    assert.doesNotMatch((await file("t1", "maxpreps", "roster")).text, /Alice/, "opting out takes effect on the next file");
  });

  it("the schedule file carries published results; only the team's managers export; every export is logged", async () => {
    const sch = await file("p1", "maxpreps", "schedule");
    assert.equal(sch.text, "Date,Time,Event,Opponent,Venue,Home Score,Away Score\r\n2026-09-05,22:00 UTC,Home opener,Central,Main field,3,1\r\n");
    for (const who of ["tp", "pa", "pu"]) assert.ok([403, 404].includes((await file(who, "maxpreps", "roster")).status), who);
    assert.equal((await file("t1", "other", "roster")).status, 404);
    const log = ok(await as("t1")("GET", `/api/activities/${team.id}/exports`)).log;
    assert.deepEqual(log.map(l => [l.service, l.kind, l.included, l.withheld]).reverse(),
      [["maxpreps", "roster", 1, 1], ["hudl", "roster", 0, 2], ["maxpreps", "roster", 0, 2], ["maxpreps", "schedule", 1, 0]]);
  });
});

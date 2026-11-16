// Transport hydration is batched (PR #32): the number of queries for a
// school's runs doesn't grow with the number of routes, stops or riders, and
// the answer is the same as building each route on its own. Against real
// PostgreSQL.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, baseEnv, run, createDatabase, seed } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("batched transport hydration against real PostgreSQL", { skip }, () => {
  let db, admin, routeDetails;
  const counting = () => {
    const c = { n: 0, query: (...a) => { c.n++; return admin.query(...a); } };
    return c;
  };

  before(async () => {
    db = await createDatabase();
    const env = baseEnv({ EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, "http://127.0.0.1:9");
    admin = new pg.Client(db.adminUrl); await admin.connect();
    await admin.query("SELECT set_config('app.district_id',$1,false)", [ID.d1]);
    Object.assign(process.env, { ...env, DATABASE_URL: db.appUrl });
    ({ routeDetails } = await import("../../src/transport-routes.js"));
    // Six routes at S1, three stops each; Alice and Bob ride the first two; runs today with check-ins.
    for (let i = 0; i < 6; i++) {
      const r = (await admin.query(`INSERT INTO transport_routes(district_id,school_id,name,bus_label,direction,created_by) VALUES($1,$2,$3,$4,'am',$5) RETURNING id`,
        [ID.d1, ID.s1, `Route ${i}`, `Bus ${i}`, USERS.p1[0]])).rows[0].id;
      const stops = [];
      for (let k = 0; k < 3; k++) stops.push((await admin.query(`INSERT INTO transport_stops(district_id,school_id,route_id,seq,name,is_school) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [ID.d1, ID.s1, r, k + 1, `Stop ${i}.${k}`, k === 2])).rows[0].id);
      if (i < 2) for (const st of [ID.alice, ID.bob]) await admin.query(`INSERT INTO transport_rider_assignments(district_id,school_id,route_id,student_id,stop_id,created_by) VALUES($1,$2,$3,$4,$5,$6)`,
        [ID.d1, ID.s1, r, st, stops[0], USERS.p1[0]]);
      const runId = (await admin.query(`INSERT INTO transport_runs(district_id,school_id,route_id,service_date,driver_user_id,status) VALUES($1,$2,$3,eduos_school_today($2),$4,'in_progress') RETURNING id`,
        [ID.d1, ID.s1, r, USERS.p1[0]])).rows[0].id;
      if (i === 0) {
        await admin.query(`INSERT INTO transport_checkins(district_id,school_id,run_id,student_id,stop_id,event,recorded_by) VALUES($1,$2,$3,$4,$5,'boarded',$6)`, [ID.d1, ID.s1, runId, ID.alice, stops[0], USERS.p1[0]]);
        await admin.query(`INSERT INTO transport_checkins(district_id,school_id,run_id,student_id,stop_id,event,recorded_by) VALUES($1,$2,$3,$4,$5,'not_riding',$6)`, [ID.d1, ID.s1, runId, ID.bob, stops[0], USERS.p1[0]]);
      }
    }
  });
  after(async () => { await admin?.end(); await db?.drop?.(); });

  const routes = async n => (await admin.query("SELECT id,name,bus_label,direction,school_id FROM transport_routes WHERE school_id=$1 ORDER BY name LIMIT $2", [ID.s1, n])).rows;

  it("the query count doesn't grow with routes, stops or riders", async () => {
    const one = counting(), six = counting(), none = counting();
    await routeDetails(one, await routes(1), { withRiders: true });
    await routeDetails(six, await routes(6), { withRiders: true });
    await routeDetails(none, [], { withRiders: true });
    assert.equal(one.n, six.n, `${one.n} queries for one route, ${six.n} for six`);
    assert.ok(six.n <= 4, `${six.n} queries`);
    assert.equal(none.n, 0);
    const lean = counting();
    await routeDetails(lean, await routes(6), { withRiders: false });
    assert.equal(lean.n, 2, "stops and runs only");
  });

  it("each route's stops, run, riders and counts are its own, in the same shape as before", async () => {
    const out = await routeDetails(counting(), await routes(6), { withRiders: true });
    assert.equal(out.length, 6);
    const [r0, r1, r2] = out;
    assert.deepEqual(r0.stops.map(s => s.name), ["Stop 0.0", "Stop 0.1", "Stop 0.2"]);
    assert.ok(r0.stops.every(s => !("route_id" in s)), "no extra field on stops");
    assert.deepEqual(Object.keys(r0.stops[0]).sort(), ["id", "is_school", "name", "riders", "seq", "time"]);
    assert.deepEqual(r0.counts, { riders: 2, boarded: 1, alighted: 0, notRiding: 1, onBoard: 1, expected: 0 });
    assert.deepEqual(r0.stops[0].riders.map(r => [r.name, r.status]), [["Alice A", "boarded"], ["Bob B", "not_riding"]]);
    assert.deepEqual(r1.counts, { riders: 2, boarded: 0, alighted: 0, notRiding: 0, onBoard: 0, expected: 2 }, "route 1's check-ins don't leak from route 0");
    assert.deepEqual(r2.counts, { riders: 0, boarded: 0, alighted: 0, notRiding: 0, onBoard: 0, expected: 0 });
    assert.ok(out.every(r => r.run && r.run.status === "in_progress"));
  });
});

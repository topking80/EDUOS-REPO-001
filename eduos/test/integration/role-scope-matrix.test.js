// Role and tenant scope matrix (release gate 2), against real PostgreSQL as
// the runtime role.
//
// Every GET route the API registers is called as every role at school S1 (and
// as District 2's superintendent), with path parameters pointing at School 2
// or District 2 records. No response may contain a School 2 learner, School 2
// safety instructions or a School 2 bus route, and District 2 may see nothing
// of District 1. Then the specific findings of the 2026-11-16 audit:
// vice principals see their school only, parents see safety incidents only at
// their children's schools, the day's attendance covers families, and no
// other database role can call the SECURITY DEFINER functions.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const SRC = new URL("../../src/", import.meta.url).pathname;
const MARK = "S2-ONLY-INSTRUCTIONS", ROUTE = "S2-ONLY-ROUTE";
const EXTRA = {
  "vp-x": "vice_principal", "counselor-x": "counselor", "nurse-x": "nurse", "librarian-x": "librarian",
  "sro-x": "sro", "driver-x": "driver", "itadmin-x": "it_admin"
};

/** Every GET route registered under /api, from the source. */
function getRoutes() {
  const files = [];
  const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") && files.push(p); } };
  walk(SRC);
  const routes = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/app\.get\(\s*"(\/api\/[^"]+)"/g)) routes.add(m[1]);
  return [...routes].sort();
}

describe("role and tenant scope matrix against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s2Incident, s = {};
  const as = name => client(server.base, s[name]);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    for (const [sub, role] of Object.entries(EXTRA)) {
      const id = (await admin.query("INSERT INTO users(oidc_issuer,oidc_subject,display_name,email) VALUES($1,$2,$2,$2||'@d1.test') RETURNING id", [idp.issuer, sub])).rows[0].id;
      await admin.query("INSERT INTO memberships(user_id,district_id,school_id,role,is_default) VALUES($1,$2,$3,$4,true)", [id, ID.d1, role === "it_admin" ? null : ID.s1, role]);
    }
    // School 2 records the S1 roles must never see.
    const day = (await admin.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id=$1", [ID.s2])).rows[0].d;
    await admin.query("INSERT INTO attendance_events(district_id,student_id,event_date,status,observed_at) VALUES($1,$2,$3,'absent',now())", [ID.d1, ID.carol, day]);
    await admin.query(`INSERT INTO student_intervention_cases(district_id,student_id,school_id,created_by,category,title,summary,family_visible)
      VALUES($1,$2,$3,$4,'wellbeing','Carol check-in','Carol C needs a check-in',true)`, [ID.d1, ID.carol, ID.s2, USERS.p2[0]]);
    s2Incident = (await admin.query(`INSERT INTO safety_incidents(district_id,school_id,kind,is_drill,status,initiated_by,confirmed_by,confirmed_at,instructions)
      VALUES($1,$2,'lockdown',true,'active',$3,$3,now(),$4) RETURNING id`, [ID.d1, ID.s2, USERS.p2[0], MARK])).rows[0].id;
    await admin.query(`INSERT INTO transport_routes(district_id,school_id,name,bus_label,direction,created_by) VALUES($1,$2,$3,'Bus 9','am',$4)`, [ID.d1, ID.s2, ROUTE, USERS.p2[0]]);
    await admin.query(`INSERT INTO transport_routes(district_id,school_id,name,bus_label,direction,created_by) VALUES($1,$2,'S1 Route','Bus 1','am',$3)`, [ID.d1, ID.s1, USERS.p1[0]]);
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "vp1", "t1", "pa", "pu", "pb", "tp", "p2s", ...Object.keys(EXTRA)]) {
      s[name] = await login(server.base, idp, name, { email_verified: true, ...(EXTRA[name] ? { email: `${name}@d1.test` } : {}) });
      assert.ok(s[name].cookie, `${name} signed in`);
    }
  });
  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop?.(); });

  it("no GET route shows a School 2 learner, instructions or route to a School 1 role, or District 1 to District 2", async () => {
    // The operations event stream stays open by design (tested on its own in
    // release-gate.test.js).
    const routes = getRoutes().filter(r => r !== "/api/operations/stream");
    assert.ok(routes.length > 100, `${routes.length} routes found`);
    const fill = (route, district) => route
      .replace(":studentId", ID.carol).replace(":schoolId", ID.s2).replace(":districtId", district)
      .replace(/:[a-zA-Z]+/g, s2Incident);
    const s1Roles = ["p1", "vp1", "t1", "pa", "pu", "pb", "tp", ...Object.keys(EXTRA)];
    const leaks = [];
    let calls = 0;
    for (const who of [...s1Roles, "supt2"]) {
      const forbidden = who === "supt2"
        ? [ID.alice, ID.bob, ID.carol, "Alice A", "Bob B", "Carol C", MARK, ROUTE, s2Incident]
        : [ID.carol, "Carol C", MARK, ROUTE, ID.xavier, "Xavier X"];
      for (const route of routes) {
        const url = fill(route, who === "supt2" ? ID.d1 : ID.d2);
        calls++;
        let text;
        try {
          const r = await fetch(server.base + url, { headers: { cookie: s[who].cookie }, signal: AbortSignal.timeout(5000) });
          text = await r.text();
        } catch (e) { leaks.push(`${who} GET ${url} -> ${e.name}`); continue; }
        // A record id that's in the URL itself may be echoed back ("not found").
        const hit = forbidden.filter(f => !url.includes(f)).find(f => text.includes(f));
        if (hit) leaks.push(`${who} GET ${url} contains ${hit === ID.carol ? "Carol's id" : hit}`);
      }
    }
    assert.deepEqual(leaks, [], `${leaks.length} of ${calls} calls leaked:\n${leaks.join("\n")}`);
  });

  it("a vice principal's student directory and profiles are their school's only", async () => {
    for (const who of ["vp1", "vp-x"]) {
      const list = await as(who)("GET", "/api/students?limit=1000");
      assert.equal(list.status, 200);
      const names = list.body.data.map(x => x.display_name).sort();
      assert.deepEqual(names, ["Alice A", "Bob B"], `${who}: ${names}`);
      assert.equal((await as(who)("GET", `/api/students/${ID.alice}`)).status, 200, "own school's profile");
      assert.equal((await as(who)("GET", `/api/students/${ID.carol}`)).status, 404, "another school's profile");
      assert.equal((await as(who)("GET", `/api/students?schoolId=${ID.s2}`)).status, 403);
    }
    // Roles with no student permission see none at all.
    for (const who of ["counselor-x", "nurse-x", "librarian-x", "sro-x", "driver-x", "itadmin-x"]) {
      const r = await as(who)("GET", "/api/students");
      assert.ok(r.status === 403 || (r.status === 200 && r.body.data.length === 0), `${who} ${r.status}`);
    }
  });

  it("a parent sees a live incident only at a school where they have a child, with family wording", async () => {
    const status = async who => (await as(who)("GET", "/api/safety/status")).body.data.incidents.map(i => i.id);
    assert.ok(!(await status("pa")).includes(s2Incident), "a parent with a child at S1 only");
    assert.ok(!(await status("pb")).includes(s2Incident));
    assert.ok(!(await status("p1")).includes(s2Incident), "staff at another school");
    assert.ok(!(await status("vp1")).includes(s2Incident));
    assert.ok((await status("p2")).includes(s2Incident), "staff at the school");
    assert.ok((await status("supt1")).includes(s2Incident), "the district");
    // A parent with a child at S2 sees it, without staff instructions.
    await admin.query("INSERT INTO student_user_links(district_id,user_id,student_id,relationship) VALUES($1,$2,$3,'parent')", [ID.d1, USERS.p2s[0], ID.carol]);
    try {
      const r = await as("p2s")("GET", "/api/safety/status");
      const inc = r.body.data.incidents.find(i => i.id === s2Incident);
      assert.ok(inc, "a parent with a child at S2 sees S2's incident");
      assert.equal(inc.instructions, undefined, "staff instructions stay with staff");
      assert.ok(!JSON.stringify(r.body).includes(MARK));
      // An ended link ends it.
      await admin.query("UPDATE student_user_links SET status='disabled' WHERE user_id=$1 AND student_id=$2", [USERS.p2s[0], ID.carol]);
      assert.ok(!(await status("p2s")).includes(s2Incident), "after the link ends");
    } finally {
      await admin.query("DELETE FROM student_user_links WHERE user_id=$1 AND student_id=$2", [USERS.p2s[0], ID.carol]);
    }
  });

  it("the day's attendance gives families their own children and staff their scope", async () => {
    const day = (await admin.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id=$1", [ID.s1])).rows[0].d;
    await admin.query("INSERT INTO attendance_events(district_id,student_id,event_date,status,observed_at) VALUES($1,$2,$3,'tardy',now()),($1,$4,$3,'absent',now())", [ID.d1, ID.alice, day, ID.bob]);
    const names = async who => (await as(who)("GET", `/api/attendance/day?date=${day}`)).body.data.exceptions.map(e => e.display_name).sort();
    assert.deepEqual(await names("pa"), ["Alice A"], "parent of Alice");
    assert.deepEqual(await names("pu"), ["Alice A"], "Alice herself");
    assert.deepEqual(await names("pb"), ["Bob B"], "parent of Bob");
    assert.deepEqual(await names("vp1"), ["Alice A", "Bob B"], "vice principal: S1");
    assert.deepEqual(await names("p2"), ["Carol C"], "principal: S2");
    assert.deepEqual(await names("supt1"), ["Alice A", "Bob B", "Carol C"]);
  });

  it("a vice principal's transport view is their school's runs", async () => {
    const r = await as("vp1")("GET", "/api/transport/today");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.routes.map(x => x.name), ["S1 Route"]);
  });

  it("no other database role can call the SECURITY DEFINER functions", async () => {
    const role = `eduos_reporter_${Date.now()}`;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'r'`);
    const dbName = new URL(db.appUrl).pathname.slice(1);
    await admin.query(`GRANT CONNECT ON DATABASE "${dbName}" TO ${role}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    const url = new URL(db.appUrl); url.username = role; url.password = "r";
    const other = new pg.Client(url.toString()); await other.connect();
    try {
      await other.query("SELECT set_config('app.district_id',$1,false), set_config('app.role','principal',false), set_config('app.school_id',$2,false)", [ID.d1, ID.s2]);
      for (const call of [`SELECT * FROM eduos_safety_find_student('${s2Incident}','Carol')`, `SELECT * FROM eduos_safety_recipients('${s2Incident}','families')`,
        `SELECT eduos_parent_has_child_at('${ID.s2}')`]) {
        await assert.rejects(other.query(call), /permission denied for function/, call);
      }
      const unrevoked = (await admin.query(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.prosecdef AND has_function_privilege('public', p.oid, 'EXECUTE')`)).rows.map(r => r.proname);
      assert.deepEqual(unrevoked, [], "every definer function is revoked from PUBLIC");
    } finally {
      await other.end();
      await admin.query(`DROP OWNED BY ${role}; DROP ROLE ${role}`);
    }
  });
});

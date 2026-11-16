// Role and tenant scope matrix (release gate 2), against real PostgreSQL as
// the runtime role.
//
// Routes come from the running Express app itself (every method, every
// registration style: literals, template strings, variables), not from the
// source text. Every GET route is called as every role at school S1 (and as
// District 2's superintendent), with path parameters pointing at School 2 or
// District 2 records: no response may contain a School 2 learner, School 2
// safety instructions or a School 2 bus route, District 2 may see nothing of
// District 1, and no route may answer with a server error. Every write route
// (POST/PUT/PATCH/DELETE) is then called the same way, with a body naming
// School 2 records: none may change any School 2 row (or, for District 2, any
// District 1 row), and none may answer with a server error. Expected
// outcomes are asserted per role for the student-facing routes, and a user
// with two memberships is checked after switching between them. Then the specific findings of the 2026-11-16 audit:
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

/**
 * Every route the app registers, as [method, path], read from the Express
 * router (the app is imported without listening). Regex-only paths (the SPA
 * fallback) are left out; /auth/* is left out because it signs the caller in
 * or out.
 */
async function appRoutes(env) {
  Object.assign(process.env, env);
  const { app } = await import("../../src/server.js");
  const out = [];
  for (const layer of app.router.stack) {
    if (!layer.route) continue;
    for (const p of [layer.route.path].flat()) {
      if (typeof p !== "string" || p.startsWith("/auth/")) continue;
      for (const m of Object.keys(layer.route.methods)) out.push([m.toUpperCase(), p]);
    }
  }
  return out;
}
/** Routes the static regex used to find, for comparison: literal app.get("/api/…") only. */
function literalGetRoutes() {
  const files = [];
  const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : p.endsWith(".js") && files.push(p); } };
  walk(SRC);
  const routes = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(/app\.get\(\s*"(\/api\/[^"]+)"/g)) routes.add(m[1]);
  return routes;
}

describe("role and tenant scope matrix against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, env, routes, s2Incident, s2Case, s2Route, s2Handoff, s = {};
  const as = name => client(server.base, s[name]);
  const S1_ROLES = ["p1", "vp1", "t1", "pa", "pu", "pb", "tp", ...Object.keys(EXTRA)];
  /** A path with its parameters pointing at School 2 / District 2 records. */
  const fill = (route, district) => route.replace(/:([a-zA-Z]+)/g, (_, name) => ({
    studentId: ID.carol, learnerId: ID.carol, schoolId: ID.s2, districtId: district, caseId: s2Case, routeId: s2Route,
    handoffId: s2Handoff, incidentId: s2Incident, runId: s2Route
  })[name] ?? (route.includes("/cases") ? s2Case : route.includes("/transport") ? s2Route : route.includes("/arrival") ? s2Handoff : s2Incident));
  const send = async (who, method, url, body) => {
    const headers = { cookie: s[who].cookie, "x-csrf-token": s[who].csrf };
    if (body) headers["content-type"] = "application/json";
    const r = await fetch(server.base + url, { method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    return { status: r.status, text: await r.text() };
  };

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
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
    s2Case = (await admin.query(`INSERT INTO student_intervention_cases(district_id,student_id,school_id,created_by,category,title,summary,family_visible)
      VALUES($1,$2,$3,$4,'wellbeing','Carol check-in','Carol C needs a check-in',true) RETURNING id`, [ID.d1, ID.carol, ID.s2, USERS.p2[0]])).rows[0].id;
    s2Handoff = (await admin.query(`INSERT INTO arrival_handoffs(district_id,school_id,student_id,method,initiated_by)
      VALUES($1,$2,$3,'walk_in',$4) RETURNING id`, [ID.d1, ID.s2, ID.carol, USERS.p2[0]])).rows[0].id;
    s2Incident = (await admin.query(`INSERT INTO safety_incidents(district_id,school_id,kind,is_drill,status,initiated_by,confirmed_by,confirmed_at,instructions)
      VALUES($1,$2,'lockdown',true,'active',$3,$3,now(),$4) RETURNING id`, [ID.d1, ID.s2, USERS.p2[0], MARK])).rows[0].id;
    s2Route = (await admin.query(`INSERT INTO transport_routes(district_id,school_id,name,bus_label,direction,created_by) VALUES($1,$2,$3,'Bus 9','am',$4) RETURNING id`, [ID.d1, ID.s2, ROUTE, USERS.p2[0]])).rows[0].id;
    await admin.query(`INSERT INTO transport_routes(district_id,school_id,name,bus_label,direction,created_by) VALUES($1,$2,'S1 Route','Bus 1','am',$3)`, [ID.d1, ID.s1, USERS.p1[0]]);
    routes = await appRoutes({ ...env, DATABASE_URL: db.appUrl });
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    for (const name of ["supt1", "supt2", "p1", "p2", "vp1", "t1", "pa", "pu", "pb", "tp", "p2s", ...Object.keys(EXTRA)]) {
      s[name] = await login(server.base, idp, name, { email_verified: true, ...(EXTRA[name] ? { email: `${name}@d1.test` } : {}) });
      assert.ok(s[name].cookie, `${name} signed in`);
    }
  });
  after(async () => {
    await server?.stop(); await admin?.end(); await idp?.close();
    try { (await import("../../src/db.js")).pool.end(); } catch {}
    await db?.drop?.();
  });

  it("finds every route the app registers, including ones the source regex missed", () => {
    const gets = new Set(routes.filter(([m, p]) => m === "GET" && p.startsWith("/api/")).map(([, p]) => p));
    const missed = [...gets].filter(p => !literalGetRoutes().has(p));
    assert.ok(routes.length > 250, `${routes.length} routes`);
    assert.ok(missed.includes("/api/integrations/connectors"), `registered through a variable: ${missed.join(", ")}`);
    // (Some literal routes are mounted only on an EDEN node tier, so the
    // reverse doesn't hold in this configuration.)
  });

  it("no GET route shows a School 2 learner, instructions or route to a School 1 role, or District 1 to District 2, and none fails", async () => {
    // The operations event stream stays open by design (tested on its own in
    // release-gate.test.js).
    const gets = routes.filter(([m, p]) => m === "GET" && p !== "/api/operations/stream").map(([, p]) => p);
    const leaks = [], errors = [];
    let calls = 0;
    for (const who of [...S1_ROLES, "supt2"]) {
      const forbidden = who === "supt2"
        ? [ID.alice, ID.bob, ID.carol, "Alice A", "Bob B", "Carol C", MARK, ROUTE, s2Incident]
        : [ID.carol, "Carol C", MARK, ROUTE, ID.xavier, "Xavier X"];
      for (const route of gets) {
        const url = fill(route, who === "supt2" ? ID.d1 : ID.d2);
        calls++;
        let r;
        try { r = await send(who, "GET", url); }
        catch (e) { errors.push(`${who} GET ${url} -> ${e.name}`); continue; }
        if (r.status >= 500 && r.status !== 503) errors.push(`${who} GET ${url} -> ${r.status} ${r.text.slice(0, 120)}`);
        // A record id that's in the URL itself may be echoed back ("not found").
        const hit = forbidden.filter(f => !url.includes(f)).find(f => r.text.includes(f));
        if (hit) leaks.push(`${who} GET ${url} -> ${r.status} contains ${hit === ID.carol ? "Carol's id" : hit}`);
      }
    }
    assert.deepEqual(leaks, [], `${leaks.length} of ${calls} calls leaked:\n${leaks.join("\n")}`);
    assert.deepEqual(errors, [], `${errors.length} of ${calls} calls failed:\n${errors.join("\n")}`);
  });

  it("each role gets the expected answer from the student-facing routes", async () => {
    const day = (await admin.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id=$1", [ID.s1])).rows[0].d;
    // [route, {role: expected status}] (403: refused by permission; 200: allowed, scoped).
    const expected = [
      ["/api/students", { p1: 200, vp1: 200, t1: 200, pa: 200, pu: 200, "counselor-x": 403, "nurse-x": 403, "librarian-x": 403, "sro-x": 403, "driver-x": 403, "itadmin-x": 403 }],
      [`/api/students/${ID.alice}`, { p1: 200, vp1: 200, pa: 200, pu: 200, pb: 404, "counselor-x": 403, "driver-x": 403 }],
      ["/api/cases", { p1: 200, t1: 200, pa: 200, vp1: 403, "counselor-x": 403, "nurse-x": 403 }],
      ["/api/pickup/queue", { p1: 200, t1: 200, vp1: 403, pa: 403, "counselor-x": 403 }],
      [`/api/attendance/day?date=${day}`, { p1: 200, vp1: 200, t1: 200, pa: 200, pu: 200, "counselor-x": 403, "driver-x": 403 }],
      ["/api/transport/today", { p1: 200, vp1: 200, t1: 200, pa: 200, "driver-x": 200, "counselor-x": 403, "nurse-x": 403 }],
      ["/api/safety/status", { p1: 200, vp1: 200, t1: 200, pa: 200, pu: 200, "sro-x": 200, "driver-x": 200, "counselor-x": 403 }]
    ];
    const wrong = [];
    for (const [url, byRole] of expected) for (const [who, want] of Object.entries(byRole)) {
      const got = (await send(who, "GET", url)).status;
      if (got !== want) wrong.push(`${who} GET ${url}: ${got}, expected ${want}`);
    }
    assert.deepEqual(wrong, []);
  });

  it("a user with two memberships gets each one's scope after switching, and only that", async () => {
    // tp is a teacher and a parent at S1.
    const mine = (await as("tp")("GET", "/api/memberships")).body.data;
    const parent = mine.find(m => m.role === "parent"), teacher = mine.find(m => m.role === "teacher");
    const switchTo = async m => {
      const r = await fetch(`${server.base}/api/session/membership`, { method: "POST", body: JSON.stringify({ membershipId: m.id }),
        headers: { cookie: s.tp.cookie, "x-csrf-token": s.tp.csrf, "content-type": "application/json" } });
      assert.equal(r.status, 200);
      const cookie = r.headers.getSetCookie().find(c => c.startsWith(s.tp.cookie.split("=")[0] + "=")).split(";")[0];
      const body = await r.json();
      const old = s.tp.cookie;
      s.tp = { cookie, csrf: body.csrfToken };
      assert.equal((await fetch(`${server.base}/api/me`, { headers: { cookie: old } })).status, 401, "the previous session ends");
    };
    await switchTo(parent);
    assert.equal((await as("tp")("GET", "/api/me")).body.role, "parent");
    const kids = (await admin.query(`SELECT s.display_name FROM student_user_links l JOIN students s ON s.id=l.student_id
        WHERE l.user_id=$1 AND l.status='active' AND l.relationship IN ('parent','guardian') ORDER BY 1`, [USERS.tp[0]])).rows.map(r => r.display_name);
    assert.ok(kids.length > 0);
    assert.deepEqual((await as("tp")("GET", "/api/students")).body.data.map(x => x.display_name), kids, "as a parent: their children only");
    assert.equal((await as("tp")("GET", "/api/pickup/queue")).status, 403, "no staff desk as a parent");
    await switchTo(teacher);
    assert.equal((await as("tp")("GET", "/api/me")).body.role, "teacher");
    assert.ok(!(await as("tp")("GET", "/api/students")).body.data.some(x => x.display_name === "Carol C"));
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

  it("no write route changes School 2 records for a School 1 role, or District 1 records for District 2, and none fails", async () => {
    const tables = (await admin.query(`SELECT c.table_name, bool_or(c.column_name='school_id') AS by_school, bool_or(c.column_name='student_id') AS by_student
        FROM information_schema.columns c JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema AND t.table_type='BASE TABLE'
       WHERE c.table_schema='public' AND c.column_name IN ('school_id','student_id','district_id')
         AND c.table_name NOT IN ('audit_events','sessions','offline_replays','schema_migrations')
       GROUP BY c.table_name ORDER BY 1`)).rows;
    /** Fingerprint of every row in scope: School 2's rows, or all of District 1's. */
    const snapshot = async scope => {
      const out = {};
      for (const t of tables) {
        const where = scope === "s2"
          ? (t.by_school ? `school_id='${ID.s2}'` : t.by_student ? `student_id='${ID.carol}'` : null)
          : `district_id='${ID.d1}'`;
        if (!where) continue;
        const cols = (await admin.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='district_id'", [t.table_name])).rowCount;
        if (scope === "d1" && !cols) continue;
        out[t.table_name] = (await admin.query(`SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text,'|' ORDER BY x::text),'')) AS h FROM "${t.table_name}" x WHERE ${where}`)).rows[0];
      }
      return out;
    };
    const day = (await admin.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM schools WHERE id=$1", [ID.s2])).rows[0].d;
    const body = { studentId: ID.carol, studentIds: [ID.carol], schoolId: ID.s2, incidentId: s2Incident, caseId: s2Case, routeId: s2Route, handoffId: s2Handoff,
      status: "absent", eventDate: day, event: "boarded", kind: "lockdown", isDrill: true, method: "walk_in", reason: "matrix", overrideReason: "matrix",
      note: "matrix", title: "matrix", summary: "matrix", body: "matrix", category: "wellbeing", entries: [{ studentId: ID.carol, status: "missing" }] };
    const writes = routes.filter(([m, p]) => m !== "GET" && (p.startsWith("/api/") || p.startsWith("/lti/")));
    const errors = [], changed = [];
    let calls = 0;
    for (const [who, scope] of [["supt2", "d1"], ["p1", "s2"], ["vp1", "s2"], ["t1", "s2"], ["pa", "s2"], ["pu", "s2"], ["driver-x", "s2"], ["counselor-x", "s2"], ["sro-x", "s2"]]) {
      const before = await snapshot(scope);
      for (const [method, route] of writes) {
        const url = fill(route, who === "supt2" ? ID.d1 : ID.d2);
        calls++;
        try {
          const r = await send(who, method, url, body);
          if (r.status >= 500 && r.status !== 503) errors.push(`${who} ${method} ${url} -> ${r.status} ${r.text.slice(0, 120)}`);
        } catch (e) { errors.push(`${who} ${method} ${url} -> ${e.name}`); }
      }
      const after = await snapshot(scope);
      for (const t of Object.keys(before)) if (JSON.stringify(before[t]) !== JSON.stringify(after[t])) changed.push(`${who}: ${t} (${scope}) changed ${before[t].n} -> ${after[t].n} rows`);
    }
    assert.deepEqual(changed, [], `writes changed another school's or district's records:\n${changed.join("\n")}`);
    assert.deepEqual(errors, [], `${errors.length} of ${calls} calls failed:\n${errors.join("\n")}`);
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

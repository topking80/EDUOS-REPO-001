// EduOS 32.7.0 EDEN + DECN against real PostgreSQL with THREE processes: a
// district hub and two school nodes (each its own database and runtime
// role). Covers enrollment under one trust root, gated aggregates up (and
// leak attempts at the hub), signed bundles down, a simulated network
// partition (hub stopped) with local writes queued and synced after, offline
// replay idempotency and observed-time ordering, and DECN failover:
// authorization rules, sealed continuity package, hosted services on the
// partner, automatic handback when the failed node returns, append-only merge
// and purge on the partner.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client, freePort } from "./harness.js";
import { init, issueDistrict, envLines } from "../../src/eden/authority-cli.js";
import { signRequest, canonical } from "../../src/eden/crypto.js";
import { readFile } from "node:fs/promises";
const loadNodeIdentity = async f => JSON.parse(await readFile(f, "utf8"));

const skip = PG_URL ? false : "set EDEN_TEST_PG_URL / EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe("EduOS 32.7.0 EDEN hub + two school nodes + DECN", { skip }, () => {
  let idp, dir, edenEnv, hubPort;
  const dbs = {}, srv = {}, sess = {}, pgc = {};
  const ok = (r, code = 200) => { if (r.status >= 500) for (const [k, v] of Object.entries(srv)) console.error(`--- ${k}\n`, v.log().slice(-3000)); assert.equal(r.status, code, JSON.stringify(r.body)); return r.body.data ?? r.body; };
  const as = (server, who) => client(srv[server].base, sess[`${server}:${who}`]);
  const signIn = async (server, who) => { const s = await login(srv[server].base, idp, who); assert.equal(s.status, 303, JSON.stringify(s)); sess[`${server}:${who}`] = s; return as(server, who); };
  const nodeEnv = (name, db, school, extra = {}) => ({ ...baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app }), DATABASE_URL: db.appUrl,
    EDUOS_NODE_TIER: "school", EDEN_ROOT_CERT: edenEnv.EDEN_ROOT_CERT, EDEN_HUB_URL: `http://127.0.0.1:${hubPort}`, EDEN_ALLOW_INSECURE_HUB: "true",
    EDEN_DISTRICT_ID: ID.d1, EDEN_SCHOOL_ID: school, EDEN_IDENTITY_FILE: path.join(dir, `${name}.identity.json`), EDEN_AGENT: "off", EDEN_NODE_NAME: `node ${name}`, ...extra });
  const startHub = async () => {
    const env = { ...baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: dbs.hub.names.app }), DATABASE_URL: dbs.hub.appUrl, EDUOS_NODE_TIER: "district",
      EDEN_NODE_OFFLINE_AFTER_SECONDS: "5", ...edenEnv, PORT: String(hubPort) };
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["src/server.js"], { cwd: new URL("../../", import.meta.url).pathname, env });
    let out = "";
    await new Promise((resolve, reject) => { const on = d => { out += d; if (/listening on/.test(out)) resolve(); }; child.stdout.on("data", on); child.stderr.on("data", on); child.on("exit", c => reject(new Error(out))); });
    srv.hub = { base: `http://127.0.0.1:${hubPort}`, child, log: () => out, stop: () => new Promise(r => { if (child.exitCode !== null || child.signalCode !== null) return r(); child.removeAllListeners("exit"); child.on("exit", r); child.kill(); }) };
  };
  const q = (name, sql, params) => pgc[name].query(sql, params).then(r => r.rows);
  const edenText = async name => JSON.stringify(await q(name, `SELECT (SELECT coalesce(jsonb_agg(a),'[]') FROM eden_aggregates a) a, (SELECT coalesce(jsonb_agg(c),'[]') FROM eden_continuity_packages c) c,
    (SELECT coalesce(jsonb_agg(f),'[]') FROM eden_failovers f) f, (SELECT coalesce(jsonb_agg(l),'[]') FROM eden_inbound_log l) l, (SELECT coalesce(jsonb_agg(e),'[]') FROM eden_failover_events e) e`));

  before(async () => {
    idp = await startIdp();
    dir = mkdtempSync(path.join(tmpdir(), "eden-it-"));
    await init(path.join(dir, "authority"));
    await issueDistrict(path.join(dir, "authority"), ID.d1, "D1 hub");
    edenEnv = Object.fromEntries((await envLines(path.join(dir, "authority"), ID.d1)).map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    for (const name of ["hub", "a", "b"]) {
      dbs[name] = await createDatabase();
      const m = await run(["src/migrate.js"], { ...baseEnv({ EDUOS_APP_ROLE: dbs[name].names.app }), DATABASE_URL: dbs[name].ownerUrl });
      assert.equal(m.code, 0, m.out);
      await seed(dbs[name].adminUrl, idp.issuer);
      pgc[name] = new pg.Client(dbs[name].adminUrl); await pgc[name].connect();
    }
    // Node A keeps school s1 only, node B school s2 only (owner-only prune).
    for (const [name, keep] of [["a", ID.s1], ["b", ID.s2]]) {
      const own = new pg.Client(dbs[name].ownerUrl); await own.connect();
      await own.query("BEGIN"); await own.query("SELECT set_config('app.district_id',$1,true)", [ID.d1]);
      const r = await own.query("SELECT eduos_node_prune_to_school($1) AS c", [keep]); await own.query("COMMIT"); await own.end();
      assert.ok(r.rows[0].c.students_purged >= 1);
    }
    // Pick-up data at s1 that DECN must carry (approved adult + live pass + restriction).
    await pgc.a.query(`INSERT INTO pickup_adults(id,district_id,school_id,student_id,full_name,relationship,kind,status,requested_by,decided_by,decided_at)
      VALUES('f1000000-0000-4000-8000-000000000001',$1,$2,$3,'Grandma Ann','grandparent','authorized','approved',$4,$4,now())`, [ID.d1, ID.s1, ID.alice, USERS.p1[0]]);
    await pgc.a.query(`INSERT INTO pickup_tags(district_id,school_id,adult_id,code_hash,code_hint,issued_by,expires_at)
      VALUES($1,$2,'f1000000-0000-4000-8000-000000000001',$3,'AB',$4,now()+interval '7 days')`, [ID.d1, ID.s1, crypto.createHash("sha256").update("x").digest("hex"), USERS.p1[0]]);
    await pgc.a.query(`INSERT INTO pickup_restrictions(district_id,school_id,student_id,kind,person_name,detail,created_by) VALUES($1,$2,$3,'do_not_release','Pat Stranger','Court order on file',$4)`,
      [ID.d1, ID.s1, ID.bob, USERS.p1[0]]);
    hubPort = await freePort();
    await startHub();
  });
  after(async () => {
    for (const s of Object.values(srv)) await s?.stop?.().catch(() => {});
    for (const c of Object.values(pgc)) await c.end().catch(() => {});
    await idp?.close();
    for (const d of Object.values(dbs)) await d.drop().catch(() => {});
  });

  it("enrolls two school nodes with one-time tokens under the pinned root", async () => {
    const supt = await signIn("hub", "supt1");
    const ov = ok(await supt("GET", "/api/eden/admin/overview"));
    assert.equal(ov.hub.enabled, true);
    const ta = ok(await supt("POST", "/api/eden/admin/enrollment-tokens", { schoolId: ID.s1, name: "S1 node" }), 201);
    const tb = ok(await supt("POST", "/api/eden/admin/enrollment-tokens", { schoolId: ID.s2, name: "S2 node" }), 201);
    // Teachers / principals cannot see or run the district EDEN screens.
    const p1 = await signIn("hub", "p1");
    assert.equal((await p1("GET", "/api/eden/admin/overview")).status, 403);
    srv.a = await startServer(nodeEnv("a", dbs.a, ID.s1, { EDEN_ENROLLMENT_TOKEN: ta.token }));
    srv.b = await startServer(nodeEnv("b", dbs.b, ID.s2, { EDEN_ENROLLMENT_TOKEN: tb.token }));
    const pa = await signIn("a", "p1"), pb = await signIn("b", "p2");
    const sa = ok(await pa("POST", "/api/node/sync-now", {}));
    assert.equal(sa.uplink, "online", JSON.stringify(sa));
    ok(await pb("POST", "/api/node/sync-now", {}));
    const idA = await loadNodeIdentity(path.join(dir, "a.identity.json"));
    assert.ok(idA.nodeId && idA.keys.signPrivate);
    // A token works once.
    const reuse = await fetch(`${srv.hub.base}/api/eden/v1/enroll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: ta.token, signPublic: idA.keys.signPublic, boxPublic: idA.keys.boxPublic, proof: "x" }) });
    assert.equal(reuse.status, 400);
    const nodes = ok(await supt("GET", "/api/eden/admin/overview")).nodes;
    assert.equal(nodes.length, 2);
    assert.ok(nodes.every(n => n.online));
  });

  it("only gate output goes up: aggregates arrive, with no student names, ids or numbers anywhere in the hub's EDEN tables", async () => {
    const pa = as("a", "p1");
    ok(await pa("POST", "/api/node/sync-now", {}));
    const aggs = await q("hub", "SELECT kind, payload FROM eden_aggregates");
    assert.ok(aggs.some(a => a.kind === "enrollment_by_grade") && aggs.some(a => a.kind === "node_health"));
    const enr = aggs.find(a => a.kind === "enrollment_by_grade").payload;
    assert.equal(enr.k, 5);
    for (const c of enr.cells) assert.ok(c.count === null || c.count === 0 || c.count >= 5, JSON.stringify(c));
    const text = await edenText("hub");
    for (const leak of ["Alice", "Bob B", "Carol", "S1-A", "S1-B", ID.alice, ID.bob, ID.carol]) assert.ok(!text.includes(leak), `hub EDEN tables contain ${leak}`);
    const egress = ok(await pa("GET", "/api/node/egress"));
    assert.ok(egress.some(e => e.decision === "sent") && egress.every(e => !/Alice|S1-A/.test(JSON.stringify(e))));
  });

  it("leak attempts against the hub: forged, unsigned, replayed and non-gate messages are refused", async () => {
    const idA = await loadNodeIdentity(path.join(dir, "a.identity.json"));
    const send = async (body, headersFn = h => h) => {
      const text = canonical(body);
      const h = headersFn(signRequest({ nodeId: idA.nodeId, signPrivate: idA.keys.signPrivate, method: "POST", path: "/api/eden/v1/messages", body: text }));
      const r = await fetch(`${srv.hub.base}/api/eden/v1/messages`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: text });
      return { status: r.status, body: await r.json() };
    };
    const raw = { messages: [{ id: crypto.randomUUID(), seq: 999, kind: "student_roster", period: "current", payload: { kind: "student_roster", students: [{ id: ID.alice, name: "Alice A" }] } }] };
    const r1 = await send(raw);
    assert.equal(r1.status, 200); assert.equal(r1.body.accepted.length, 0); assert.match(r1.body.rejected[0].reason, /not_gate_output/);
    const small = { messages: [{ id: crypto.randomUUID(), seq: 1000, kind: "enrollment_by_grade", period: "current",
      payload: { gate: 1, kind: "enrollment_by_grade", k: 5, schoolId: ID.s1, period: "current", cells: [{ grade: "3", count: 2 }, { grade: "ALL", count: 2 }] } }] };
    assert.match((await send(small)).body.rejected[0].reason, /small_cell_published/);
    const otherSchool = { messages: [{ ...small.messages[0], id: crypto.randomUUID(), payload: { ...small.messages[0].payload, schoolId: ID.s2, cells: [{ grade: "3", count: 0 }, { grade: "ALL", count: 0 }] } }] };
    assert.match((await send(otherSchool)).body.rejected[0].reason, /school_mismatch/);
    // Tampered body after signing, replayed nonce, unsigned.
    let captured;
    assert.equal((await send({ messages: [] }, h => { captured = h; return { ...h, "X-Eden-Signature": h["X-Eden-Signature"].replace(/^./, c => c === "A" ? "B" : "A") }; })).status, 401);
    const text = canonical({ messages: [] });
    const h = signRequest({ nodeId: idA.nodeId, signPrivate: idA.keys.signPrivate, method: "POST", path: "/api/eden/v1/messages", body: text });
    assert.equal((await fetch(`${srv.hub.base}/api/eden/v1/messages`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: text })).status, 200);
    assert.equal((await fetch(`${srv.hub.base}/api/eden/v1/messages`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: text })).status, 401);
    assert.equal((await fetch(`${srv.hub.base}/api/eden/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: text })).status, 401);
    const rejected = await q("hub", "SELECT count(*)::int n FROM eden_inbound_log WHERE decision='rejected'");
    assert.ok(rejected[0].n >= 3);
  });

  it("signed bundles flow down and are cached on the node; consent exceptions are off by default", async () => {
    const supt = as("hub", "supt1");
    const pub = ok(await supt("POST", "/api/eden/admin/bundles/publish", { kind: "content" }), 201);
    assert.equal(pub.version, 1);
    const pa = as("a", "p1");
    ok(await pa("POST", "/api/node/sync-now", {}));
    const st = ok(await pa("GET", "/api/node/status"));
    assert.ok(st.bundles.some(b => b.kind === "content" && b.version === 1 && /^district:/.test(b.signer)));
    assert.equal(st.consentExceptions, "off");
    const x = ok(await pa("POST", "/api/node/consent-exceptions", { studentId: ID.alice, consentReference: "Signed release #1" }), 201);
    assert.equal(x.enabled, false);
    assert.equal((await pa("POST", `/api/node/consent-exceptions/${x.id}/send`, {})).status, 403);
    const blocked = await q("a", "SELECT decision, reason FROM eden_egress_log WHERE kind='consented_record_transfer'");
    assert.deepEqual(blocked.map(b => b.decision), ["blocked"]);
  });

  it("network partition: the node keeps working locally, queues, and syncs after the link heals; replays are idempotent and ordered by observed time", async () => {
    await srv.hub.stop();
    const pa = as("a", "p1");
    const down = ok(await pa("POST", "/api/node/sync-now", {}));
    assert.equal(down.uplink, "offline");
    // Local writes still work while the uplink is down.
    const base = srv.a.base, s = sess["a:p1"];
    const today = new Date().toISOString().slice(0, 10);
    const post = (body, headers = {}) => fetch(`${base}/api/attendance`, { method: "POST", headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const key = crypto.randomBytes(16).toString("hex");
    const later = new Date(Date.now() - 60_000).toISOString(), earlier = new Date(Date.now() - 10 * 60_000).toISOString();
    assert.equal((await post({ studentId: ID.alice, eventDate: today, status: "tardy" }, { "Idempotency-Key": key, "X-EduOS-Queued-At": later })).status, 201);
    assert.equal((await post({ studentId: ID.alice, eventDate: today, status: "tardy" }, { "Idempotency-Key": key, "X-EduOS-Queued-At": later })).status, 200);
    // An OLDER observation replayed afterwards must not win.
    assert.equal((await post({ studentId: ID.alice, eventDate: today, status: "absent" }, { "Idempotency-Key": crypto.randomBytes(16).toString("hex"), "X-EduOS-Queued-At": earlier })).status, 201);
    assert.equal((await post({ studentId: ID.alice, eventDate: today, status: "absent" }, { "X-EduOS-Queued-At": new Date(Date.now() + 3600_000).toISOString() })).status, 400);
    assert.equal((await post({ studentId: ID.alice, eventDate: today, status: "absent" }, { "X-EduOS-Queued-At": new Date(Date.now() - 48 * 3600_000).toISOString() })).status, 409);
    const rows = await q("a", "SELECT status FROM attendance_events WHERE student_id=$1 AND event_date=$2 ORDER BY observed_at DESC, id DESC LIMIT 1", [ID.alice, today]);
    assert.equal(rows[0].status, "tardy");
    const st = ok(await pa("GET", "/api/node/status"));
    assert.equal(st.uplink.state, "offline");
    assert.ok(st.outbox.pending >= 1);
    // Heal.
    await startHub();
    const up = ok(await pa("POST", "/api/node/sync-now", {}));
    assert.equal(up.uplink, "online");
    const after = ok(await pa("GET", "/api/node/status"));
    assert.equal(after.outbox.pending, 0);
    const att = await q("hub", "SELECT payload FROM eden_aggregates WHERE kind='attendance_daily'");
    assert.ok(att.length >= 1);
  });

  it("DECN failover: rules, sealed package, partner hosts minimum data, automatic handback, merge and purge", async () => {
    sess["hub:supt1"] = await login(srv.hub.base, idp, "supt1");
    const supt = as("hub", "supt1");
    const ov = ok(await supt("GET", "/api/eden/admin/overview"));
    const nodeA = ov.nodes.find(n => n.school_id === ID.s1), nodeB = ov.nodes.find(n => n.school_id === ID.s2);
    ok(await supt("POST", `/api/eden/admin/nodes/${nodeA.id}/partner`, { partnerNodeId: nodeB.id }));
    ok(await supt("POST", `/api/eden/admin/nodes/${nodeB.id}/partner`, { partnerNodeId: nodeA.id }));
    const pa = as("a", "p1"), pb = as("b", "p2");
    ok(await pa("POST", "/api/node/sync-now", {})); ok(await pb("POST", "/api/node/sync-now", {}));
    const pkg = await q("hub", "SELECT envelope::text AS t, counts FROM eden_continuity_packages WHERE node_id=$1", [nodeA.id]);
    assert.equal(pkg.length, 1);
    assert.ok(!/Alice|Bob B|Grandma|S1-A|Stranger/.test(pkg[0].t), "the district holds ciphertext only");
    assert.equal(pkg[0].counts.students, 2);
    // Not while A is online; not by IT; reason required.
    assert.equal((await supt("POST", "/api/eden/admin/failovers", { failedNodeId: nodeA.id, reason: "Power cut at S1 building", hours: 1 })).status, 409);
    sess["hub:p1"] = await login(srv.hub.base, idp, "p1");
    assert.equal((await as("hub", "p1")("POST", "/api/eden/admin/failovers", { failedNodeId: nodeA.id, reason: "Power cut at S1 building", hours: 1 })).status, 403);
    // Node A fails.
    await srv.a.stop();
    await sleep(6000);
    ok(await pb("POST", "/api/node/sync-now", {}));
    assert.equal((await supt("POST", "/api/eden/admin/failovers", { failedNodeId: nodeA.id, reason: "short", hours: 1 })).status, 400);
    assert.equal((await supt("POST", "/api/eden/admin/failovers", { failedNodeId: nodeA.id, reason: "Power cut at S1 building", hours: 999 })).status, 400);
    const f = ok(await supt("POST", "/api/eden/admin/failovers", { failedNodeId: nodeA.id, reason: "Power cut at S1 building", hours: 1 }), 201);
    assert.equal((await supt("POST", "/api/eden/admin/failovers", { failedNodeId: nodeA.id, reason: "Power cut at S1 building", hours: 1 })).status, 409);
    // Partner activates: S1's minimum data restored on node B.
    ok(await pb("POST", "/api/node/sync-now", {}));
    const hosted = await q("b", "SELECT status, restored_counts FROM decn_hosting WHERE failover_id=$1", [f.id]);
    assert.equal(hosted[0].status, "active");
    assert.equal(hosted[0].restored_counts.students, 2);
    assert.equal(hosted[0].restored_counts.pickup_adults, 1);
    assert.equal(hosted[0].restored_counts.pickup_restrictions, 1);
    const onB = await q("b", "SELECT count(*)::int n FROM students WHERE school_id=$1", [ID.s1]);
    assert.equal(onB[0].n, 2);
    // No grades, cases, messages or family accounts came across.
    assert.equal((await q("b", "SELECT count(*)::int n FROM student_user_links WHERE student_id=ANY($1::uuid[])", [[ID.alice, ID.bob]]))[0].n, 0);
    // S1's principal signs in on the partner and runs the continuity services only.
    const p1b = await signIn("b", "p1");
    const today = new Date().toISOString().slice(0, 10);
    ok(await p1b("POST", "/api/attendance", { studentId: ID.alice, eventDate: today, status: "present" }), 201);
    assert.equal((await p1b("GET", "/api/learning/courses")).status, 403);
    assert.equal((await p1b("GET", "/api/learning/courses")).body.error, "not_available_during_failover");
    // Node B's own principal still sees only their school.
    assert.equal((await pb("GET", "/api/node/status")).status, 200);
    // Node A comes back: automatic handback.
    srv.a = await startServer(nodeEnv("a", dbs.a, ID.s1));
    sess["a:p1"] = await login(srv.a.base, idp, "p1");
    ok(await as("a", "p1")("POST", "/api/node/sync-now", {}));
    let fo = (await q("hub", "SELECT status, handback_reason FROM eden_failovers WHERE id=$1", [f.id]))[0];
    assert.equal(fo.status, "handing_back"); assert.equal(fo.handback_reason, "origin_recovered");
    ok(await pb("POST", "/api/node/sync-now", {}));
    const purged = await q("b", "SELECT status, purge_counts FROM decn_hosting WHERE failover_id=$1", [f.id]);
    assert.equal(purged[0].status, "purged");
    assert.equal(purged[0].purge_counts.remaining_students, 0);
    assert.equal((await q("b", "SELECT count(*)::int n FROM students WHERE school_id=$1", [ID.s1]))[0].n, 0);
    assert.equal((await q("b", "SELECT count(*)::int n FROM pickup_adults WHERE school_id=$1", [ID.s1]))[0].n, 0);
    assert.equal((await p1b("GET", "/api/me")).status, 401);
    ok(await as("a", "p1")("POST", "/api/node/sync-now", {}));
    // The attendance taken on the partner was merged into S1's own node (append-only).
    const merged = await q("a", "SELECT status FROM attendance_events WHERE student_id=$1 AND event_date=$2 AND status='present'", [ID.alice, today]);
    assert.equal(merged.length, 1);
    fo = (await q("hub", "SELECT status, return_envelope FROM eden_failovers WHERE id=$1", [f.id]))[0];
    assert.equal(fo.status, "closed"); assert.equal(fo.return_envelope, null);
    const events = (await q("hub", "SELECT event FROM eden_failover_events WHERE failover_id=$1 ORDER BY at", [f.id])).map(e => e.event);
    for (const e of ["authorized", "package_released", "activated", "handback_started", "return_uploaded", "purged", "imported", "closed"]) assert.ok(events.includes(e), `${e} in ${events}`);
    const audit = await q("hub", "SELECT action FROM audit_events WHERE action LIKE 'eden_%'");
    assert.ok(audit.some(a => a.action === "eden_failover_authorize"));
    const text = await edenText("hub");
    for (const leak of ["Alice", "Bob B", "Grandma", "Stranger", ID.alice]) assert.ok(!text.includes(leak), `hub EDEN tables contain ${leak}`);
  });
});

// EduOS 32.5.0 SafetyOS and car pick-up: incident model, pass codes, release
// decisions, the pick-up queue, permissions and the migration / UI contracts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { INCIDENT_KINDS, ROLLCALL_STATUSES, audienceFor, incidentMessage, familyTitle, confirmMatches, accountability,
  newPassCode, normalizePassCode, hashPassCode, releaseDecision } from "../src/safety-model.js";
import { ROLE_PERMISSIONS, canPerform as canActor } from "../src/policy.js";

const ENV = { DATABASE_URL: "postgres://eduos:test@127.0.0.1:1/eduos", PUBLIC_ORIGIN: "http://localhost:8080", OIDC_ISSUER: "https://idp.example.test",
  OIDC_CLIENT_ID: "eduos-test", OIDC_CLIENT_SECRET: "test-secret", OIDC_REDIRECT_URI: "http://localhost:8080/auth/callback" };
for (const [k, v] of Object.entries(ENV)) process.env[k] ||= v;
const { qrRows, queueFrom } = await import("../src/pickup-routes.js");
const { validTimeZone } = await import("../src/admin-routes.js");
const read = p => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const can = (role, res, act) => canActor({ role, districtId: "d", userId: "u" }, res, act);
const sql = read("db/013_safetyos_pickup.sql");
const NEW_TABLES = ["safety_incidents", "safety_events", "safety_rollcall_entries", "pickup_adults", "pickup_tags", "pickup_restrictions", "pickup_early_dismissals", "pickup_events"];

test("incident kinds and roll-call statuses match the deck (no threat levels)", () => {
  assert.deepEqual(INCIDENT_KINDS, ["lockdown", "shelter", "evacuate", "hold"]);
  assert.deepEqual(ROLLCALL_STATUSES, ["present", "missing", "extra", "injured"]);
});

test("every role sees a message written for it; families get nothing about other children", () => {
  assert.equal(audienceFor("parent"), "family"); assert.equal(audienceFor("pupil"), "student");
  assert.equal(audienceFor("driver"), "driver"); assert.equal(audienceFor("teacher"), "staff");
  for (const k of INCIDENT_KINDS) for (const a of ["staff", "student", "driver", "family"]) assert.ok(incidentMessage(k, "active", a).length > 10, `${k}/${a}`);
  const fam = incidentMessage("lockdown", "active", "family");
  assert.doesNotMatch(fam, /missing|injured|roll call/i);
  assert.match(incidentMessage("lockdown", "reunification", "family", { reunificationPoint: "Gym" }), /Gym.*photo ID/);
  assert.equal(familyTitle("lockdown", true, "Riverside"), "Riverside: Lockdown in effect (drill)");
  assert.match(familyTitle("hold", false, "R", "closed"), /all clear/);
});

test("two-step confirm must repeat the kind and the drill flag exactly", () => {
  const inc = { kind: "lockdown", is_drill: true };
  assert.equal(confirmMatches(inc, { kind: "lockdown", isDrill: true }), true);
  assert.equal(confirmMatches(inc, { kind: "lockdown", isDrill: false }), false);
  assert.equal(confirmMatches(inc, { kind: "evacuate", isDrill: true }), false);
  assert.equal(confirmMatches(inc, { kind: "lockdown", isDrill: "true" }), false);
  assert.ok(!confirmMatches(inc, null));
});

test("accountability counts the latest report per learner and who is still unreported", () => {
  const a = accountability(6, [{ student_id: "a", status: "present" }, { student_id: "b", status: "missing" }, { student_id: "c", status: "injured" }, { student_id: "x", status: "extra" }]);
  assert.deepEqual(a, { enrolled: 6, present: 1, missing: 1, extra: 1, injured: 1, accounted: 3, unaccounted: 2 });
  assert.equal(accountability(1, [{ student_id: "a", status: "present" }, { student_id: "b", status: "extra" }]).unaccounted, 0);
});

test("pass codes: random, readable, normalised and stored only as a hash", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const c = newPassCode(); assert.match(c, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/); seen.add(c); }
  assert.equal(seen.size, 200);
  assert.equal(normalizePassCode(" rthm2 ava4k "), "RTHM2AVA4K");
  assert.equal(normalizePassCode("CHR1S-NOAH7"), "CHR1SN0AH7", "O typed for zero");
  assert.equal(normalizePassCode("chris-n0ah7".replace("i", "l")), "CHR1SN0AH7", "I/L typed for one");
  for (const bad of ["", "SHORT", "UUUUU-UUUUU", 42, null, "RTHM2-AVA4K-EXTRA"]) assert.equal(normalizePassCode(bad), null, String(bad));
  assert.match(hashPassCode("RTHM2AVA4K"), /^[0-9a-f]{64}$/);
  assert.notEqual(hashPassCode("RTHM2AVA4K"), hashPassCode("RTHM2AVA4M"));
});

test("release decisions: do-not-release always blocks; releases pause during an active incident", () => {
  const ok = { tag_state: "valid", adult_status: "approved", do_not_release: false, custody_order: false };
  assert.deepEqual(releaseDecision(ok), { ok: true, custodyOrder: false });
  assert.equal(releaseDecision(null).reason, "unknown_pass");
  assert.equal(releaseDecision({ ...ok, tag_state: "expired" }).reason, "pass_expired");
  assert.equal(releaseDecision({ ...ok, tag_state: "revoked" }).reason, "pass_revoked");
  assert.equal(releaseDecision({ ...ok, adult_status: "pending" }).reason, "adult_not_approved");
  assert.deepEqual(releaseDecision({ ...ok, do_not_release: true }, { incidentStatus: "reunification" }), { ok: false, reason: "do_not_release", blocked: true });
  assert.equal(releaseDecision(ok, { incidentStatus: "active" }).reason, "safety_incident_live");
  assert.deepEqual(releaseDecision({ ...ok, custody_order: true }, { incidentStatus: "reunification" }), { ok: true, custodyOrder: true });
});

test("QR rows are a square 0/1 matrix and the pick-up queue follows the event order", () => {
  const rows = qrRows("EDUOS-PICKUP:RTHM2AVA4K");
  assert.ok(rows.length >= 21); assert.ok(rows.every(r => r.length === rows.length && /^[01]+$/.test(r)));
  const q = queueFrom([
    { student_id: "a", event: "verified", at: "2026-11-10T20:00:00Z" }, { student_id: "a", event: "released", at: "2026-11-10T20:01:00Z" },
    { student_id: "a", event: "denied", at: "2026-11-10T20:05:00Z" },
    { student_id: "b", event: "verified", at: "2026-11-10T20:02:00Z" },
    { student_id: "c", event: "verified", at: "2026-11-10T20:03:00Z" }, { student_id: "c", event: "blocked", at: "2026-11-10T20:04:00Z" }]);
  assert.deepEqual(q.waiting.map(e => e.student_id), ["b"]);
  assert.deepEqual(q.released.map(e => e.student_id), ["a"], "a later denial does not hide an earlier release");
});

test("permissions: who may start, lead, roll-call, verify and manage", () => {
  for (const r of ["principal", "superintendent"]) { assert.ok(can(r, "safety", "initiate")); assert.ok(can(r, "safety", "lead")); assert.ok(can(r, "pickup", "manage")); }
  assert.ok(can("teacher", "safety", "initiate")); assert.ok(can("teacher", "safety", "rollcall")); assert.ok(!can("teacher", "safety", "lead"));
  assert.ok(can("teacher", "pickup", "verify")); assert.ok(!can("teacher", "pickup", "manage"));
  for (const r of ["parent", "pupil", "driver"]) { assert.ok(can(r, "safety", "read")); assert.ok(!can(r, "safety", "initiate")); assert.ok(!can(r, "pickup", "verify")); }
  assert.ok(can("parent", "pickup", "request")); assert.ok(!can("pupil", "pickup", "read"));
  assert.deepEqual(ROLE_PERMISSIONS.it_admin.safety, undefined, "district IT does not run incidents");
});

test("migration 013: RLS on every new table, append-only logs, no location / face / score columns", () => {
  const rlsList = sql.slice(sql.indexOf("-- Row-level security."), sql.indexOf("END LOOP;"));
  for (const t of NEW_TABLES) {
    assert.match(sql, new RegExp(`CREATE TABLE ${t} \\(`), t);
    assert.ok(rlsList.includes(`'${t}'`), `${t} in the RLS loop`);
  }
  assert.match(sql, /ENABLE ROW LEVEL SECURITY', t\);\s+EXECUTE format\('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t\)/);
  for (const t of ["safety_events", "safety_rollcall_entries", "pickup_events"])
    assert.match(sql, new RegExp(`BEFORE UPDATE OR DELETE ON ${t}[\\s\\S]{0,80}reject_append_only_mutation`), `${t} append-only`);
  const cols = [...sql.matchAll(/^\s+([a-z_]+)\s+(uuid|text|boolean|timestamptz|date|integer|int|numeric|jsonb|double precision|real)\b/gm)].map(m => m[1]);
  assert.ok(cols.length > 40);
  for (const c of cols) assert.doesNotMatch(c, /(^|_)(lat|lng|lon|latitude|longitude|gps|geo|location|coords|face|photo|image|biometric|threat|risk|score)(_|$)/, c);
  assert.match(sql, /eduos_school_today/); assert.match(sql, /timezone text NOT NULL DEFAULT 'America\/New_York'/);
  assert.match(read("src/migrate.js"), /013_safetyos_pickup\.sql/);
  assert.match(read("db/runtime_grants.template.sql"), /REVOKE UPDATE, DELETE, TRUNCATE ON safety_events/);
});

test("phone UI: no browser prompt()/confirm() dialogs, no camera; SafetyOS screens present", () => {
  const app = read("public/app/app.js");
  assert.doesNotMatch(app, /\b(window\.)?(prompt|confirm|alert)\(/);
  assert.match(app, /<dialog|h\("dialog"/);
  for (const needle of ["VIEWS.safety", "VIEWS.sos", "VIEWS.pickup", "Send roll call", "Check pass", "DO NOT RELEASE"]) assert.ok(app.includes(needle), needle);
  assert.doesNotMatch(app, /getUserMedia|geolocation/);
  assert.match(read("Caddyfile"), /camera=\(\), microphone=\(\), geolocation=\(\)/);
});

test("school time zones are validated", () => {
  for (const tz of ["America/New_York", "America/Los_Angeles", "Pacific/Honolulu", "UTC"]) assert.equal(validTimeZone(tz), true, tz);
  for (const tz of ["Mars/Base", "", "America/New_York; DROP", 5, null]) assert.equal(validTimeZone(tz), false, String(tz));
});

// EduOS 32.1.0 "working platform" regression tests: CSV import parsing,
// metrics, configuration gates, the production gates around the local
// development identity provider / seed / webhook sink, the compose and
// Dockerfile split, and the new browser workspaces.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseCsv, parseSisCsv, isCalendarDate, CsvError } from "../src/csv.js";
import { renderMetrics, metricsHandler } from "../src/metrics.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = p => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const baseEnv = {
  DATABASE_URL: "postgresql://eduos_app:s3cret-pw@127.0.0.1:1/eduos",
  PUBLIC_ORIGIN: "http://localhost:8080", OIDC_ISSUER: "http://idp.test/tenant", OIDC_CLIENT_ID: "x",
  OIDC_CLIENT_SECRET: "x", OIDC_REDIRECT_URI: "http://localhost:8080/auth/callback"
};
function loadConfig(env) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    "const {config}=await import('./src/config.js');console.log(JSON.stringify(config))"],
    { cwd: ROOT, env: { PATH: process.env.PATH, ...baseEnv, ...env }, encoding: "utf8" });
  return r.status === 0 ? { config: JSON.parse(r.stdout.trim().split("\n").pop()) } : { error: r.stderr };
}
const prodEnv = {
  NODE_ENV: "production", PUBLIC_ORIGIN: "https://eduos.example.org", OIDC_REDIRECT_URI: "https://eduos.example.org/auth/callback",
  DATABASE_SSL_ALLOW_PRIVATE_NETWORK: "true"
};

// ---- CSV ----
test("parseCsv handles quotes, escaped quotes, embedded newlines, BOM and CRLF", () => {
  const rows = parseCsv('\uFEFFa,b\r\n"x, y","he said ""hi"""\r\n"multi\nline",z\r\n\r\n');
  assert.deepEqual(rows.map(r => r.values), [["a", "b"], ["x, y", 'he said "hi"'], ["multi\nline", "z"]]);
  assert.deepEqual(rows.map(r => r.line), [1, 2, 3], "a record is reported at the line where it starts");
  assert.throws(() => parseCsv('a,"b'), e => e instanceof CsvError && e.code === "csv_unterminated_quote");
  assert.throws(() => parseCsv('a,b"c'), e => e.code === "csv_stray_quote");
});

test("parseSisCsv maps columns and reports the offending line", () => {
  const ok = parseSisCsv({
    studentsCsv: "local_student_number,display_name,grade_level\nS-1,\"Diaz, Rowan\",5\nS-2,Ann Lee,\n",
    attendanceCsv: "source_event_id,local_student_number,event_date,status\nE-1,S-1,2026-11-02,ABSENT\n"
  });
  assert.deepEqual(ok.students, [{ localStudentNumber: "S-1", displayName: "Diaz, Rowan", gradeLevel: "5" }, { localStudentNumber: "S-2", displayName: "Ann Lee", gradeLevel: null }]);
  assert.deepEqual(ok.attendance, [{ sourceEventId: "E-1", localStudentNumber: "S-1", eventDate: "2026-11-02", status: "absent" }]);
  const err = (input, code, line) => assert.throws(() => parseSisCsv(input), e => e.code === code && (line === undefined || e.line === line), code);
  err({ studentsCsv: "display_name\nA\n" }, "csv_missing_columns", 1);
  err({ studentsCsv: "local_student_number,display_name,ssn\nS,A,1\n" }, "csv_unknown_columns", 1);
  err({ studentsCsv: "local_student_number,display_name\nS,A\nS,B\n" }, "csv_duplicate_student", 3);
  err({ studentsCsv: "local_student_number,display_name\nS\n" }, "csv_column_count", 2);
  err({ attendanceCsv: "source_event_id,local_student_number,event_date,status\nE,S,2026-02-31,present\n" }, "csv_invalid_date", 2);
  err({ attendanceCsv: "source_event_id,local_student_number,event_date,status\nE,S,2026-02-03,sick\n" }, "csv_invalid_status", 2);
});

test("impossible calendar dates are rejected everywhere attendance dates are accepted", async () => {
  for (const good of ["2026-02-28", "2024-02-29", "2026-12-31"]) assert.ok(isCalendarDate(good), good);
  for (const bad of ["2026-02-29", "2026-02-31", "2026-13-01", "2026-1-01", "", "2026-02-28T00:00:00Z"]) assert.ok(!isCalendarDate(bad), bad);
  const server = await read("src/server.js");
  assert.ok(!/Date\.parse\([a-zA-Z.]*eventDate/.test(server), "attendance dates must use isCalendarDate");
});

// ---- metrics ----
test("metrics output is Prometheus text without personal data and is token-gated", async () => {
  const text = renderMetrics({ version: "32.1.0", poolStats: { total: 3, idle: 2, waiting: 0 } });
  assert.match(text, /^eduos_build_info\{version="32\.1\.0"\} 1$/m);
  assert.match(text, /^eduos_db_pool_connections\{state="idle"\} 2$/m);
  const call = (handler, auth) => new Promise(resolve => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); }, type() { return this; }, send(b) { resolve({ status: this.statusCode, body: b }); } };
    handler({ get: () => auth }, res);
  });
  assert.equal((await call(metricsHandler({ token: "", version: "x" }), "Bearer anything")).status, 404, "disabled without METRICS_TOKEN");
  const h = metricsHandler({ token: "0123456789abcdef0123", version: "32.1.0", poolStats: () => null });
  assert.equal((await call(h, undefined)).status, 401);
  assert.equal((await call(h, "Bearer wrong")).status, 401);
  const ok = await call(h, "Bearer 0123456789abcdef0123");
  assert.equal(ok.status, 200);
  assert.match(ok.body, /eduos_uptime_seconds/);
});

// ---- configuration gates ----
test("configuration: rate limit, metrics token and production identity-provider gates", () => {
  assert.equal(loadConfig({}).config.loginRateLimit, 600);
  assert.match(loadConfig({ LOGIN_RATE_LIMIT_PER_15M: "5" }).error, /LOGIN_RATE_LIMIT_PER_15M/);
  assert.match(loadConfig({ METRICS_TOKEN: "short" }).error, /METRICS_TOKEN must be at least 16/);
  assert.match(loadConfig(prodEnv).error, /OIDC_ISSUER must use HTTPS in production/);
});

test("oidc refuses the local development provider in production", async () => {
  const oidc = await read("src/oidc.js");
  assert.match(oidc, /discovered\.eduos_dev_idp === true && config\.nodeEnv === "production"/);
  const idp = await read("dev/dev-idp.js");
  assert.match(idp, /eduos_dev_idp: true/);
});

for (const tool of ["dev/dev-idp.js", "dev/webhook-sink.js", "dev/seed-demo.js"]) {
  test(`${tool} refuses to start with NODE_ENV=production`, () => {
    const r = spawnSync(process.execPath, [tool], { cwd: ROOT, env: { PATH: process.env.PATH, NODE_ENV: "production", DATABASE_URL: "postgresql://x:y@127.0.0.1:1/x" }, encoding: "utf8", timeout: 10000 });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /production/i);
  });
}

test("demo seed also requires an explicit opt-in", () => {
  const r = spawnSync(process.execPath, ["dev/seed-demo.js"], { cwd: ROOT, env: { PATH: process.env.PATH, NODE_ENV: "development", DATABASE_URL: "postgresql://x:y@127.0.0.1:1/x" }, encoding: "utf8", timeout: 10000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /EDUOS_ALLOW_DEMO_SEED/);
});

// ---- packaging ----
test("the production image never contains the development tools", async () => {
  const docker = await read("Dockerfile");
  const stages = docker.split(/^FROM /m).slice(1);
  const last = stages[stages.length - 1];
  assert.match(last, /AS app\b/, "the default (last) stage is the runtime app image");
  assert.ok(!/COPY[^\n]*\bdev\b/.test(last), "app stage copies no dev/ directory");
  assert.match(last, /USER eduos/);
  const base = await read("docker-compose.yml");
  assert.ok(!/devidp|webhook-sink|seed-demo/.test(base), "base compose has no development services");
  for (const m of base.matchAll(/build:\s*\{[^}]*\}/g)) assert.match(m[0], /target:\s*app/);
  const dev = await read("docker-compose.dev.yml");
  assert.match(dev, /target:\s*devtools/);
  assert.match(dev, /127\.0\.0\.1:\$\{EDUOS_DEV_IDP_PORT:-9400\}:9400|127\.0\.0\.1:9400:9400/, "dev IdP is published on loopback only");
});

test("dev-up generates secrets and never reuses placeholders", async () => {
  const up = await read("scripts/dev-up.sh");
  assert.match(up, /umask 077/);
  assert.match(up, /NODE_ENV=development/);
  assert.ok(!/change-me|changeme/i.test(up));
  const gi = await read(".gitignore");
  assert.match(gi, /\.env\.\*/);
  assert.match(gi, /caddy-local-root\.crt/);
});

// ---- browser workspaces ----
test("bridge: only pupils submit work; drafts, publish and close are offered to staff", async () => {
  const bridge = await read("public/api-bridge.js");
  assert.match(bridge, /canSubmit=role==="pupil"/);
  assert.match(bridge, /<option value="draft">Save as draft/);
  assert.match(bridge, /data-action="assignment-status" data-status="published"/);
});

test("bridge: guardian invitation links are captured, stripped from the URL and accepted after sign-in", async () => {
  const bridge = await read("public/api-bridge.js");
  assert.match(bridge, /guardianInvite=\(\[\^&\]\+\)/);
  assert.match(bridge, /history\.replaceState/);
  assert.match(bridge, /sessionStorage\.setItem\("eduos\.guardianInvite"/);
  assert.match(bridge, /\/api\/guardian-invitations\/accept/);
});

test("bridge: administration, rosters, SIS import, webhooks and FERPA workspaces exist", async () => {
  const bridge = await read("public/api-bridge.js");
  for (const path of ["/api/users", "/api/schools", "/api/rosters", "/api/integrations/sis/import-csv", "/api/integrations/sis/runs",
    "/api/webhooks", "/records-export", "/records-delete", "/api/guardian-invitations"]) assert.ok(bridge.includes(path), path);
  assert.match(bridge, /it is not shown again/, "webhook secret is shown once");
  // Every value placed in HTML goes through esc(); spot-check the new tables.
  assert.match(bridge, /\$\{esc\(u\.displayName\)\}/);
  assert.match(bridge, /\$\{esc\(s\.url\)\}/);
});

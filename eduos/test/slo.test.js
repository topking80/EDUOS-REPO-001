import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { SLOS, BURN_ALERTS, LATENCY_THRESHOLD_SECONDS, reportQuery, AVAILABILITY_EXCLUDED_ROUTES, LATENCY_EXCLUDED_ROUTES } from "../src/slo.js";
import { buildReport, toMarkdown, parsePeriod } from "../src/slo-report.js";
import { render } from "../scripts/generate-slo-rules.mjs";

const read = p => fs.readFileSync(new URL(p, import.meta.url), "utf8");

test("the SLO rules and their promtool tests are generated from src/slo.js and up to date", () => {
  const r = spawnSync(process.execPath, [new URL("../scripts/generate-slo-rules.mjs", import.meta.url).pathname, "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("SLIs use only metrics and labels EduOS exports", () => {
  const metrics = read("../src/metrics.js");
  for (const name of ["eduos_http_requests_total", "eduos_http_request_duration_seconds"]) assert.ok(metrics.includes(name));
  const buckets = JSON.parse(/LATENCY_BUCKETS = (\[[^\]]+\])/.exec(metrics)[1]);
  assert.ok(buckets.includes(LATENCY_THRESHOLD_SECONDS), "the latency threshold is a histogram bucket boundary");
  const rules = render();
  // Only bounded labels: no district, school, user or raw path.
  for (const bad of ["district", "school", "user", "student", "path="]) assert.ok(!rules.includes(bad), `no ${bad} label`);
  // Excluded routes exist in the server, so a rename can't silently re-include them.
  const server = fs.readdirSync(new URL("../src/", import.meta.url), { recursive: true }).filter(f => f.endsWith(".js") && f !== "slo.js").map(f => read(`../src/${f}`)).join("\n");
  for (const route of new Set([...AVAILABILITY_EXCLUDED_ROUTES, ...LATENCY_EXCLUDED_ROUTES])) assert.ok(server.includes(`"${route}"`), `route ${route} exists`);
});

test("every SLO has burn-rate alerts at each window, with a runbook", () => {
  const rules = render();
  for (const slo of SLOS.filter(s => s.id !== "uptime")) for (const a of BURN_ALERTS)
    assert.match(rules, new RegExp(`alert: EduOS${slo.id[0].toUpperCase() + slo.id.slice(1)}BudgetBurn${a.name}\\n`));
  assert.match(rules, /alert: EduOSUptimeBudgetExhausted/);
  assert.equal((rules.match(/runbook: "docs\/SLOS.md"/g) || []).length, (rules.match(/- alert:/g) || []).length);
  assert.ok(fs.existsSync(new URL("../docs/SLOS.md", import.meta.url)));
  // Fast burn: 14.4 x the 0.1% availability budget.
  assert.match(rules, /eduos:slo_availability_bad_ratio:rate1h > 0\.0144\n/);
});

test("report periods", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  assert.deepEqual(parsePeriod(["--month", "2026-10"], now).days, 31);
  assert.equal(parsePeriod(["--month", "2026-10"], now).end.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.throws(() => parsePeriod(["--month", "2026-11"], now), /hasn't ended/);
  assert.throws(() => parsePeriod(["--month", "26-1"], now), /--month/);
  assert.equal(parsePeriod([], now).days, 30);
  assert.equal(parsePeriod(["--days", "7"], now).days, 7);
  assert.throws(() => parsePeriod(["--days", "0"], now));
});

test("the report reads each objective from Prometheus and flags misses and missing data", async (t) => {
  const seen = [];
  const answers = { availability: [0.0004, 1e6], latency: [0.02, 1e6], uptime: null };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    assert.equal(req.headers.authorization, "Bearer tok");
    const query = u.searchParams.get("query");
    seen.push({ query, time: u.searchParams.get("time") });
    const id = SLOS.map(s => s.id).find(id => query === reportQuery(id, 31)) || SLOS.map(s => s.id).find(id => query.includes(id === "uptime" ? "up{" : id === "latency" ? "duration_seconds_count" : "requests_total"));
    const isRatio = SLOS.some(s => query === reportQuery(s.id, 31));
    const a = answers[id];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "success", data: { resultType: "vector", result: a ? [{ metric: {}, value: [0, String(isRatio ? a[0] : a[1])] }] : [] } }));
  }).listen(0);
  t.after(() => server.close());
  const period = parsePeriod(["--month", "2026-10"], new Date("2026-11-21T00:00:00Z"));
  const report = await buildReport({ base: `http://127.0.0.1:${server.address().port}`, period, token: "tok" });
  assert.ok(seen.every(s => s.time === String(Date.parse("2026-11-01T00:00:00Z") / 1000)), "queried at the period's end");
  assert.ok(seen.some(s => s.query.includes("[31d]")), "over the period's length");
  const by = Object.fromEntries(report.slos.map(r => [r.id, r]));
  assert.equal(by.availability.met, true);
  assert.ok(Math.abs(by.availability.budgetUsed - 0.4) < 1e-9);
  assert.equal(by.latency.met, false);
  assert.equal(by.uptime.met, null);
  const md = toMarkdown(report);
  assert.match(md, /EduOS service levels: 2026-10/);
  assert.match(md, /\| Requests succeed \| 99\.9% \| 99\.96% \| 40% \| Met \|/);
  assert.match(md, /\*\*Missed\*\*/);
  assert.match(md, /No data" means/);
  assert.match(md, /not a contractual SLA/);
});

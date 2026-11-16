import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { metricsMiddleware, renderMetrics } from "../src/metrics.js";

test("HTTP metrics expose bounded route-template latency histogram without raw URL", async () => {
  const req = { method: "GET", baseUrl: "/api/students", route: { path: "/:studentId" }, originalUrl: "/api/students/private-student-id" };
  const res = new EventEmitter();
  res.statusCode = 200;
  let nextCalled = false;
  metricsMiddleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  res.emit("finish");
  // Express emits close after finish on some response paths; it must not count twice.
  res.emit("close");
  const output = renderMetrics({ version: "test" });
  assert.match(output, /# TYPE eduos_http_request_duration_seconds histogram/);
  assert.match(output, /eduos_http_request_duration_seconds_bucket\{method="GET",route="\/api\/students\/:studentId",status="2xx",le="\+Inf"\} 1/);
  assert.match(output, /eduos_http_request_duration_seconds_count\{method="GET",route="\/api\/students\/:studentId",status="2xx"\} 1/);
  assert.doesNotMatch(output, /private-student-id/);
});

test("each metric family's samples are contiguous, and buckets are cumulative", () => {
  for (const [path, status] of [["/a", 200], ["/b", 404], ["/a", 500]]) {
    const req = { method: "GET", baseUrl: "", route: { path } };
    const res = new EventEmitter(); res.statusCode = status;
    metricsMiddleware(req, res, () => {});
    res.emit("finish");
  }
  const out = renderMetrics({ version: "test" }).trim().split("\n");
  const histograms = out.filter(l => l.startsWith("# TYPE ") && l.endsWith(" histogram")).map(l => l.split(" ")[2]);
  const family = line => {
    if (line.startsWith("#")) return line.split(" ")[2];
    const name = line.split(/[{ ]/)[0];
    return histograms.find(h => name === `${h}_bucket` || name === `${h}_sum` || name === `${h}_count`) || name;
  };
  const seen = []; let last = null;
  for (const line of out) {
    const f = family(line);
    if (f !== last) { assert.ok(!seen.includes(f), `${f} appears in two places`); seen.push(f); last = f; }
  }
  const buckets = out.filter(l => l.startsWith('eduos_http_request_duration_seconds_bucket{method="GET",route="/b"')).map(l => Number(l.split(" ").pop()));
  for (let i = 1; i < buckets.length; i++) assert.ok(buckets[i] >= buckets[i - 1], "cumulative");
  assert.equal(buckets.at(-1), 1);
});

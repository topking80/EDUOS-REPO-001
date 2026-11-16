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

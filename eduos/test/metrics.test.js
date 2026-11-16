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

test("queue backlog renders totals and oldest age only, and says when it is unavailable", () => {
  const rows = [
    { queue: "webhook", state: "ready", jobs: "3", oldest_seconds: 42.7 },
    { queue: "webhook", state: "dead_letter", jobs: "1", oldest_seconds: 0 },
    { queue: "notification", state: "ready", jobs: "0", oldest_seconds: 0 },
    { queue: "notification", state: "failed", jobs: "2", oldest_seconds: 0 }
  ];
  const out = renderMetrics({ version: "test", backlog: rows });
  assert.match(out, /^eduos_queue_backlog_up 1$/m);
  assert.match(out, /^eduos_queue_jobs\{queue="webhook",state="ready"\} 3$/m);
  assert.match(out, /^eduos_queue_jobs\{queue="notification",state="failed"\} 2$/m);
  assert.match(out, /^eduos_queue_oldest_ready_seconds\{queue="webhook"\} 43$/m);
  assert.match(out, /^eduos_queue_oldest_ready_seconds\{queue="notification"\} 0$/m);
  assert.doesNotMatch(out, /oldest_ready_seconds\{queue="webhook",state/);
  const down = renderMetrics({ version: "test", backlog: null });
  assert.match(down, /^eduos_queue_backlog_up 0$/m);
  assert.doesNotMatch(down, /eduos_queue_jobs/);
  assert.doesNotMatch(renderMetrics({ version: "test" }), /eduos_queue_/, "no backlog section unless a provider is configured");
});

test("queue backlog is read at most once per interval, shared by concurrent scrapes, and failures read as unavailable", async () => {
  const { cachedBacklog } = await import("../src/metrics.js");
  let t = 0, calls = 0, fail = false;
  const read = async () => { calls++; if (fail) throw new Error("db down"); return [{ queue: "webhook", state: "ready", jobs: 1, oldest_seconds: 0 }]; };
  const warned = [];
  const get = cachedBacklog(read, { ttlMs: 1000, now: () => t, log: { warn: m => warned.push(m) } });
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(calls, 1); assert.deepEqual(a, b);
  t = 500; await get(); assert.equal(calls, 1, "cached within the interval");
  t = 1500; fail = true; assert.equal(await get(), null); assert.equal(calls, 2);
  assert.match(warned[0], /db down/);
  t = 1600; assert.equal(await get(), null, "a failure is cached too, so a down database isn't hammered");
  t = 2600; fail = false; assert.equal((await get()).length, 1);
});

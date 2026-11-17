// 2026-11-17 audit, finding 1: a webhook attempt's timeout must be an absolute
// deadline that tears down the HTTP socket. Before this fix the only timer was
// Node's idle socket timeout, so a receiver that trickled one byte every
// 100 ms kept the request (and its delivery slot) open indefinitely.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { deliverOnce } from "../src/webhooks.js";

// A receiver that answers 200 and then never finishes the body: one byte per
// interval, well under the response size cap. Records when the socket closes.
async function trickleReceiver(intervalMs = 100) {
  const state = { closedAt: null, timers: new Set(), sockets: new Set() };
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/plain", "transfer-encoding": "chunked" });
    const t = setInterval(() => res.write("."), intervalMs);
    state.timers.add(t);
    res.on("close", () => { clearInterval(t); state.closedAt = Date.now(); });
  });
  server.on("connection", s => { state.sockets.add(s); s.on("close", () => state.sockets.delete(s)); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  state.url = new URL(`http://127.0.0.1:${server.address().port}/hook`);
  state.close = () => { for (const t of state.timers) clearInterval(t); for (const s of state.sockets) s.destroy(); return new Promise(r => server.close(r)); };
  return state;
}
const within = (promise, ms) => Promise.race([promise, new Promise(r => setTimeout(() => r({ outcome: "still_open_after_" + ms + "ms" }), ms).unref())]);
const until = async (check, ms) => { const end = Date.now() + ms; while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20)); return check(); };

test("a trickling receiver is cut off at the absolute deadline and its socket is destroyed", async () => {
  const rx = await trickleReceiver(100);
  try {
    const started = Date.now();
    const result = await within(deliverOnce({ url: rx.url, address: "127.0.0.1", family: 4, headers: {}, body: "{}", timeoutMs: 600 }), 3000);
    assert.equal(result.outcome, "timeout", "the attempt ends at its deadline even though bytes keep arriving");
    assert.ok(Date.now() - started < 1500, `ended after ${Date.now() - started} ms; the deadline was 600 ms`);
    assert.ok(await until(() => rx.closedAt !== null, 1000), "the receiver saw the connection close");
  } finally { await rx.close(); }
});

test("aborting the job's signal ends the attempt and destroys the socket", async () => {
  const rx = await trickleReceiver(100);
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const started = Date.now();
    const result = await within(deliverOnce({ url: rx.url, address: "127.0.0.1", family: 4, headers: {}, body: "{}", timeoutMs: 30_000, signal: controller.signal }), 3000);
    assert.equal(result.outcome, "timeout");
    assert.equal(result.reason, "job_deadline");
    assert.ok(Date.now() - started < 1500);
    assert.ok(await until(() => rx.closedAt !== null, 1000), "the receiver saw the connection close");
  } finally { await rx.close(); }
});

test("a prompt receiver is still delivered normally", async () => {
  const server = http.createServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(204); res.end(); }); });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    const url = new URL(`http://127.0.0.1:${server.address().port}/hook`);
    const result = await deliverOnce({ url, address: "127.0.0.1", family: 4, headers: {}, body: "{}", timeoutMs: 2000 });
    assert.equal(result.outcome, "delivered");
    assert.equal(result.statusCode, 204);
  } finally { await new Promise(r => server.close(r)); }
});

// Audit 37.4.0 item 5: offline replay timestamp boundaries and
// Idempotency-Key validation.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { queuedAt, idempotencyKey, ReplayError, QUEUE_MAX_AGE_MS } from "../src/offline-replay.js";

const NOW = Date.parse("2026-11-14T15:00:00.000Z");
const req = headers => ({ headers });
const at = ms => new Date(ms).toISOString();
const rejects = (fn, status, code) => assert.throws(fn, e => e instanceof ReplayError && e.status === status && e.code === code, `${status} ${code}`);

test("queued-at: absent or empty means a live write", () => {
  assert.equal(queuedAt(req({}), NOW), null);
  assert.equal(queuedAt(req({ "x-eduos-queued-at": "" }), NOW), null);
});

test("queued-at: the 24-hour replay window is inclusive at its edge", () => {
  assert.equal(QUEUE_MAX_AGE_MS, 24 * 60 * 60_000);
  assert.equal(queuedAt(req({ "x-eduos-queued-at": at(NOW - QUEUE_MAX_AGE_MS) }), NOW).getTime(), NOW - QUEUE_MAX_AGE_MS);
  rejects(() => queuedAt(req({ "x-eduos-queued-at": at(NOW - QUEUE_MAX_AGE_MS - 1) }), NOW), 409, "queued_write_too_old");
  rejects(() => queuedAt(req({ "x-eduos-queued-at": at(NOW - 7 * QUEUE_MAX_AGE_MS) }), NOW), 409, "queued_write_too_old");
});

test("queued-at: up to 2 minutes of phone clock skew into the future is tolerated, no more", () => {
  assert.equal(queuedAt(req({ "x-eduos-queued-at": at(NOW) }), NOW).getTime(), NOW);
  assert.equal(queuedAt(req({ "x-eduos-queued-at": at(NOW + 120_000) }), NOW).getTime(), NOW + 120_000);
  rejects(() => queuedAt(req({ "x-eduos-queued-at": at(NOW + 120_001) }), NOW), 400, "queued_at_in_future");
});

test("queued-at: only ISO 8601 date-times are accepted", () => {
  for (const bad of ["yesterday", "1731596400000", "2026-11-14", "14/11/2026 10:00", "2026-13-40T99:00:00Z", "not-a-date"])
    rejects(() => queuedAt(req({ "x-eduos-queued-at": bad }), NOW), 400, "invalid_queued_at");
  // Offsets other than Z are fine and are normalised to the same instant.
  assert.equal(queuedAt(req({ "x-eduos-queued-at": "2026-11-14T10:00:00.000-05:00" }), NOW).getTime(), NOW);
});

test("queued-at: Express-style req.get() is honoured", () => {
  const r = { get: name => (name === "x-eduos-queued-at" ? at(NOW - 1000) : undefined) };
  assert.equal(queuedAt(r, NOW).getTime(), NOW - 1000);
});

test("idempotency key: 16 to 80 URL-safe characters", () => {
  assert.equal(idempotencyKey(req({})), null);
  assert.equal(idempotencyKey(req({ "idempotency-key": "" })), null);
  for (const ok of ["a".repeat(16), "Z9_-".repeat(20), "0123456789abcdef0123456789abcdef"])
    assert.equal(idempotencyKey(req({ "idempotency-key": ok })), ok);
  for (const bad of ["a".repeat(15), "a".repeat(81), "a".repeat(15) + " ", "a".repeat(16) + "/", "ключ".repeat(5), "a".repeat(16) + "\n"])
    assert.throws(() => idempotencyKey(req({ "idempotency-key": bad })), e => e.status === 400 && e.code === "invalid_idempotency_key", JSON.stringify(bad));
});

test("idempotency key format matches the database CHECK constraint", () => {
  const sql = readFileSync(new URL("../db/015_eden_local_node_decn.sql", import.meta.url), "utf8");
  assert.match(sql, /idem_key text NOT NULL CHECK\(idem_key ~ '\^\[A-Za-z0-9_-\]\{16,80\}\$'\)/);
  assert.match(sql, /PRIMARY KEY\(user_id, idem_key\)/, "receipts are per user");
});

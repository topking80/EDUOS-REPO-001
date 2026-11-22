import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { consumeHintDurably } from "../src/lti.js";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("durable LTI replay helper delegates atomic claim to the tenant-checked database function", async () => {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ consumed: true }] };
  } };
  const expiresAt = new Date(Date.now() + 60_000);
  assert.equal(await consumeHintDurably(client, "district-1", "launch-1", expiresAt), true);
  assert.match(calls[0].sql, /eduos_lti_consume_launch/);
  assert.deepEqual(calls[0].params, ["district-1", "launch-1", expiresAt]);
});

test("durable LTI replay helper returns false when another instance already consumed the launch", async () => {
  const client = { query: async () => ({ rows: [{ consumed: false }] }) };
  assert.equal(await consumeHintDurably(client, "district-1", "launch-1", new Date(Date.now() + 60_000)), false);
});

test("durable LTI replay helper fails closed on malformed identifiers and expiries", async () => {
  const client = { query: async () => ({ rows: [{ consumed: true }] }) };
  await assert.rejects(() => consumeHintDurably(client, "", "launch-1", new Date(Date.now() + 60_000)));
  await assert.rejects(() => consumeHintDurably(client, "district-1", "", new Date(Date.now() + 60_000)));
  await assert.rejects(() => consumeHintDurably(client, "district-1", "launch-1", new Date(Date.now() - 1)));
});

test("migration protects launch replay ledger behind a tenant-checked security-definer function", async () => {
  const sql = await read("db/094_lti_durable_replay.sql");
  assert.match(sql, /PRIMARY KEY \(district_id, launch_id\)/);
  assert.match(sql, /current_setting\('app\.district_id'/);
  assert.match(sql, /ON CONFLICT \(district_id, launch_id\) DO UPDATE/);
  assert.match(sql, /DELETE FROM lti_launch_replays\s+WHERE district_id = p_district_id AND expires_at <= now\(\)/);
  assert.match(sql, /REVOKE ALL ON lti_launch_replays FROM PUBLIC/);
});

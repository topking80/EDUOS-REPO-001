import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../db/073_commerce_webhook_events.sql", import.meta.url), "utf8");
const grants = await readFile(new URL("../db/runtime_grants.template.sql", import.meta.url), "utf8");

test("commerce webhook inbox is tenant-scoped and links events to same-district payments", () => {
  assert.match(migration, /FOREIGN KEY\s*\(district_id, payment_id\)\s*REFERENCES commerce_payments\(district_id, id\)/);
  assert.match(migration, /ALTER TABLE commerce_webhook_events ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /ALTER TABLE commerce_webhook_events FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /district_id = nullif\(current_setting\('app\.district_id', true\), ''\)::uuid/);
});

test("provider event identity is unique and immutable", () => {
  assert.match(migration, /UNIQUE\s*\(processor, provider_event_id\)/);
  for (const field of ["district_id", "payment_id", "processor", "provider_event_id", "event_type", "payload_sha256"]) {
    assert.match(migration, new RegExp(`NEW\\.${field}<>OLD\\.${field}`));
  }
  assert.match(migration, /payload_sha256 text NOT NULL CHECK\(payload_sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/);
});

test("webhook event state machine rejects terminal-state regression", () => {
  assert.match(migration, /OLD\.state='processing' AND NEW\.state IN \('applied','ignored','failed'\)/);
  assert.match(migration, /webhook event cannot go from % to %/);
  assert.match(migration, /NEW\.attempts<>OLD\.attempts\+1/);
});

test("runtime role gets no delete or truncate access to the event ledger", () => {
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON commerce_webhook_events TO eduos_app/);
  assert.match(grants, /REVOKE DELETE, TRUNCATE ON commerce_webhook_events FROM eduos_app/);
  assert.match(grants, /REVOKE ALL ON FUNCTION eduos_commerce_webhook_event_guard\(\) FROM eduos_app/);
});

test("webhook attempts advance only on claims and terminal events get completion timestamps", () => {
  assert.match(migration, /CHECK \(\(state IN \('applied','ignored','failed'\)\) = \(processed_at IS NOT NULL\)\)/);
  assert.match(migration, /claiming a webhook event must increment attempts/);
  assert.match(migration, /NEW\.processed_at := coalesce\(NEW\.processed_at, now\(\)\)/);
  assert.match(migration, /webhook processing metadata changed outside a state transition/);
});

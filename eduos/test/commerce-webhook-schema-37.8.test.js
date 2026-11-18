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


const receiveMigration = await readFile(new URL("../db/075_commerce_webhook_receive.sql", import.meta.url), "utf8");
const intake = await readFile(new URL("../src/commerce/webhook-intake.js", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

test("public webhook persistence is a narrow token-authenticated SECURITY DEFINER function", () => {
  assert.match(receiveMigration, /SECURITY DEFINER/);
  assert.match(receiveMigration, /SET search_path = pg_catalog, public/);
  assert.match(receiveMigration, /e\.token_sha256=p_token_sha256 AND e\.processor=p_processor/);
  assert.match(receiveMigration, /p\.status='requires_confirmation' AND p\.amount_cents=p_amount_cents/);
  assert.match(receiveMigration, /p\.currency=p_currency/);
  assert.match(receiveMigration, /INSERT INTO public\.commerce_webhook_events/);
  assert.doesNotMatch(receiveMigration, /UPDATE public\.commerce_payments|UPDATE public\.event_ticket_orders|UPDATE public\.commerce_ledger_entries/);
  assert.match(receiveMigration, /REVOKE ALL ON FUNCTION eduos_commerce_receive_webhook/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION eduos_commerce_receive_webhook/);
});

test("public receiver verifies signatures before persisting and never settles payments", () => {
  assert.match(intake, /adapter\.verifyWebhook\(\{ headers, rawBody \}\)/);
  assert.ok(intake.indexOf("adapter.verifyWebhook") < intake.indexOf("eduos_commerce_receive_webhook"));
  assert.match(intake, /normalizeVerifiedPaymentEvent\(processor, body\)/);
  assert.match(intake, /eduos_commerce_receive_webhook\(\$1/);
  assert.doesNotMatch(intake, /eduos_commerce_record|UPDATE commerce_payments|UPDATE event_ticket_orders/);
  assert.match(server, /app\.post\(["\`]\/api\/commerce\/webhooks\/:processor\/:token/);
});


const payerActorMigration = await readFile(new URL("../db/076_commerce_webhook_payer_actor.sql", import.meta.url), "utf8");
const commerceService = await readFile(new URL("../src/commerce/service.js", import.meta.url), "utf8");

test("checkout preserves the authenticated payer actor separately from transient pending state", () => {
  assert.match(payerActorMigration, /ADD COLUMN payer_actor jsonb/);
  assert.match(payerActorMigration, /payer_actor IS NULL OR/);
  assert.match(payerActorMigration, /payer_actor->>'userId'/);
  assert.match(payerActorMigration, /payer_actor->>'role'/);
  assert.match(commerceService, /pending_since,pending_actor,payer_actor/);
  assert.equal((commerceService.match(/pending_since,pending_actor,payer_actor/g) || []).length, 2);
  assert.match(commerceService, /\$13::jsonb,\$13::jsonb/);
  assert.match(commerceService, /\$11::jsonb,\$11::jsonb/);
});

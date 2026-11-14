import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';

test('37.3 durable webhook outbox migration is registered and tenant isolated', async () => {
  const migrations = await readdir(new URL('../db/', import.meta.url));
  assert.ok(migrations.includes('033_durable_webhook_outbox.sql'));
  const sql = await readFile(new URL('../db/033_durable_webhook_outbox.sql', import.meta.url), 'utf8');
  for (const fragment of ['CREATE TABLE webhook_outbox','UNIQUE(district_id, subscription_id, event_id)',
    "status IN ('pending','processing','delivered','dead_letter','cancelled')",'lease_until','lease_token',
    'available_at','FOREIGN KEY(district_id,event_id)','ENABLE ROW LEVEL SECURITY','FORCE ROW LEVEL SECURITY',
    'current_setting(\'app.district_id\'', 'WITH CHECK']) assert.ok(sql.includes(fragment), fragment);
});

test('37.3 outbox jobs are granted mutable queue state but delivery ledger remains append-only', async () => {
  const grants = await readFile(new URL('../db/runtime_grants.template.sql', import.meta.url), 'utf8');
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE ON webhook_outbox TO eduos_app/);
  assert.match(grants, /REVOKE DELETE, TRUNCATE ON webhook_outbox FROM eduos_app/);
  assert.match(grants, /REVOKE UPDATE, DELETE, TRUNCATE ON webhook_deliveries FROM eduos_app/);
});

test('37.3 records flow events and outbox rows in the same tenant transaction', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const start = server.indexOf('async function recordFlowEvent');
  const end = server.indexOf('async function processWebhookOutbox', start);
  const implementation = server.slice(start, end);
  assert.match(implementation, /return withTenantTransaction\(actor,async client=>/);
  assert.ok(implementation.indexOf('INSERT INTO flow_events') < implementation.indexOf('INSERT INTO webhook_outbox'));
  assert.match(implementation, /ON CONFLICT\(district_id,subscription_id,event_id\) DO NOTHING/);
});


test('37.3 outbox leases exceed bounded network operations to reduce premature reclaim', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(server, /lease_until=now\(\)\+interval '2 minutes'/);
});

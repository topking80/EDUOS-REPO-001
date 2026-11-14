// POST /api/webhooks/:id/test through the real API (runtime role, real
// PostgreSQL) with a local receiver. The endpoint returned 500 in 37.3.x and
// 37.4.0 because deliverToSubscription() was missing.
// Run: EDUOS_TEST_PG_URL=postgres://postgres@127.0.0.1:5432/postgres npm run test:integration
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { PG_URL, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";
import { verifySignature } from "../../src/webhooks.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";

describe("37.4.0 webhook test delivery endpoint", { skip }, () => {
  let db, idp, server, admin, receiver, receiverUrl, supt, t1;
  const received = [];
  let receiverStatus = 204;

  before(async () => {
    receiver = http.createServer(async (req, res) => {
      let body = ""; for await (const c of req) body += c;
      received.push({ path: req.url, headers: req.headers, body });
      res.writeHead(receiverStatus); res.end();
    });
    await new Promise(r => receiver.listen(0, "127.0.0.1", r));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app, WEBHOOK_SIGNING_KEY: "w".repeat(40), WEBHOOK_ALLOW_INSECURE_LOOPBACK: "true" });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl });
    supt = client(server.base, await login(server.base, idp, "supt1", { email_verified: true }));
    t1 = client(server.base, await login(server.base, idp, "t1", { email_verified: true }));
  });
  after(async () => {
    await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop?.();
    await new Promise(r => receiver?.close(r));
  });

  it("sends one signed webhook.test, logs it, and reports the outcome", async () => {
    const created = await supt("POST", "/api/webhooks", { url: `${receiverUrl}/hooks/ok`, eventTypes: ["assignment.created"] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { id } = created.body.data, secret = created.body.secret;

    const test = await supt("POST", `/api/webhooks/${id}/test`, {});
    assert.equal(test.status, 200, JSON.stringify(test.body));
    assert.deepEqual(test.body, { outcome: "delivered", statusCode: 204 });

    const got = received.filter(r => r.path === "/hooks/ok");
    assert.equal(got.length, 1);
    assert.equal(got[0].headers["x-eduos-event"], "webhook.test");
    assert.ok(verifySignature(secret, got[0].headers["x-eduos-signature"], got[0].body), "signed with the subscription's secret");
    const payload = JSON.parse(got[0].body);
    assert.equal(payload.type, "webhook.test");

    const log = await supt("GET", `/api/webhooks/${id}/deliveries`);
    assert.deepEqual(log.body.data.map(d => [d.eventType, d.attempt, d.outcome, d.statusCode]), [["webhook.test", 1, "delivered", 204]]);
    assert.equal(log.body.data[0].deliveryId, got[0].headers["x-eduos-delivery"]);
  });

  it("a failing receiver is reported without counting against the subscription", async () => {
    const { id } = (await supt("POST", "/api/webhooks", { url: `${receiverUrl}/hooks/down`, eventTypes: ["assignment.created"] })).body.data;
    receiverStatus = 503;
    try {
      const test = await supt("POST", `/api/webhooks/${id}/test`, {});
      assert.equal(test.status, 200, JSON.stringify(test.body));
      assert.deepEqual(test.body, { outcome: "http_error", statusCode: 503 });
    } finally { receiverStatus = 204; }
    const row = (await admin.query("SELECT status, failure_count FROM webhook_subscriptions WHERE id=$1", [id])).rows[0];
    assert.deepEqual([row.status, row.failure_count], ["active", 0]);
    const audit = (await admin.query("SELECT outcome, detail FROM audit_events WHERE resource_type='webhook_subscription' AND resource_id=$1 AND action='test'", [id])).rows;
    assert.deepEqual(audit.map(a => [a.outcome, a.detail]), [["failure", "outcome=http_error"]]);
  });

  it("only webhook managers can send a test", async () => {
    const { id } = (await supt("POST", "/api/webhooks", { url: `${receiverUrl}/hooks/perm`, eventTypes: ["assignment.created"] })).body.data;
    assert.equal((await t1("POST", `/api/webhooks/${id}/test`, {})).status, 403);
    assert.equal(received.filter(r => r.path === "/hooks/perm").length, 0);
  });
});

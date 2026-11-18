import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("queue backlog function is executable by the runtime role, not PUBLIC", async () => {
  const migration = await readFile(new URL("db/072_notification_backlog_metrics_grant.sql", root), "utf8");
  const grants = await readFile(new URL("db/runtime_grants.template.sql", root), "utf8");
  assert.match(migration, /GRANT EXECUTE ON FUNCTION eduos_queue_backlog\(\) TO eduos_app;/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION eduos_queue_backlog\(\) TO eduos_app;/);
  assert.match(grants, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION eduos_queue_backlog\(\) TO PUBLIC/i);
});

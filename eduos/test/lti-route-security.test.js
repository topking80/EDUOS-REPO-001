import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/mesh-routes.js", import.meta.url), "utf8");

test("LTI authorization consumes launch hints through the durable tenant-scoped database function", () => {
  assert.match(source, /consumeHintDurably/);
  assert.doesNotMatch(source, /import\s*\{[^}]*\bconsumeHint\b/);
  assert.match(source, /withTenantTransaction\(actor, async client => \{/);
  assert.match(source, /consumeHintDurably\(client, hint\.d, hint\.l, new Date\(hint\.exp\)\)/);
});

test("LTI authorization binds the request to the registered client, deployment, target and redirect", () => {
  assert.match(source, /p\.client_id !== cfg\.clientId/);
  assert.match(source, /p\.lti_deployment_id !== cfg\.deploymentId/);
  assert.match(source, /p\.target_link_uri !== \(cfg\.targetLinkUri \|\| app\.launch_url\)/);
  assert.match(source, /cfg\.redirectUris\.includes\(p\.redirect_uri\)/);
});

test("LTI authorization requires non-empty OIDC nonce and state", () => {
  assert.match(source, /typeof p\.nonce !== "string" \|\| p\.nonce\.length < 1/);
  assert.match(source, /typeof p\.state !== "string" \|\| p\.state\.length < 1/);
});

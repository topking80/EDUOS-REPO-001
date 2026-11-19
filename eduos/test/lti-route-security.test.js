import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/mesh-routes.js", import.meta.url), "utf8");
const lti = await readFile(new URL("../src/lti.js", import.meta.url), "utf8");

test("LTI authorization consumes launch hints through the durable tenant-scoped database function", () => {
  assert.match(source, /consumeHintDurably/);
  assert.doesNotMatch(source, /import\s*\{[^}]*\bconsumeHint\b/);
  assert.match(source, /withTenantTransaction\(actor, async client => \{/);
  assert.match(source, /consumeHintDurably\(client, hint\.d, hint\.l, new Date\(hint\.exp\)\)/);
});

test("LTI authorization binds client, target and exact redirect; deployment is emitted as a signed LTI claim", () => {
  assert.match(source, /p\.client_id !== cfg\.clientId/);
  assert.match(source, /p\.target_link_uri !== \(cfg\.targetLinkUri \|\| app\.launch_url\)/);
  assert.match(source, /cfg\.redirectUris\.includes\(p\.redirect_uri\)/);
  assert.match(lti, /claim\/deployment_id": cfg\.deploymentId/);
  assert.doesNotMatch(source, /p\.lti_deployment_id/);
  assert.doesNotMatch(source, /searchParams\.set\("lti_deployment_id"/);
});

test("LTI authorization requires non-empty OIDC nonce and state", () => {
  assert.match(source, /typeof p\.nonce !== "string" \|\| p\.nonce\.length < 1/);
  assert.match(source, /typeof p\.state !== "string" \|\| p\.state\.length < 1/);
});

test("LTI authorization rejects an untrusted issuer and interactive prompt", () => {
  assert.match(source, /p\.iss !== issuer/);
  assert.match(source, /p\.prompt !== "none"/);
});


test("LTI app registration and updates reject unsupported roster, grade and attendance scopes", () => {
  assert.match(source, /\["none", "identity"\]\.includes\(b\.dataSharingScope \|\| "none"\)/);
  assert.match(source, /\["none", "identity"\]\.includes\(nextScope\)/);
  assert.match(source, /unsupported_lti_data_scope/);
});


test("LTI authorization refuses legacy apps with unsupported data scopes", () => {
  assert.match(source, /if \(!\["none", "identity"\]\.includes\(app\.data_sharing_scope\)\) return \{ error: "unsupported_lti_data_scope", status: 403 \}/);
});

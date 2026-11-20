import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/mesh-routes.js", import.meta.url), "utf8");
const lti = await readFile(new URL("../src/lti.js", import.meta.url), "utf8");
const approvalMigration = await readFile(new URL("../db/086_lti_registration_approval.sql", import.meta.url), "utf8");

test("LTI launch validates configuration before claiming a license seat", () => {
  const validate = source.indexOf('if (a.integration_type === "lti13" && !validLtiConfig(cfg.integration_config, { allowInsecureLoopback: config.nodeEnv !== "production" }))');
  const claim = source.indexOf("eduos_claim_seat($1)");
  assert.ok(validate >= 0 && claim > validate);
});

test("LTI launch initiation rejects invalid configuration and uses only the configured target URI", () => {
  assert.match(source, /validLtiConfig\(cfg\.integration_config, \{ allowInsecureLoopback: config\.nodeEnv !== "production" \}\)/);
  assert.match(source, /target_link_uri/);
});

test("LTI authorization consumes launch hints through the durable tenant-scoped database function", () => {
  assert.match(source, /consumeHintDurably/);
  assert.doesNotMatch(source, /import\s*\{[^}]*\bconsumeHint\b/);
  assert.match(source, /withTenantTransaction\(actor, async client => \{/);
  assert.match(source, /consumeHintDurably\(client, hint\.d, hint\.l, new Date\(hint\.exp\)\)/);
});

test("LTI authorization binds client, target and exact redirect; deployment is emitted as a signed LTI claim", () => {
  assert.match(source, /p\.client_id !== cfg\.clientId/);
  assert.match(lti, /claim\/target_link_uri": cfg\.targetLinkUri,/);
  assert.match(source, /cfg\.redirectUris\.includes\(p\.redirect_uri\)/);
  assert.match(lti, /claim\/deployment_id": cfg\.deploymentId/);
  assert.doesNotMatch(source, /p\.lti_deployment_id/);
  assert.doesNotMatch(source, /searchParams\.set\("lti_deployment_id"/);
});

test("LTI authorization revalidates the live tool registration at callback time", () => {
  assert.match(source, /validLtiConfig\(cfg, \{ allowInsecureLoopback: config\.nodeEnv !== "production" \}\)/);
  assert.match(source, /lti_configuration_invalid/);
});

test("LTI launch binds the encrypted hint to the exact registration and rejects mid-flight changes", () => {
  assert.match(source, /c: ltiConfigFingerprint\(ltiCfg, a\.data_sharing_scope\)/);
  assert.match(source, /ltiConfigFingerprint\(cfg, app\.data_sharing_scope\) !== hint\.c/);
  assert.match(source, /lti_registration_changed/);
});

test("LTI launches require district approval and reapproval invalidates prior hints", () => {
  assert.match(source, /lti_registration_status !== "approved"/);
  assert.match(source, /lti_approved_config_hash !== ltiConfigFingerprint\(cfg, app\.data_sharing_scope\)/);
  assert.match(source, /lti_approval_changed/);
  assert.match(source, /\/api\/apps\/:appId\/lti\/approve/);
  assert.match(source, /\/api\/apps\/:appId\/lti\/revoke/);
});

test("LTI authorization requires non-empty OIDC nonce and state", () => {
  assert.match(source, /typeof p\.nonce !== "string" \|\| p\.nonce\.length < 1/);
  assert.match(source, /typeof p\.state !== "string" \|\| p\.state\.length < 1/);
});

test("LTI authorization accepts the OIDC request without initiation-only parameters", () => {
  assert.doesNotMatch(source, /p\.iss !== issuer/);
  assert.doesNotMatch(source, /typeof p\.target_link_uri/);
  assert.match(source, /p\.prompt !== undefined && p\.prompt !== "none"/);
});

test("LTI callback rechecks current entitlement and launch identity before issuing a token", () => {
  assert.match(source, /status='active'/);
  assert.match(source, /school_id IS NOT DISTINCT FROM \$4::uuid/);
  assert.match(source, /SELECT 1 FROM app_licenses WHERE id=\$1 AND app_id=\$2 AND status='active'/);
  assert.match(source, /const current = await availableApps\(client, actor, hint\.a\)/);
  assert.match(source, /if \(!current\.rows\.length\) return \{ error: "app_not_available", status: 403 \}/);
  assert.match(source, /launch\.role !== hint\.r/);
  assert.match(source, /launch\.school_id \|\| null\) !== \(hint\.s \|\| null\)/);
  assert.match(source, /schools WHERE id=\$1 AND status='active'/);
});


test("LTI app registration and updates reject unsupported roster, grade and attendance scopes", () => {
  assert.match(source, /\["none", "identity"\]\.includes\(b\.dataSharingScope \|\| "none"\)/);
  assert.match(source, /\["none", "identity"\]\.includes\(nextScope\)/);
  assert.match(source, /unsupported_lti_data_scope/);
});

test("LTI authorization refuses legacy apps with unsupported data scopes", () => {
  assert.match(source, /if \(!\["none", "identity"\]\.includes\(app\.data_sharing_scope\)\) return \{ error: "unsupported_lti_data_scope", status: 403 \}/);
});

test("changing an LTI data-sharing scope invalidates approval in PostgreSQL", () => {
  assert.match(approvalMigration, /OLD\.data_sharing_scope IS DISTINCT FROM NEW\.data_sharing_scope/);
  assert.match(approvalMigration, /UPDATE OF integration_type, integration_config, data_sharing_scope ON apps/);
});

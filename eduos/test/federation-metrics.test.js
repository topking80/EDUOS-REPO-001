// FED-09: federation gauges, as counts with bounded labels.
import test from "node:test";
import assert from "node:assert/strict";
import { renderFederationMetrics, federationMetrics } from "../src/federation-metrics.js";
import { renderMetrics } from "../src/metrics.js";
import { parseKeyRing } from "../src/federation/key-ring.js";

const ring = parseKeyRing("", "");
const v = (lines, name) => Number(lines.find(l => l.startsWith(`${name} `))?.split(" ")[1]);

test("districts are counted by bundle, hold, consent and residency", () => {
  const rows = [
    { has_bundle: false, policies: null, jurisdiction_id: null, newest_age_seconds: null, newest_revoked: false },
    { has_bundle: true, policies: [{ id: "records.legal_hold", value: true }, { id: "data.residency.scope", value: "in_state" }], jurisdiction_id: "US-TX", newest_age_seconds: 3600, newest_revoked: false },
    { has_bundle: true, policies: [{ id: "exchange.consent_reference.required", value: true }, { id: "data.residency.scope", value: "in_state" }], jurisdiction_id: "US-OK", newest_age_seconds: 86400, newest_revoked: true },
  ];
  const l = renderFederationMetrics(rows, { ring, location: "US-TX" });
  assert.equal(v(l, "eduos_federation_status_up"), 1);
  assert.equal(v(l, 'eduos_federation_districts{bundle="in_effect"}'), 2); assert.equal(v(l, 'eduos_federation_districts{bundle="none"}'), 1);
  assert.equal(v(l, "eduos_federation_legal_hold_districts"), 1); assert.equal(v(l, "eduos_federation_consent_required_districts"), 1);
  assert.equal(v(l, 'eduos_federation_residency_districts{status="met"}'), 2); assert.equal(v(l, 'eduos_federation_residency_districts{status="not_met"}'), 1);
  assert.equal(v(l, "eduos_federation_newest_bundle_revoked_key_districts"), 1);
  assert.equal(v(l, "eduos_federation_oldest_newest_bundle_seconds"), 86400);
  for (const line of l.filter(x => !x.startsWith("#"))) assert.match(line, /^eduos_federation_[a-z_]+(\{(bundle|status)="[a-z_]+"\})? \d+$/);
});

test("an unreadable status is reported, not shown as zero districts", async () => {
  const l = renderFederationMetrics(null, { ring });
  assert.equal(v(l, "eduos_federation_status_up"), 0);
  assert.ok(!l.some(x => x.startsWith("eduos_federation_districts")));
  const read = federationMetrics(async () => { throw new Error("down"); }, { log: {} });
  assert.equal(v(await read(), "eduos_federation_status_up"), 0);
});

test("a metric prefix renames every family; extra lines are appended", () => {
  const text = renderMetrics({ version: "1", prefix: "mc", extra: ["# HELP mc_x X.", "# TYPE mc_x gauge", "mc_x 1"] });
  assert.ok(!/^(# (HELP|TYPE) )?eduos_/m.test(text));
  assert.match(text, /^# TYPE mc_build_info gauge$/m); assert.match(text, /^mc_x 1$/m);
  assert.match(renderMetrics({ version: "1" }), /^eduos_build_info\{version="1"\} 1$/m, "EduOS names are unchanged");
});

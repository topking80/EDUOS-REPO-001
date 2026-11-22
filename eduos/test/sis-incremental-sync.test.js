import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideSyncMode } from "../src/integrations/sync-mode.js";
import * as edfi from "../src/integrations/edfi.js";
import * as oneroster from "../src/integrations/oneroster.js";
import * as powerschool from "../src/integrations/powerschool.js";

const now = Date.parse("2026-11-21T12:00:00Z");
const base = { incremental: true, config_version: 3, full_sync_hours: 24,
  sync_watermark: { since: "2026-11-21T11:00:00Z", configVersion: 3 }, last_full_sync_at: "2026-11-21T00:00:00Z" };

describe("SIS-06 sync mode", () => {
  it("only OneRoster and Ed-Fi read changes", () => {
    assert.equal(oneroster.supportsIncremental, true);
    assert.equal(edfi.supportsIncremental, true);
    assert.notEqual(powerschool.supportsIncremental, true);
  });
  it("is incremental only when every condition holds", () => {
    assert.deepEqual(decideSyncMode(base, oneroster, now), { mode: "incremental" });
    assert.equal(decideSyncMode({ ...base, incremental: false }, oneroster, now).reason, "incremental_off");
    assert.equal(decideSyncMode(base, powerschool, now).reason, "source_has_no_change_feed");
    assert.equal(decideSyncMode({ ...base, sync_watermark: null }, oneroster, now).reason, "no_previous_full_sync");
    assert.equal(decideSyncMode({ ...base, config_version: 4 }, oneroster, now).reason, "connector_changed");
    assert.equal(decideSyncMode({ ...base, last_full_sync_at: null }, oneroster, now).reason, "full_sync_due");
    assert.equal(decideSyncMode({ ...base, full_sync_hours: 12 }, oneroster, now).reason, "full_sync_due");
  });
  it("Ed-Fi change queries need a recognisable data URL", () => {
    assert.equal(edfi.changeQueriesBase("https://x.org/api/data/v3"), "https://x.org/api/changeQueries/v1");
    assert.equal(edfi.changeQueriesBase("https://x.org/api/data"), "https://x.org/api/changeQueries/v1");
    assert.equal(edfi.changeQueriesBase("https://x.org/somewhere"), null);
  });
});

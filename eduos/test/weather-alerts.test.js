// SAFE-04: parsing National Weather Service alerts (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAlerts } from "../src/weather-nws.js";

const f = (event, p = {}) => ({ id: `urn:${event}`, properties: { id: `urn:${event}`, event, status: "Actual", messageType: "Alert", headline: `${event} until 8 PM`, areaDesc: "County", expires: "2026-11-23T20:00:00-05:00", ...p } });
test("NWS events map to hazards and levels; tests, exercises and cancellations are skipped", () => {
  const out = parseAlerts({ features: [f("Tornado Warning"), f("Severe Thunderstorm Watch"), f("Flash Flood Warning"), f("Wind Advisory"), f("Special Weather Statement"),
    f("Blizzard Warning"), f("Hazardous Materials Warning"), f("Tornado Warning", { status: "Test", id: "t2" }), f("Tornado Warning", { status: "Exercise", id: "t3" }), f("Tornado Warning", { messageType: "Cancel", id: "t4" })] });
  assert.deepEqual(out.map(a => [a.event, a.level, a.hazard]), [["Tornado Warning", "warning", "tornado"], ["Severe Thunderstorm Watch", "watch", "severe_thunderstorm"],
    ["Flash Flood Warning", "warning", "flood"], ["Wind Advisory", "advisory", null], ["Special Weather Statement", "statement", null],
    ["Blizzard Warning", "warning", "winter_storm"], ["Hazardous Materials Warning", "warning", "hazmat"]]);
  assert.equal(out[0].expires, "2026-11-24T01:00:00.000Z");
  assert.deepEqual(parseAlerts(null), []); assert.deepEqual(parseAlerts({ features: [{}] }), []);
  assert.equal(parseAlerts({ features: [f("Tornado Warning", { headline: "x".repeat(900) })] })[0].headline.length, 300);
});

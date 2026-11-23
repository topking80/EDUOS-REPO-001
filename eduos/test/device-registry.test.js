// DEV-01: what a classroom device can be told to do is fixed per kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDevice, DEVICE_CAPS } from "../src/device-registry.js";

test("no kind offers screen viewing", () => {
  for (const caps of Object.values(DEVICE_CAPS)) assert.ok(!caps.some(c => /view|screen|watch|capture|record/.test(c)), caps.join());
});

test("capabilities must belong to the kind; duplicates collapse; text is trimmed", () => {
  assert.equal(parseDevice({ kind: "student_device", name: "Cart", capabilities: ["lock", "view_screen"] }), null);
  assert.equal(parseDevice({ kind: "display", name: "Board", capabilities: ["lock"] }), null);
  assert.equal(parseDevice({ kind: "display", name: "Board", capabilities: [] }), null);
  assert.equal(parseDevice({ kind: "projector", name: "P", capabilities: ["power"] }), null);
  assert.equal(parseDevice({ kind: "display", name: " ", capabilities: ["show"] }), null);
  assert.deepEqual(parseDevice({ kind: "equipment", name: " Lights ", serial: "", capabilities: ["power", "lights", "power"] }),
    { kind: "equipment", name: "Lights", maker: null, model: null, serial: null, capabilities: ["lights", "power"] });
});

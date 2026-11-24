// SAFE-01: room status rules (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoomReport, roomBoard } from "../src/safety-rooms.js";

const R = "c1000000-0000-4000-8000-0000000000a1";
test("room reports: a room or a place; needs help needs a kind and nothing else does; counts are bounded", () => {
  assert.deepEqual(parseRoomReport({ roomId: R, status: "secured", students: 20, adults: 1 }), { roomId: R, place: null, status: "secured", need: null, students: 20, adults: 1, note: null });
  assert.equal(parseRoomReport({ place: "  Gym ", status: "moved" }).place, "Gym");
  assert.equal(parseRoomReport({ roomId: R, place: "Gym", status: "moved" }).place, null, "a chosen room wins");
  for (const bad of [{ status: "secured" }, { place: "", status: "secured" }, { roomId: "x", status: "secured" }, { roomId: R, status: "fine" },
    { roomId: R, status: "needs_help" }, { roomId: R, status: "needs_help", need: "pizza" }, { roomId: R, status: "secured", need: "medical" },
    { roomId: R, status: "secured", students: -1 }, { roomId: R, status: "secured", adults: 51 }, { roomId: R, status: "secured", students: 2.5 },
    { roomId: R, status: "secured", note: "x".repeat(201) }, null]) assert.equal(parseRoomReport(bad), null, JSON.stringify(bad));
});
test("the board: latest report per room, needs help first, places outside rooms listed, rooms not heard from counted", () => {
  const rooms = [{ id: "a", name: "Room 12" }, { id: "b", name: "Room 14" }, { id: "c", name: "Room 16" }];
  const b = roomBoard(rooms, [
    { roomId: "a", status: "needs_help", need: "medical", students: 2, at: "2026-11-23T10:00:00Z" },
    { roomId: "a", status: "secured", students: 20, at: "2026-11-23T10:05:00Z" },
    { roomId: "b", status: "not_secured", students: 18, at: "2026-11-23T10:01:00Z" },
    { roomId: null, place: "Gym", status: "needs_help", need: "threat", students: 30, at: "2026-11-23T10:02:00Z" }]);
  assert.deepEqual(b.rooms.map(r => [r.name, r.report?.status || null]), [["Gym", "needs_help"], ["Room 14", "not_secured"], ["Room 12", "secured"], ["Room 16", null]]);
  assert.equal(b.totals.reported, 2); assert.equal(b.totals.waiting, 1); assert.equal(b.totals.students, 68); assert.equal(b.totals.needs_help, 1);
});

import { deviceSafetyView } from "../src/safety-model.js";
test("SAFE-02: a lockdown darkens displays and quiets student devices; other alerts show a muted notice; all clear, then normal", () => {
  const live = (kind, deviceKind, status = "active") => ({ incident: { id: "i", kind, isDrill: false, status, startedAt: "x", reunificationPoint: status === "reunification" ? "Gym" : null }, deviceKind });
  assert.deepEqual(deviceSafetyView(live("lockdown", "display")), { mode: "dark", title: "Lockdown", message: null, volume: 0, incidentId: "i" });
  assert.equal(deviceSafetyView(live("lockdown", "kiosk")).mode, "dark");
  assert.equal(deviceSafetyView(live("lockdown", "student_device")).mode, "quiet");
  for (const k of ["shelter", "evacuate", "hold"]) { const v = deviceSafetyView(live(k, "display")); assert.equal(v.mode, "alert"); assert.equal(v.volume, 0); assert.ok(v.message); }
  assert.equal(deviceSafetyView(live("lockdown", "display", "reunification")).mode, "alert", "reunification is a notice, not dark");
  assert.equal(deviceSafetyView({ incident: null, allClearAt: "t", deviceKind: "display" }).mode, "all_clear");
  assert.deepEqual(deviceSafetyView({ incident: null, allClearAt: null, deviceKind: "display" }), { mode: "normal" });
  assert.doesNotMatch(JSON.stringify(deviceSafetyView(live("evacuate", "display"))), /roll call|staff/i, "student text only on a screen anyone can see");
});

import { hazardMessage, alertTitle, familyTitle, confirmMatches, HAZARDS, HAZARD_KIND } from "../src/safety-model.js";
test("SAFE-03: hazard titles and instructions per audience; families never hear a non-weather hazard", () => {
  assert.equal(alertTitle("shelter", "tornado"), "Shelter in place: Tornado warning");
  assert.equal(alertTitle("shelter", "hazmat", "family"), "Shelter in place");
  assert.equal(alertTitle("hold", null), "Hold in rooms");
  assert.equal(familyTitle("shelter", false, "Maple", "active", "tornado"), "Maple: Shelter in place: Tornado warning in effect");
  assert.equal(familyTitle("shelter", false, "Maple", "active", "hazmat"), "Maple: Shelter in place in effect");
  for (const h of HAZARDS) { assert.ok(hazardMessage(h, "staff")); assert.ok(hazardMessage(h, "student")); assert.ok(["shelter", "hold"].includes(HAZARD_KIND[h])); }
  assert.equal(hazardMessage("hazmat", "family"), null);
  assert.match(hazardMessage("lightning", "staff"), /30 minutes after the last thunder/);
  assert.equal(hazardMessage("meteor", "staff"), null);
  const inc = { kind: "shelter", is_drill: false, hazard: "tornado" };
  assert.equal(confirmMatches(inc, { kind: "shelter", isDrill: false, hazard: "tornado" }), true);
  assert.equal(confirmMatches(inc, { kind: "shelter", isDrill: false }), false);
  assert.equal(confirmMatches({ ...inc, hazard: null }, { kind: "shelter", isDrill: false }), true);
  const v = deviceSafetyView({ incident: { id: "i", kind: "shelter", hazard: "tornado", isDrill: true, status: "active", shelterArea: "Hallway B" }, deviceKind: "display" });
  assert.equal(v.title, "Shelter in place: Tornado warning (drill)"); assert.match(v.message, /Crouch low.*Shelter area: Hallway B\./);
});

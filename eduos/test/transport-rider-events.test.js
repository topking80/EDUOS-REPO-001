import test from "node:test";
import assert from "node:assert/strict";
import { groupTransportEvents } from "../src/transport-rider-events.js";

test("groups check-ins by run and student while preserving event order", () => {
  const events = [
    { run_id: "run-a", student_id: "student-1", event: "boarded", recorded_at: "2026-11-16T07:00:00Z", stop_name: "North", is_school: false },
    { run_id: "run-a", student_id: "student-1", event: "alighted", recorded_at: "2026-11-16T07:30:00Z", stop_name: "School", is_school: true },
    { run_id: "run-b", student_id: "student-1", event: "boarded", recorded_at: "2026-11-16T15:00:00Z", stop_name: "School", is_school: true },
    { run_id: "run-a", student_id: "student-2", event: "not_riding", recorded_at: "2026-11-16T06:50:00Z", stop_name: "South", is_school: false }
  ];
  const grouped = groupTransportEvents(events);
  assert.equal(grouped.size, 3);
  assert.deepEqual(grouped.get("run-a:student-1").map(e => e.event), ["boarded", "alighted"]);
  assert.deepEqual(grouped.get("run-b:student-1").map(e => e.event), ["boarded"]);
  assert.deepEqual(grouped.get("run-a:student-2").map(e => e.event), ["not_riding"]);
  assert.equal(grouped.get("run-a:student-1")[1].is_school, true);
});

test("returns an empty map for no matching riders", () => {
  assert.equal(groupTransportEvents([]).size, 0);
});

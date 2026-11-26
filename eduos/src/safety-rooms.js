// SAFE-01: room status rules shared by the API and tests (no database).
import { validId, cleanText } from "./role-app-util.js";

export const ROOM_STATUSES = ["secured", "not_secured", "needs_help", "moved"];
export const ROOM_NEEDS = ["medical", "threat", "missing_student", "other"];
export const REPORTER_ROLES = ["teacher", "principal", "vice_principal", "sro", "librarian", "counselor", "nurse", "coach", "maintenance", "lunch_staff", "school_secretary"];
export const VIEWER_ROLES = ["principal", "vice_principal", "sro", "superintendent"];
export const NEED_TEXT = { medical: "medical help", threat: "a threat seen or heard", missing_student: "a missing student", other: "help" };

/** Validate a report body. Returns the clean report or null. */
export function parseRoomReport(b) {
  if (!b || typeof b !== "object") return null;
  const roomId = b.roomId ?? null, place = typeof b.place === "string" ? b.place.trim() : null;
  if (roomId !== null && !validId(roomId)) return null;
  if (place !== null && place !== "" && !cleanText(place, 80)) return null;
  if (roomId === null && !place) return null;
  if (!ROOM_STATUSES.includes(b.status)) return null;
  const need = b.need ?? null;
  if ((b.status === "needs_help") !== (need !== null) || (need !== null && !ROOM_NEEDS.includes(need))) return null;
  const count = (v, max) => v === undefined || v === null || v === "" ? null : Number.isInteger(v) && v >= 0 && v <= max ? v : NaN;
  const students = count(b.students, 500), adults = count(b.adults, 50);
  if (Number.isNaN(students) || Number.isNaN(adults)) return null;
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : null;
  if (note !== null && !cleanText(note, 200)) return null;
  return { roomId, place: roomId ? null : place, status: b.status, need, students, adults, note };
}

/** Latest report per room (or named place) -> the board. */
export function roomBoard(rooms, reports) {
  const latest = new Map();
  for (const r of [...reports].sort((a, b) => new Date(b.at) - new Date(a.at))) {
    const key = r.roomId || `place:${r.place.toLowerCase()}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  const order = { needs_help: 0, not_secured: 1, moved: 2, secured: 3 };
  const list = rooms.map(room => ({ roomId: room.id, name: room.name, building: room.building, report: latest.get(room.id) || null }));
  const known = new Set(rooms.map(r => r.id));
  for (const [key, r] of latest) if (!known.has(key) && !r.roomId) list.push({ roomId: null, name: r.place, building: null, report: r });
  list.sort((a, b) => (a.report ? order[a.report.status] : 4) - (b.report ? order[b.report.status] : 4) || String(a.name).localeCompare(String(b.name)));
  const totals = { rooms: rooms.length, reported: 0, secured: 0, not_secured: 0, needs_help: 0, moved: 0, students: 0, adults: 0 };
  for (const x of list) if (x.report) {
    if (x.roomId) totals.reported++;
    totals[x.report.status]++; totals.students += x.report.students || 0; totals.adults += x.report.adults || 0;
  }
  totals.waiting = rooms.length - totals.reported;
  return { totals, rooms: list };
}


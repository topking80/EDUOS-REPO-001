// Classrooms operations helpers (db/154). Pure; safe to import in unit tests.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const validId = v => typeof v === "string" && UUID.test(v);
const cleanText = (v, max, min = 1) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max;

export const DAY_TYPES = Object.freeze(["regular", "early_release", "late_start", "assembly", "custom"]);
export const PERIOD_KINDS = Object.freeze(["instruction", "homeroom", "lunch", "passing", "assembly"]);
export const hhmm = t => String(t).slice(0, 5);

export function parseBellSchedule(body) {
  const b = body || {};
  const dayType = b.dayType || "regular";
  if (!cleanText(b.name, 80, 2) || !DAY_TYPES.includes(dayType)) return null;
  if (b.id != null && b.id !== "" && !validId(b.id)) return null;
  if (!Array.isArray(b.periods) || b.periods.length < 1 || b.periods.length > 30) return null;
  const periods = [];
  for (const p of b.periods) {
    const kind = p?.kind || "instruction";
    if (!p || !cleanText(p.label, 60, 1) || !PERIOD_KINDS.includes(kind)) return null;
    if (!TIME.test(p.starts || "") || !TIME.test(p.ends || "") || p.ends <= p.starts) return null;
    periods.push({ label: p.label.trim(), kind, starts: p.starts, ends: p.ends });
  }
  periods.sort((a, z) => (a.starts < z.starts ? -1 : a.starts > z.starts ? 1 : 0));
  for (let i = 1; i < periods.length; i++) {
    if (periods[i].starts < periods[i - 1].ends) return null;
  }
  return {
    id: b.id || null,
    name: b.name.trim(),
    dayType,
    isDefault: Boolean(b.isDefault),
    periods: periods.map((p, i) => ({ ...p, seq: i + 1 }))
  };
}

export function parseSeatingChart(body) {
  const b = body || {};
  if (b.roomId != null && b.roomId !== "" && !validId(b.roomId)) return null;
  const rowsCount = Number(b.rowsCount ?? 5), colsCount = Number(b.colsCount ?? 6);
  if (!Number.isInteger(rowsCount) || rowsCount < 1 || rowsCount > 20) return null;
  if (!Number.isInteger(colsCount) || colsCount < 1 || colsCount > 20) return null;
  if (!Array.isArray(b.assignments) || b.assignments.length > 200) return null;
  const seenStudents = new Set(), seenSeats = new Set(), assignments = [];
  for (const x of b.assignments) {
    const row = Number(x?.row), col = Number(x?.col);
    const label = x?.label == null ? "" : String(x.label).trim();
    if (!x || !validId(x.studentId) || !Number.isInteger(row) || !Number.isInteger(col)) return null;
    if (row < 1 || row > rowsCount || col < 1 || col > colsCount || label.length > 40) return null;
    const seatKey = `${row}:${col}`;
    if (seenStudents.has(x.studentId) || seenSeats.has(seatKey)) return null;
    seenStudents.add(x.studentId);
    seenSeats.add(seatKey);
    assignments.push({ studentId: x.studentId, row, col, label });
  }
  if (b.shareWithFamilies != null && typeof b.shareWithFamilies !== "boolean") return null;
  return { roomId: b.roomId || null, rowsCount, colsCount, shareWithFamilies: b.shareWithFamilies === true, assignments };
}

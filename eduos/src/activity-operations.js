// Clubs & sports operations helpers (db/152). Pure; safe to import in unit tests.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validId = v => typeof v === "string" && UUID.test(v);
export const ATTENDANCE_STATUSES = Object.freeze(["present", "late", "excused", "absent"]);
const EXPIRING_DAYS = 30;

// Physical status from the latest clearance on file. No medical details exist.
export function physicalStatus(latest, today = new Date()) {
  if (!latest) return { status: "missing", clearedOn: null, expiresOn: null };
  const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const expiresOn = iso(latest.expires_on), clearedOn = iso(latest.cleared_on);
  const now = iso(today);
  if (expiresOn < now) return { status: "expired", clearedOn, expiresOn };
  const soon = new Date(`${now}T00:00:00Z`); soon.setUTCDate(soon.getUTCDate() + EXPIRING_DAYS);
  return { status: expiresOn <= iso(soon) ? "expiring" : "cleared", clearedOn, expiresOn };
}

export function validMarks(marks) {
  if (!Array.isArray(marks) || marks.length < 1 || marks.length > 300) return false;
  const seen = new Set();
  for (const m of marks) {
    if (!m || !validId(m.studentId) || !ATTENDANCE_STATUSES.includes(m.status) || seen.has(m.studentId)) return false;
    seen.add(m.studentId);
  }
  return true;
}


export function gradeNumber(gradeLevel) {
  if (gradeLevel == null) return null;
  const t = String(gradeLevel).trim().toUpperCase();
  if (!t) return null;
  if (t === "K" || t === "PK" || t === "KG" || t === "PREK") return 0;
  const m = /^(?:GRADE\s*)?(\d{1,2})(?:ST|ND|RD|TH)?$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    return n >= 0 && n <= 12 ? n : null;
  }
  return null;
}

// Club sign-up needs guardian approval until high school (grades below 9).
export function requiresGuardianForClub(gradeLevel) {
  const g = gradeNumber(gradeLevel);
  return g === null || g < 9;
}

// 34.4 derived operational exceptions. This module is deliberately read-only:
// it classifies server-authorized records and never changes attendance or handoffs.
const DEFAULT_PENDING_MINUTES = 10;
const DEFAULT_ATTENDANCE_MINUTES = 15;

export function classifyArrivalExceptions(records, {
  now = new Date(),
  pendingMinutes = DEFAULT_PENDING_MINUTES,
  attendanceMinutes = DEFAULT_ATTENDANCE_MINUTES,
} = {}) {
  if (!Array.isArray(records)) throw new TypeError('arrival_records_must_be_array');
  const instant = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(instant)) throw new TypeError('invalid_now');
  const exceptions = [];
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || typeof record.initiatedAt !== 'string') continue;
    const initiated = new Date(record.initiatedAt).getTime();
    if (!Number.isFinite(initiated) || initiated > instant) continue;
    const ageMinutes = Math.floor((instant - initiated) / 60000);
    if (record.status === 'pending' && ageMinutes >= pendingMinutes) {
      exceptions.push({
        id: `arrival-pending:${record.id}`,
        handoffId: record.id,
        kind: 'handoff_awaiting_receipt',
        severity: ageMinutes >= pendingMinutes * 3 ? 'high' : 'medium',
        ageMinutes,
        studentId: record.studentId ?? null,
        schoolId: record.schoolId ?? null,
        initiatedAt: record.initiatedAt,
      });
    }
    if (record.status === 'received' && record.attendanceRecorded === false && ageMinutes >= attendanceMinutes) {
      exceptions.push({
        id: `arrival-attendance:${record.id}`,
        handoffId: record.id,
        kind: 'first_attendance_missing',
        severity: ageMinutes >= attendanceMinutes * 3 ? 'high' : 'medium',
        ageMinutes,
        studentId: record.studentId ?? null,
        schoolId: record.schoolId ?? null,
        initiatedAt: record.initiatedAt,
      });
    }
  }
  return exceptions.sort((a, b) => b.ageMinutes - a.ageMinutes || a.id.localeCompare(b.id));
}

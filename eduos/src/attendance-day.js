// One authoritative attendance event per student per school day.
//
// Every path that writes a day's first attendance (POST /api/attendance and the
// arrival first-attendance route) takes this transaction lock first, then
// checks for an existing event, so two writers can't both see "none yet".
// The key is built in SQL from the uuid and the date, so callers passing a
// string date or a date from PostgreSQL get the same lock.
export function lockStudentDay(client, studentId, day) {
  return client.query("SELECT pg_advisory_xact_lock(hashtext('eduos-attendance-day'), hashtext($1::uuid::text || '/' || $2::date::text))", [studentId, day]);
}

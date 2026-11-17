// EduOS 37.6.0 Edison: operations trends for school leaders. PURE (no I/O).
// Input is ONLY what the EDEN aggregation gate released (release() in
// src/eden/aggregation-gate.js): count tables with cells under K_MIN (5)
// and complementary cells published as null. Edison reads the published
// margins (the "ALL" row) and never tries to recover a suppressed cell.
// Rates are computed from published counts only, as the gate allows.

/** The last `days` school days (Mon-Fri) up to and including `today` (YYYY-MM-DD), oldest first. */
export function schoolDays(today, days) {
  const out = [];
  const d = new Date(`${today}T12:00:00Z`);
  while (out.length < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

const ALL = "ALL";
const STATUSES = ["present", "tardy", "absent", "excused", "not_recorded"];
const EVENTS = ["boarded", "alighted", "not_riding", "no_checkin"];
const val = (cells, pred) => { const c = cells.find(pred); return c ? c.count : undefined; };

/** One released attendance_daily payload -> the school's published day totals. */
export function attendanceDay(released) {
  const cells = released.cells || [];
  if (!cells.length) return { date: released.period, total: 0, counts: {}, suppressed: [] };
  const total = val(cells, c => c.grade === ALL && c.status === ALL);
  const counts = {}, suppressed = [];
  for (const st of STATUSES) {
    const v = val(cells, c => c.grade === ALL && c.status === st);
    if (v === undefined) continue;
    if (v === null) suppressed.push(st); else counts[st] = v;
  }
  return { date: released.period, total: total ?? null, counts, suppressed };
}

/** One released transport_checkins_daily payload -> published event totals. */
export function transportDay(released) {
  const cells = released.cells || [];
  const total = val(cells, c => c.route === ALL && c.event === ALL);
  const counts = {}, suppressed = [];
  for (const ev of EVENTS) {
    const v = val(cells, c => c.route === ALL && c.event === ev);
    if (v === undefined) continue;
    if (v === null) suppressed.push(ev); else counts[ev] = v;
  }
  return { date: released.period, riders: total ?? null, counts, suppressed };
}

/** One released enrollment_by_grade payload -> published total. */
export function enrollmentTotal(released) {
  const v = val(released.cells || [], c => c.grade === ALL);
  return v === undefined ? 0 : v;
}

/** Share of students in school on a day, from published counts only (null if not computable). */
export function inSchoolShare(day) {
  // A status with no cell at all is a published zero; a withheld one is unknown.
  const notRecorded = day.suppressed.includes("not_recorded") ? null : (day.counts.not_recorded ?? 0);
  const recorded = day.total != null && notRecorded != null ? day.total - notRecorded : null;
  if (!recorded || day.counts.present == null || (day.counts.tardy == null && day.suppressed.includes("tardy"))) return null;
  return (day.counts.present + (day.counts.tardy || 0)) / recorded;
}

/** Local (no network) brief over the trends context. */
export function edisonLocalBrief(ctx) {
  const lines = [`Edison trends (${ctx.scope === "district" ? `district, ${ctx.schools.length} schools` : "your school"}, last ${ctx.days} school days)`,
    `Counts below ${ctx.k} are withheld by the aggregation gate; Edison never estimates them.`, ""];
  let action = "monitor; nothing stands out in the published counts.";
  for (const s of ctx.schools) {
    const shares = s.attendance.map(d => ({ date: d.date, v: inSchoolShare(d) })).filter(x => x.v != null);
    if (!shares.length) { lines.push(`• ${s.label}: no attendance day with publishable counts.`); continue; }
    const avg = shares.reduce((n, x) => n + x.v, 0) / shares.length;
    const low = shares.reduce((m, x) => (x.v < m.v ? x : m), shares[0]);
    const half = Math.floor(shares.length / 2);
    const older = shares.slice(0, half), newer = shares.slice(half);
    const mean = a => a.reduce((n, x) => n + x.v, 0) / a.length;
    const trend = older.length && newer.length ? mean(newer) - mean(older) : 0;
    lines.push(`• ${s.label}: ${Math.round(avg * 100)}% in school on ${shares.length} recorded day(s); lowest ${low.date} (${Math.round(low.v * 100)}%)` +
      `${Math.abs(trend) >= 0.02 ? `; ${trend > 0 ? "improving" : "declining"} by ${Math.round(Math.abs(trend) * 100)} points` : "; steady"}.`);
    if (s.transport && s.transport.riders && s.transport.counts.no_checkin != null && s.transport.counts.no_checkin / s.transport.riders > 0.2)
      lines.push(`  Transport today: ${s.transport.counts.no_checkin} of ${s.transport.riders} assigned riders have no check-in yet.`);
    if (trend <= -0.03) action = `look at attendance at ${s.label} (declining over the period).`;
  }
  lines.push("", `Recommended next action: ${action}`);
  return lines.join("\n");
}

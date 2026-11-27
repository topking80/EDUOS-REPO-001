// HSP-02: progress reports, transcripts and portfolios for a homeschool
// learner. PURE: no I/O. Every document says who issued it (the family) and
// what it is not: not verified by EduOS or any school, not an official,
// state-approved or accredited transcript.
import crypto from "node:crypto";

export const EXPORT_FORMAT = "eduos-homeschool-record-1";
export const KINDS = ["progress_report", "transcript", "portfolio"];
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v);
export const sha256Of = doc => crypto.createHash("sha256").update(canonical(doc)).digest("hex");
const ymd = v => v instanceof Date ? v.toISOString().slice(0, 10) : v;
const num = v => v == null ? null : Number(v);

export const ISSUER_STATEMENT = "Family record, entered by the family named here. Not verified by EduOS or any school, and not an official, state-approved or accredited transcript. Requirements vary by state; check with your education authority.";
const provenanceOf = w => w.provenance === "external" ? `Entered by the family from ${w.source}` : "Entered by the family";

/** Attendance totals: days with any instruction and minutes, by kind. */
export function attendanceTotals(entries) {
  const live = entries.filter(a => !a.voided_at);
  const byKind = {};
  for (const a of live) byKind[a.kind] = (byKind[a.kind] || 0) + Number(a.minutes);
  const days = new Set(live.filter(a => a.kind !== "absent" && Number(a.minutes) > 0).map(a => ymd(a.day)));
  const absent = new Set(live.filter(a => a.kind === "absent").map(a => ymd(a.day)));
  return { instructionalDays: days.size, absentDays: [...absent].filter(d => !days.has(d)).length,
    minutes: Object.values(byKind).reduce((n, m) => n + m, 0), hours: Math.round(Object.values(byKind).reduce((n, m) => n + m, 0) / 6) / 10, minutesByKind: byKind };
}

/** Scored work as a percent (sum of scores over sum of maximums), or null. */
export function percentOf(work) {
  const scored = work.filter(w => !w.voided_at && w.score != null && w.max_score != null);
  const max = scored.reduce((n, w) => n + Number(w.max_score), 0);
  return max ? Math.round((scored.reduce((n, w) => n + Number(w.score), 0) / max) * 1000) / 10 : null;
}

const header = ({ id, kind, family, learner, generatedBy, generatedOn, from, to }) => ({
  format: EXPORT_FORMAT, id, kind,
  issuer: { kind: "homeschool_family", name: family.display_name, statement: ISSUER_STATEMENT },
  learner: { name: learner.display_name, grade_band: learner.grade_band ?? null },
  period: from || to ? { from: from ?? null, to: to ?? null } : null,
  generated: { on: generatedOn, by: generatedBy },
});

export function buildProgressReport(x) {
  const inPeriod = d => (!x.from || ymd(d) >= x.from) && (!x.to || ymd(d) <= x.to);
  const work = x.work.filter(w => !w.voided_at && inPeriod(w.done_on));
  const att = x.attendance.filter(a => inPeriod(a.day));
  return { ...header({ ...x, kind: "progress_report" }),
    attendance: attendanceTotals(att),
    courses: x.courses.filter(c => c.status !== "archived").map(c => {
      const cw = work.filter(w => w.course_id === c.id);
      return { title: c.title, subject: c.subject ?? null, school_year: c.school_year, status: c.status, work_items: cw.length, percent: percentOf(cw),
        goals: x.goals.filter(g => g.course_id === c.id).map(g => ({ text: g.text, status: g.status, met_on: ymd(g.met_on) ?? null })) };
    }),
    goals: x.goals.filter(g => !g.course_id).map(g => ({ text: g.text, status: g.status, met_on: ymd(g.met_on) ?? null })),
    unassigned_work_items: work.filter(w => !w.course_id).length };
}

export function buildTranscript(x) {
  const done = x.courses.filter(c => c.status === "completed");
  const years = [...new Set(done.map(c => c.school_year))].sort();
  return { ...header({ ...x, kind: "transcript" }),
    years: years.map(y => ({ school_year: y, courses: done.filter(c => c.school_year === y).map(c => ({ title: c.title, subject: c.subject ?? null,
      final_grade: c.final_grade ?? null, credits: num(c.credits), completed_on: ymd(c.completed_on) })) })),
    total_credits: Math.round(done.reduce((n, c) => n + (num(c.credits) || 0), 0) * 100) / 100 };
}

export function buildPortfolio(x) {
  const inPeriod = d => (!x.from || ymd(d) >= x.from) && (!x.to || ymd(d) <= x.to);
  const title = id => x.courses.find(c => c.id === id)?.title ?? null;
  return { ...header({ ...x, kind: "portfolio" }),
    items: x.work.filter(w => !w.voided_at && inPeriod(w.done_on)).sort((a, b) => String(ymd(a.done_on)).localeCompare(String(ymd(b.done_on))))
      .map(w => ({ title: w.title, kind: w.kind, course: title(w.course_id), done_on: ymd(w.done_on), score: num(w.score), max_score: num(w.max_score), grade_label: w.grade_label ?? null,
        notes: w.notes ?? null, provenance: provenanceOf(w) })) };
}

export const builders = { progress_report: buildProgressReport, transcript: buildTranscript, portfolio: buildPortfolio };

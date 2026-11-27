// HSP-06 part 2: the shape of a compliance profile's requirements, shared by
// the platform's template tool and a family's or school's own profile.
//
//   { instruction?: { days?, hours?, note? },
//     subjects?: [string],
//     deadlines?: [{ key, label, month, day, note? }],          an annual date in the school year
//     documents?: [{ key, label, perLearner?, note? }],          things to keep or send
//     assessments?: [{ key, label, grades?, note? }],
//     retentionYears? }
// Nothing here says what any jurisdiction requires; templates carry their own
// sources and review, and custom profiles are labelled as set by the tenant.
const KEY = /^[a-z0-9_]{2,60}$/;
const GRADES = ["pre_k", "k", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
const text = (v, max) => typeof v === "string" && v.trim().length >= 1 && v.length <= max;
const opt = (v, max) => v == null || text(v, max);

export function validateRequirements(r) {
  const bad = error => ({ ok: false, error });
  if (!r || typeof r !== "object" || Array.isArray(r)) return bad("requirements must be an object");
  const allowed = ["instruction", "subjects", "deadlines", "documents", "assessments", "retentionYears"];
  const extra = Object.keys(r).filter(k => !allowed.includes(k));
  if (extra.length) return bad(`unknown field: ${extra[0]}`);
  if (r.instruction != null) {
    const i = r.instruction;
    if (typeof i !== "object" || Array.isArray(i) || Object.keys(i).some(k => !["days", "hours", "note"].includes(k))) return bad("instruction: days, hours, note");
    if (i.days != null && (!Number.isInteger(i.days) || i.days < 1 || i.days > 366)) return bad("instruction.days: 1-366");
    if (i.hours != null && (typeof i.hours !== "number" || i.hours <= 0 || i.hours > 2000)) return bad("instruction.hours: up to 2000");
    if (!opt(i.note, 500)) return bad("instruction.note: up to 500 characters");
  }
  if (r.subjects != null && (!Array.isArray(r.subjects) || r.subjects.length > 30 || r.subjects.some(s => !text(s, 80)))) return bad("subjects: up to 30 names");
  const keys = new Set();
  const list = (name, max, each) => {
    const v = r[name];
    if (v == null) return null;
    if (!Array.isArray(v) || v.length > max) return `${name}: up to ${max} items`;
    for (const x of v) {
      if (!x || typeof x !== "object" || !KEY.test(x.key ?? "") || !text(x.label, 160) || !opt(x.note, 500)) return `${name}: each needs a key (a-z, 0-9, _), a label and an optional note`;
      if (keys.has(x.key)) return `duplicate key: ${x.key}`;
      keys.add(x.key);
      const e = each(x); if (e) return `${name}.${x.key}: ${e}`;
    }
    return null;
  };
  const e1 = list("deadlines", 20, x => !Number.isInteger(x.month) || x.month < 1 || x.month > 12 || !Number.isInteger(x.day) || x.day < 1 || x.day > 31
    || new Date(Date.UTC(2000, x.month - 1, x.day)).getUTCMonth() !== x.month - 1 ? "month and day" : null);
  if (e1) return bad(e1);
  const e2 = list("documents", 30, x => x.perLearner != null && typeof x.perLearner !== "boolean" ? "perLearner is true or false" : null);
  if (e2) return bad(e2);
  const e3 = list("assessments", 20, x => x.grades != null && (!Array.isArray(x.grades) || x.grades.some(g => !GRADES.includes(g))) ? "grades like k, 1 … 12" : null);
  if (e3) return bad(e3);
  if (r.retentionYears != null && (!Number.isInteger(r.retentionYears) || r.retentionYears < 1 || r.retentionYears > 100)) return bad("retentionYears: 1-100");
  return { ok: true };
}

// "2026-2027" → { from: "2026-07-01", to: "2027-06-30" }
export function schoolYearRange(sy) {
  const [a, b] = sy.split("-").map(Number);
  return { from: `${a}-07-01`, to: `${b}-06-30` };
}
export function deadlineDate(sy, month, day) {
  const [a, b] = sy.split("-").map(Number);
  return `${month >= 7 ? a : b}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
export function currentSchoolYear(d = new Date()) {
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}
export const DISCLAIMER = "Requirements differ by place and change. This is a planning aid, not legal advice, and EduOS doesn't decide whether you comply or file anything with any agency. "
  + "Check the official source, or ask a qualified adviser, for anything you rely on.";

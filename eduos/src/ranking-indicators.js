// RANK-01: the six U.S. News Best High Schools indicators, as a school tracks
// its own figures for them. Weights as U.S. News publishes them. EduOS doesn't
// compute a rank: U.S. News compares every school in the state and nationally
// and models expected results, which can't be redone from one school's data.

const count = (v, max = 100000) => Number.isInteger(v) && v >= 0 && v <= max;
const pct = v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;
const optPct = v => v == null || pct(v);
const round1 = n => Math.round(n * 10) / 10;
const share = (a, b) => b ? round1((a / b) * 100) : null;

export const INDICATORS = {
  college_readiness: { name: "College readiness", weight: 30,
    about: "12th graders who took at least one AP or IB exam, and who earned a qualifying score on at least one.",
    fields: [["seniors", "12th graders"], ["tookExam", "Took at least one AP/IB exam"], ["qualified", "Earned a qualifying score on at least one"]],
    check: v => count(v.seniors) && v.seniors > 0 && count(v.tookExam) && count(v.qualified) && v.qualified <= v.tookExam && v.tookExam <= v.seniors,
    show: v => ({ "Took an exam": share(v.tookExam, v.seniors), "Qualifying score": share(v.qualified, v.seniors) }) },
  curriculum_breadth: { name: "College curriculum breadth", weight: 10,
    about: "12th graders who took, and who passed, AP or IB exams in more than one content area.",
    fields: [["seniors", "12th graders"], ["tookMultiple", "Took exams in several content areas"], ["passedMultiple", "Passed exams in several content areas"]],
    check: v => count(v.seniors) && v.seniors > 0 && count(v.tookMultiple) && count(v.passedMultiple) && v.passedMultiple <= v.tookMultiple && v.tookMultiple <= v.seniors,
    show: v => ({ "Took several areas": share(v.tookMultiple, v.seniors), "Passed several areas": share(v.passedMultiple, v.seniors) }) },
  assessment_proficiency: { name: "State assessment proficiency", weight: 20,
    about: "Share of students proficient on the state's required tests (math, reading, science).",
    fields: [["math", "Math, % proficient"], ["reading", "Reading, % proficient"], ["science", "Science, % proficient (if tested)"]],
    check: v => pct(v.math) && pct(v.reading) && optPct(v.science),
    show: v => ({ Math: v.math, Reading: v.reading, ...(v.science != null ? { Science: v.science } : {}) }) },
  assessment_performance: { name: "State assessment performance", weight: 20,
    about: "How state test results compare with what U.S. News models for a school with these demographics in this state. U.S. News computes it; record the value it publishes.",
    fields: [["published", "Value U.S. News published (optional)"], ["note", "Note (optional)"]],
    check: v => (v.published == null || (typeof v.published === "number" && Number.isFinite(v.published) && Math.abs(v.published) <= 1000)) && (v.note == null || (typeof v.note === "string" && v.note.length <= 300)),
    show: v => (v.published != null ? { "Published value": v.published } : {}) },
  underserved_performance: { name: "Underserved student performance", weight: 10,
    about: "How Black, Hispanic and low-income students score on state tests, compared with students who aren't underserved across the state.",
    fields: [["underserved", "Underserved students here, % proficient"], ["stateOthers", "Students not underserved, statewide, % proficient"]],
    check: v => pct(v.underserved) && pct(v.stateOthers),
    show: v => ({ "Underserved here": v.underserved, "Others statewide": v.stateOthers, Gap: round1(v.underserved - v.stateOthers) }) },
  graduation_rate: { name: "Graduation rate", weight: 10,
    about: "Four-year adjusted cohort graduation rate.",
    fields: [["rate", "Four-year graduation rate, %"], ["cohortStart", "Cohort entered 9th grade (year)"]],
    check: v => pct(v.rate) && (v.cohortStart == null || (Number.isInteger(v.cohortStart) && v.cohortStart >= 2000 && v.cohortStart <= 2100)),
    show: v => ({ "Graduation rate": v.rate }) }
};
export const PUBLISHED = { name: "Published U.S. News result", about: "The rank U.S. News published for this school, for the record.",
  fields: [["nationalRank", "National rank"], ["stateRank", "State rank"]],
  check: v => (v.nationalRank == null || (Number.isInteger(v.nationalRank) && v.nationalRank >= 1 && v.nationalRank <= 50000))
    && (v.stateRank == null || (Number.isInteger(v.stateRank) && v.stateRank >= 1 && v.stateRank <= 50000)) && (v.nationalRank != null || v.stateRank != null),
  show: v => ({ ...(v.nationalRank != null ? { National: v.nationalRank } : {}), ...(v.stateRank != null ? { State: v.stateRank } : {}) }) };
export const KINDS = { ...INDICATORS, published_rank: PUBLISHED };

/** Only the indicator's own fields, checked. */
export function cleanValues(kind, values) {
  const def = KINDS[kind];
  if (!def || !values || typeof values !== "object" || Array.isArray(values)) return null;
  const v = Object.fromEntries(def.fields.map(([k]) => [k, values[k] === "" || values[k] === undefined ? null : values[k]]));
  if (typeof v.note === "string") v.note = v.note.trim() || null;
  return def.check(v) ? v : null;
}
export const display = (kind, v) => KINDS[kind].show(v);
export const validYear = y => typeof y === "string" && /^\d{4}-\d{2}$/.test(y) && Number(y.slice(5)) === (Number(y.slice(2, 4)) + 1) % 100;

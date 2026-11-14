// EduOS 32.6.0 gradebook rules (pure). The course grade is a weighted average
// of category percentages; a category with no graded work is left out and the
// remaining weights are rescaled, so ungraded work never counts as zero.
// Work marked "missing" by the teacher counts as 0. Letter grades use a plain
// 90/80/70/60 scale. Quiz retakes count by the assignment's policy.
export const LETTERS = [[90, "A"], [80, "B"], [70, "C"], [60, "D"], [0, "F"]];
export const letterFor = pct => LETTERS.find(([min]) => pct >= min)[1];

/** Effective score (0..1) across quiz attempts by policy. attempts: [{total, possible}] scored ones. */
export function effectiveAttempt(attempts, policy = "highest") {
  const scored = attempts.filter(a => a.total != null && Number(a.possible) > 0).map(a => Number(a.total) / Number(a.possible));
  if (!scored.length) return null;
  if (policy === "latest") return scored[scored.length - 1];
  if (policy === "average") return scored.reduce((x, y) => x + y, 0) / scored.length;
  return Math.max(...scored);
}

/**
 * items: [{id, category, points, earned (null = not graded), missing?}]
 * weights: {"Classwork":40,"Quizzes":60}
 * -> {percent|null, letter|null, categories:[{name, weight, earned, possible, percent, used}]}
 */
export function courseGrade(items, weights = {}) {
  const cats = new Map();
  for (const it of items) {
    const name = it.category || "Classwork";
    const c = cats.get(name) || { name, earned: 0, possible: 0, graded: 0 };
    if (it.earned != null || it.missing) { c.earned += it.missing && it.earned == null ? 0 : Number(it.earned); c.possible += Number(it.points); c.graded++; }
    cats.set(name, c);
  }
  for (const name of Object.keys(weights)) if (!cats.has(name)) cats.set(name, { name, earned: 0, possible: 0, graded: 0 });
  const list = [...cats.values()].map(c => ({ ...c, weight: Number(weights[c.name] ?? 0) || (Object.keys(weights).length ? 0 : 1),
    percent: c.possible ? Math.round((c.earned / c.possible) * 1000) / 10 : null }));
  const used = list.filter(c => c.percent != null && c.weight > 0);
  const totalWeight = used.reduce((x, c) => x + c.weight, 0);
  for (const c of list) c.used = used.includes(c);
  if (!totalWeight) return { percent: null, letter: null, categories: list };
  const percent = Math.round((used.reduce((x, c) => x + c.percent * c.weight, 0) / totalWeight) * 10) / 10;
  return { percent, letter: letterFor(percent), categories: list };
}

/** Rubric: [{id,title,standardId?,levels:[{points,label}]}]; scores: [{criterionId, points, comment?}]. */
export function validRubric(rubric) {
  if (!Array.isArray(rubric) || rubric.length < 1 || rubric.length > 12) return false;
  const ids = new Set();
  return rubric.every(c => c && typeof c.id === "string" && /^[a-z0-9_-]{1,20}$/i.test(c.id) && !ids.has(c.id) && ids.add(c.id) &&
    typeof c.title === "string" && c.title.trim().length >= 1 && c.title.length <= 120 &&
    (c.standardId == null || typeof c.standardId === "string") &&
    Array.isArray(c.levels) && c.levels.length >= 2 && c.levels.length <= 6 &&
    c.levels.every(l => Number.isFinite(l?.points) && l.points >= 0 && l.points <= 100 && typeof l.label === "string" && l.label.length >= 1 && l.label.length <= 60));
}
export function rubricTotals(rubric, scores) {
  let earned = 0, possible = 0;
  const rows = rubric.map(c => {
    const max = Math.max(...c.levels.map(l => l.points));
    const s = scores.find(x => x.criterionId === c.id);
    if (!s || !c.levels.some(l => l.points === s.points)) throw new Error(`criterion ${c.id} needs one of its level scores`);
    earned += s.points; possible += max;
    return { criterionId: c.id, title: c.title, standardId: c.standardId || null, points: s.points, max, label: c.levels.find(l => l.points === s.points).label, comment: s.comment || null };
  });
  return { earned, possible, percent: possible ? Math.round((earned / possible) * 1000) / 10 : 0, rows };
}

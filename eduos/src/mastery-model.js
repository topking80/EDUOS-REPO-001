// EduOS 32.6.0 mastery model: one transparent number per learner and standard.
// Pure functions, no I/O. It replaces the 32.4 per-skill moving estimate.
//
//   mastery = 100 × Σ(score × weight × recency) / Σ(weight × recency)
//
//   score    0..1 for one piece of evidence (a quiz item, a rubric row, or a
//            finished Christie practice problem)
//   weight   by source: quiz 1.0, rubric 1.0, Christie practice 0.5
//   recency  0.8^k for the k-th newest piece (newest k=0); only the 8 newest count
//
// Levels: "emerging" below 50, "developing" 50-79, "mastered" at 80+ but only
// with at least 3 pieces of evidence, at least one of them assessed (quiz or
// rubric), so practice alone never marks a standard mastered. Nothing here
// predicts, ranks or profiles a learner; it only summarises their own work.
export const MASTERED_AT = 80;
export const DEVELOPING_AT = 50;
export const MIN_EVIDENCE = 3;
export const WINDOW = 8;
export const DECAY = 0.8;
export const SOURCE_WEIGHT = Object.freeze({ quiz: 1, rubric: 1, christie: 0.5 });
export const SOURCE_LABEL = Object.freeze({ quiz: "Quiz", rubric: "Rubric", christie: "Christie practice" });

const clamp01 = n => Math.max(0, Math.min(1, Number(n) || 0));

/** evidence: [{source, score, weight?, observed_at|at, label}] in any order. */
export function computeMastery(evidence = []) {
  const sorted = [...evidence].sort((a, b) => new Date(b.observed_at ?? b.at) - new Date(a.observed_at ?? a.at)).slice(0, WINDOW);
  let num = 0, den = 0;
  const rows = sorted.map((e, k) => {
    const weight = Number(e.weight ?? SOURCE_WEIGHT[e.source] ?? 1);
    const recency = DECAY ** k;
    const w = weight * recency;
    num += clamp01(e.score) * w; den += w;
    return { source: e.source, label: e.label, score: Math.round(clamp01(e.score) * 100), weight, recency: Number(recency.toFixed(3)), w, at: e.observed_at ?? e.at };
  });
  const mastery = den ? Math.round((num / den) * 100) : 0;
  const assessed = evidence.filter(e => e.source !== "christie").length;
  let level = mastery >= MASTERED_AT ? "mastered" : mastery >= DEVELOPING_AT ? "developing" : "emerging";
  let reason = null;
  if (level === "mastered" && evidence.length < MIN_EVIDENCE) { level = "developing"; reason = `needs ${MIN_EVIDENCE - evidence.length} more piece${MIN_EVIDENCE - evidence.length > 1 ? "s" : ""} of evidence`; }
  else if (level === "mastered" && assessed === 0) { level = "developing"; reason = "needs one quiz or rubric check (practice alone can't confirm mastery)"; }
  for (const r of rows) { r.share = den ? Math.round((r.w / den) * 100) : 0; delete r.w; }
  return { mastery, level, reason, evidenceCount: evidence.length, assessedCount: assessed, used: rows };
}

/** A plain-language explanation of computeMastery's result. */
export function explainMastery(result) {
  if (!result.evidenceCount) return "No evidence yet. Mastery starts after the first quiz, graded rubric or Christie practice on this standard.";
  const parts = result.used.map(r => `${SOURCE_LABEL[r.source] || r.source} "${r.label}": ${r.score}% (counts ${r.share}%)`);
  return `${result.mastery}% from the ${result.used.length} most recent piece${result.used.length > 1 ? "s" : ""} of evidence, newer work counting more: ${parts.join("; ")}.` +
    (result.reason ? ` Not yet "mastered": ${result.reason}.` : "");
}

/** Did this update cross into "mastered" for the first time? (EDAL milestone) */
export const isNewMilestone = (before, after) => after.level === "mastered" && !before?.mastered_at;

/** Course progress for a learner: share of the course's standards mastered and the average. */
export function courseMastery(standardIds, byStandard) {
  if (!standardIds.length) return { average: 0, mastered: 0, total: 0 };
  let sum = 0, mastered = 0;
  for (const id of standardIds) { const m = byStandard.get(id); sum += m?.mastery || 0; if (m?.level === "mastered") mastered++; }
  return { average: Math.round(sum / standardIds.length), mastered, total: standardIds.length };
}

// EduOS 32.6.0 quiz auto-scoring (pure). Multiple choice and numeric items are
// scored automatically. Short answers are auto-credited only when they match
// one of the teacher's accepted answers; anything else waits for the teacher
// (correct = null), because a different wording may still be right. Primary-
// source analysis items are always read by the teacher.
import { isCorrect, normalizeAnswer } from "./christie/tutor.js";

function toNumber(s) {
  const t = String(s ?? "").trim().replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const f = /^(-?\d+)\s*\/\s*(\d+)$/.exec(t);
  if (f && Number(f[2]) !== 0) return Number(f[1]) / Number(f[2]);
  const m = /^(-?\d+)\s+(\d+)\/(\d+)$/.exec(t);            // mixed number 1 1/2
  if (m && Number(m[3]) !== 0) return Number(m[1]) + Math.sign(Number(m[1]) || 1) * Number(m[2]) / Number(m[3]);
  return null;
}
/** -> {correct: true|false|null, points} */
export function scoreItem(item, key, response) {
  const r = String(response ?? "").trim();
  const pts = Number(item.points);
  if (item.kind === "source") return { correct: null, points: null };
  if (!r) return { correct: false, points: 0 };
  if (item.kind === "mc") { const ok = Number(r) === Number(key?.index); return { correct: ok, points: ok ? pts : 0 }; }
  if (item.kind === "numeric") {
    const want = toNumber(key?.value), got = toNumber(r), tol = Math.abs(Number(key?.tolerance) || 0);
    const ok = want !== null && got !== null && Math.abs(want - got) <= tol + 1e-9;
    return { correct: ok, points: ok ? pts : 0 };
  }
  const accepted = Array.isArray(key?.accepted) ? key.accepted : [];
  if (accepted.some(a => normalizeAnswer(a) === normalizeAnswer(r) || isCorrect(r, a))) return { correct: true, points: pts };
  return { correct: null, points: null };
}
export function validKey(kind, key, choices) {
  if (!key || typeof key !== "object") return false;
  if (kind === "mc") return Number.isInteger(key.index) && key.index >= 0 && key.index < (choices?.length || 0);
  if (kind === "numeric") return toNumber(key.value) !== null && (key.tolerance === undefined || (Number.isFinite(key.tolerance) && key.tolerance >= 0));
  if (kind === "short") return Array.isArray(key.accepted) && key.accepted.length <= 10 && key.accepted.every(a => typeof a === "string" && a.length <= 200);
  return kind === "source";
}
/** Deadline for a timed quiz with the learner's extra-time accommodation. */
export function deadlineFor(startedAt, minutes, extraPct = 0) {
  if (!minutes) return null;
  return new Date(new Date(startedAt).getTime() + Math.round(minutes * (1 + (Number(extraPct) || 0) / 100) * 60_000));
}

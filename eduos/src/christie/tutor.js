// 32.4.0 Christie tutor: pure, deterministic rules (no I/O).
// Christie is hint-first: it never states the answer to a practice item. A
// wrong attempt earns the next approved hint; asking for the answer earns a
// polite refusal plus a hint; words that suggest a learner needs a person are
// routed to a trusted adult (the session is flagged for the teacher). Nothing
// here predicts, scores or profiles the learner beyond the per-skill mastery
// estimate shown to them and their teacher.

export const MASTERED_AT = 80;
const ALPHA = 0.35;

const stripVar = s => s.replace(/^[a-z]\s*=\s*/, "");
export function normalizeAnswer(v) {
  return stripVar(String(v ?? "").toLowerCase().normalize("NFKC").trim().replace(/\s+/g, " ").replace(/[.!]+$/, "").trim()).replace(/\s+/g, "");
}
function asNumber(s) {
  const t = s.replace(/,/g, "");
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const f = /^(-?\d+)\/(\d+)$/.exec(t);
  if (f && Number(f[2]) !== 0) return Number(f[1]) / Number(f[2]);
  return null;
}
export function isCorrect(attempt, answer) {
  const a = normalizeAnswer(attempt), b = normalizeAnswer(answer);
  if (!a) return false;
  if (a === b) return true;
  const x = asNumber(a), y = asNumber(b);
  return x !== null && y !== null && Math.abs(x - y) < 1e-9;
}

const ANSWER_REQUEST = /\b(tell me the answer|give me the answer|what('?s| is) the answer|just (tell|give|say)|answer (is|please)|solve it for me|do it for me|show me the answer)\b/i;
// A learner's own words that an adult should see. This is not monitoring or
// scoring: it only reacts to what the learner typed in this chat.
const NEEDS_ADULT = /\b(hurt(ing)? me|hit me|unsafe|not safe|scared|afraid|bull(y|ied|ying)|kill|suicide|self[- ]?harm|harm myself|die|abuse|touch(ed)? me|sad all the time|(talk|speak) to (a|an|my|the) (real )?(adult|person|human|teacher|counselor|counsellor|grown[- ]?up|parent|mom|dad)|need help at home)\b/i;

export function classifyQuestion(text) {
  const t = String(text || "");
  if (NEEDS_ADULT.test(t)) return "needs_adult";
  if (ANSWER_REQUEST.test(t)) return "answer_request";
  return "help";
}

/** Score for one finished item: 1 first try without hints, 0.6 with help, 0 skipped. */
export function itemScore({ correct, hintLevel, wrongAttempts }) {
  if (!correct) return 0;
  return hintLevel === 0 && wrongAttempts === 0 ? 1 : 0.6;
}
/** Simple moving estimate (0-100). Documented as an estimate, not a test score. */
export function nextMastery(previous, score) {
  const p = Math.max(0, Math.min(100, Number(previous) || 0));
  return Math.max(0, Math.min(100, Math.round(p + (score * 100 - p) * ALPHA)));
}

export const MESSAGES = Object.freeze({
  greeting: (title) => `Hi! I'm Christie. Let's practice "${title}" together. I'll give you hints, and you do the solving.`,
  correct: ["Great job, you solved it!", "Nice work, that's right!", "Yes! You figured it out."],
  correctWithHelp: ["That's right! Using hints is a smart way to learn.", "You got it with a little help. Well done!"],
  tryAgain: "Not quite yet. Here's a hint:",
  noMoreHints: "You've used all my hints for this one. Look back at the lesson, try once more, or skip to the next problem. You can also ask your teacher.",
  refusal: "I can't give you the answer, but I can help you find it. Here's a hint:",
  needsAdult: "Thank you for telling me. I'm a learning helper, so please talk to your teacher, a counselor or another adult you trust right away. I've let your teacher know you'd like to talk.",
  offTopic: "I can only help with this lesson. Try asking about the problem, or ask your teacher.",
  allDone: "You've finished every problem in this skill for now. Great effort!"
});
export const pick = (list, n) => list[Math.abs(n) % list.length];

const words = s => String(s || "").toLowerCase().match(/[a-z0-9]+/g) || [];
const STOP = new Set("a an the is are am i me my you it to of and or in on for how do does what why can this that with be".split(" "));
/**
 * Local retrieval over APPROVED material only: pick the sentence of the lesson
 * explanation or the hints already unlocked that best overlaps the question.
 */
export function bestPassage(question, passages) {
  const q = new Set(words(question).filter(w => !STOP.has(w)));
  let best = null, bestScore = 0;
  for (const p of passages) {
    for (const sentence of String(p).split(/(?<=[.!?])\s+/)) {
      const score = words(sentence).filter(w => q.has(w)).length;
      if (score > bestScore) { best = sentence.trim(); bestScore = score; }
    }
  }
  return bestScore > 0 ? best : null;
}

/** Does generated text reveal the answer? Used to guard external providers. */
export function leaksAnswer(text, answer) {
  const a = normalizeAnswer(answer);
  if (!a) return false;
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const t = String(text || "").toLowerCase().replace(/\s+/g, "");
  return new RegExp(`(=|is|equals|answer:?|answeris)${esc}(?![0-9])`).test(t);
}

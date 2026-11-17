// EduOS 37.6.0 well-being check-ins. PURE: no I/O.
//
// What this module does NOT do (deck p21 promises): no scoring, no prediction,
// no risk ranking of minors. A check-in goes to a human counselor. The only
// automatic behavior is an explicit, documented phrase rule: crisis language
// shows the 988 Suicide & Crisis Lifeline and alerts a counselor immediately.
export const MOODS = ["great", "good", "okay", "low", "struggling"];
export const NEEDS = ["talk_to_someone", "friends", "schoolwork", "home", "sleep", "food", "safety", "other"];
export const NOTE_MAX = 500;

// Phrases that must reach a human right away. Matched on normalized text
// (lower case, letters/digits only, collapsed spaces, common contractions and
// spelling variants folded). Deliberately broad: a false alarm costs a
// counselor a few minutes; a miss can cost far more.
export const CRISIS_PHRASES = Object.freeze([
  "hurt myself", "hurting myself", "harm myself", "harming myself", "self harm", "selfharm", "cut myself", "cutting myself",
  "kill myself", "killing myself", "end my life", "ending my life", "take my life", "take my own life", "suicide", "suicidal",
  "want to die", "wanna die", "wish i was dead", "wish i were dead", "better off dead", "dont want to live", "dont want to be alive",
  "no reason to live", "not worth living", "dont want to be here anymore", "want to disappear forever", "kms", "unalive myself", "overdose", "hang myself",
  "not safe at home", "someone is hurting me", "somebody is hurting me", "being abused", "abusing me", "touching me", "hits me", "beats me"
]);
export function normalize(text) {
  return String(text || "").toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/n't\b/g, "nt").replace(/'/g, "")
    .replace(/\bi'?m\b/g, "im").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
/** -> {crisis:boolean, matched:string[]} (matched is for tests/audit; never shown to staff as a "score"). */
export function detectCrisis(...texts) {
  const hay = ` ${texts.map(normalize).join(" ")} `;
  const matched = CRISIS_PHRASES.filter(p => hay.includes(` ${p} `));
  return { crisis: matched.length > 0, matched };
}
export const CRISIS_RESPONSE = Object.freeze({
  title: "You don't have to handle this alone",
  lines: [
    "Call or text 988 to reach the 988 Suicide & Crisis Lifeline, any time, day or night.",
    "If you are in immediate danger, call 911.",
    "A counselor at your school has been told and will find you as soon as they can.",
    "You can also talk to any adult you trust at school right now."
  ],
  tel: "tel:988", sms: "sms:988"
});

/** Validate a learner's check-in. Throws Error(code) on invalid input. */
export function validateCheckin(body = {}) {
  const mood = String(body.mood || "");
  if (!MOODS.includes(mood)) throw Object.assign(new Error("mood_invalid"), { status: 400 });
  const needs = Array.isArray(body.needs) ? [...new Set(body.needs.map(String))] : [];
  if (needs.length > NEEDS.length || needs.some(n => !NEEDS.includes(n))) throw Object.assign(new Error("needs_invalid"), { status: 400 });
  let note = body.note == null ? null : String(body.note).replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim();
  if (note === "") note = null;
  if (note && note.length > NOTE_MAX) throw Object.assign(new Error("note_too_long"), { status: 400 });
  const wantsTalk = body.wantsTalk === true || needs.includes("talk_to_someone");
  return { mood, needs, note, wantsTalk };
}

/**
 * Counselor queue order: two plain buckets, then oldest first. NOT a ranking
 * of students: the bucket is decided by an explicit rule anyone can read.
 *   "now"   = crisis phrase matched, or the learner asked to talk, or checked "safety"
 *   "today" = everything else that is still open
 */
export function queueBucket(c) {
  if (c.status === "closed") return "closed";
  return (c.crisis || c.wants_talk || c.wantsTalk || (c.needs || []).includes("safety")) ? "now" : "today";
}
export function orderQueue(items) {
  const rank = { now: 0, today: 1, closed: 2 };
  return [...items].map(c => ({ ...c, bucket: queueBucket(c) }))
    .sort((a, b) => rank[a.bucket] - rank[b.bucket] || new Date(a.created_at || a.createdAt) - new Date(b.created_at || b.createdAt));
}
export const DEFAULT_NOTICE = "Our schools offer a short, optional well-being check-in in the EduOS student app. Your child can take part only if you opt them in. They can tell a school counselor how they are feeling and whether they would like to talk. Check-ins are read only by school counselors. They are never scored, ranked or used to predict anything about your child. If your child writes words that suggest they may hurt themselves or are not safe, the app shows the 988 Suicide & Crisis Lifeline and a counselor is alerted right away. Check-ins are deleted after one year. You can change your choice at any time.";

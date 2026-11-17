// EduOS 37.6.0 Leo: lesson drafts for teachers. PURE (no I/O): the gateway's
// local provider uses leoLocalPlan(); leoBrief() is the text an external model
// would see (curriculum only, then redacted by the gateway as usual).
// Inputs are curriculum rows only: district standards, approved lessons in the
// course and approved primary sources. No student data is an input. Leo does
// not grade, place or predict anything about students.

export const MINUTES = [30, 45, 60];
export const LEO_HEADER = "LEO DRAFT: needs review and school leader approval before use.";
const PLAN = {
  30: [["Warm-up", 5], ["Mini-lesson", 10], ["Guided practice", 8], ["Exit ticket", 7]],
  45: [["Warm-up", 5], ["Mini-lesson", 12], ["Guided practice", 10], ["Independent practice", 10], ["Exit ticket", 8]],
  60: [["Warm-up", 6], ["Mini-lesson", 14], ["Guided practice", 12], ["Independent practice", 12], ["Discussion", 8], ["Exit ticket", 8]]
};
export const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
const firstSentence = s => clip(String(s || "").split(/(?<=[.!?])\s/)[0], 160);
const lower = s => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * Normalize the inputs: { course:{title,subject,grade}, focus, minutes,
 *   standards:[{id,code,description}], lessons:[{id,title,objective}],
 *   sources:[{id,title,creator,createdDate,archive,archiveUrl,description}] }
 * Sorted and capped so the same inputs always give the same draft.
 */
export function normalizeLeoInputs(inputs = {}) {
  const minutes = MINUTES.includes(Number(inputs.minutes)) ? Number(inputs.minutes) : 45;
  const standards = [...(inputs.standards || [])].sort((a, b) => a.code.localeCompare(b.code)).slice(0, 4);
  if (!standards.length) throw Object.assign(new Error("leo_standard_required"), { status: 400 });
  const lessons = [...(inputs.lessons || [])].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 3);
  const sources = [...(inputs.sources || [])].sort((a, b) => a.title.localeCompare(b.title)).slice(0, 2);
  const course = { title: clip(inputs.course?.title, 120), subject: clip(inputs.course?.subject, 40) || "Lesson", grade: clip(inputs.course?.grade, 4) || "?" };
  const focus = clip(inputs.focus || standards[0].description, 100);
  return { minutes, standards, lessons, sources, course, focus };
}

/** Title and objective of the saved draft (deterministic, whatever the provider wrote). */
export function leoTitleObjective(inputs) {
  const n = normalizeLeoInputs(inputs);
  return {
    title: clip(`${n.focus} (${n.course.subject}, grade ${n.course.grade})`, 120),
    objective: clip(`Students will explain and apply ${lower(n.focus)} (${n.standards.map(s => s.code).join(", ")}).`, 300),
  };
}

/** The curriculum brief an external model is given (the gateway redacts it). */
export function leoBrief(inputs) {
  const n = normalizeLeoInputs(inputs);
  const out = [`Course: ${n.course.title} (${n.course.subject}, grade ${n.course.grade}). Lesson length: ${n.minutes} minutes. Focus: ${n.focus}.`, "", "Standards:"];
  for (const s of n.standards) out.push(`- ${s.code}: ${clip(s.description, 300)}`);
  if (n.lessons.length) { out.push("", "Approved lessons already in this course:"); for (const l of n.lessons) out.push(`- ${clip(l.title, 120)}: ${clip(l.objective, 200)}`); }
  if (n.sources.length) {
    out.push("", "Approved primary sources (public domain):");
    for (const s of n.sources) out.push(`- ${clip(s.title, 200)}${s.creator ? ` (${clip(s.creator, 80)})` : ""}${s.createdDate ? `, ${clip(s.createdDate, 40)}` : ""}: ${clip(s.description, 300)}`);
  }
  out.push("", `Write a ${n.minutes}-minute lesson plan for these standards with: lesson flow with minutes, differentiation (support and extension), and a short exit ticket. Use the sources and lessons listed only. Do not refer to any individual student.`);
  return out.join("\n");
}

/** Local (no network) lesson plan. */
export function leoLocalPlan(inputs) {
  const { minutes, standards, lessons, sources, course, focus } = normalizeLeoInputs(inputs);
  const out = [`Course: ${course.title} · ${minutes} minutes`, "", "Standards"];
  for (const s of standards) out.push(`- ${s.code}: ${clip(s.description, 200)}`);
  out.push("", "Lesson flow");
  for (const [name, m] of PLAN[minutes]) {
    let detail;
    switch (name) {
      case "Warm-up": detail = lessons[0] ? `Quick review of "${lessons[0].title}": ${firstSentence(lessons[0].objective)}` : `Ask students what they already know about ${lower(focus)}.`; break;
      case "Mini-lesson": detail = `Model ${lower(focus)} step by step. Connect to ${standards[0].code}: ${firstSentence(standards[0].description)}`; break;
      case "Guided practice": detail = sources[0] ? `Look closely at the primary source "${sources[0].title}"${sources[0].creator ? ` (${sources[0].creator})` : ""}. Ask: What do you notice? What do you wonder?` : "Work two or three examples together; students explain each step to a partner."; break;
      case "Independent practice": detail = `Students practice ${lower(focus)}${standards[1] ? ` and ${standards[1].code}` : ""}; circulate and give feedback.`; break;
      case "Discussion": detail = lessons[1] ? `Link today's work back to "${lessons[1].title}".` : "Share strategies; collect one question per table."; break;
      default: detail = `One question that checks ${standards[0].code}; collect before students leave.`;
    }
    out.push(`- ${name} (${m} min): ${detail}`);
  }
  out.push("", "Differentiation", "- Support: worked example and sentence starters; read directions aloud on request.",
    "- Extension: students write their own problem or question and solve a partner's.");
  if (sources.length) { out.push("", "Approved primary sources"); for (const s of sources) out.push(`- ${s.title}${s.createdDate ? `, ${s.createdDate}` : ""}. ${s.archive}: ${s.archiveUrl}`); }
  if (lessons.length) { out.push("", "Built from approved lessons"); for (const l of lessons) out.push(`- ${l.title}`); }
  out.push("", "Teacher notes: edit freely. Leo does not grade, place or predict anything about students.");
  return out.join("\n");
}

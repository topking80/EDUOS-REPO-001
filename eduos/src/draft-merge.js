// TEACH-03: merging two people's edits to a co-written draft. PURE: no I/O.
//
// A save carries the version the editor started from (base). If someone else
// saved in the meantime (theirs), the editor's change (mine) is merged field by
// field: a field only one of them changed takes that change; a field both
// changed to the same value is fine; a field both changed differently is a
// conflict, and nothing is saved. In a unit, lessons merge one by one when
// neither side added or removed lessons; otherwise only one side may have
// touched the lesson list.

const LESSON_FIELDS = ["title", "objective", "content", "standards", "sources"];
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function mergeFields(fields, base, mine, theirs, path, conflicts) {
  const out = {};
  for (const f of fields) {
    const b = base?.[f], m = mine?.[f], t = theirs?.[f];
    if (same(m, t)) out[f] = m;
    else if (same(m, b)) out[f] = t;
    else if (same(t, b)) out[f] = m;
    else { conflicts.push(`${path}${f}`); out[f] = t; }
  }
  return out;
}

/** Merge a lesson or unit body. Returns { body, conflicts: ["lessons[1].content", ...] }. */
export function mergeDraft(kind, base, mine, theirs) {
  const conflicts = [];
  if (kind === "lesson") return { body: mergeFields(LESSON_FIELDS, base, mine, theirs, "", conflicts), conflicts };
  const body = mergeFields(["title", "summary"], base, mine, theirs, "", conflicts);
  const [b, m, t] = [base?.lessons || [], mine?.lessons || [], theirs?.lessons || []];
  if (b.length === m.length && b.length === t.length) {
    body.lessons = m.map((l, i) => mergeFields(LESSON_FIELDS, b[i], l, t[i], `lessons[${i}].`, conflicts));
  } else if (same(m, b)) body.lessons = t;
  else if (same(t, b)) body.lessons = m;
  else { conflicts.push("lessons"); body.lessons = t; }
  return { body, conflicts };
}

const str = (v, max) => typeof v === "string" && v.length <= max ? v : null;

/** A lesson as a draft holds it: text may be empty while it's being written. */
function cleanLesson(l) {
  if (!l || typeof l !== "object") return null;
  const title = str(l.title ?? "", 120), objective = str(l.objective ?? "", 300), content = str(l.content ?? "", 8000);
  if (title === null || objective === null || content === null) return null;
  const standards = Array.isArray(l.standards) ? l.standards : [];
  const sources = Array.isArray(l.sources) ? l.sources : [];
  if (standards.length > 10 || sources.length > 6) return null;
  const uuid = v => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  if (!standards.every(s => uuid(s?.id) && str(s.code ?? "", 40) !== null && str(s.description ?? "", 1000) !== null)) return null;
  if (!sources.every(s => uuid(s?.sourceId) && str(s.title ?? "", 200) !== null && Array.isArray(s.prompts) && s.prompts.length >= 1 && s.prompts.length <= 6 && s.prompts.every(p => str(p, 300)))) return null;
  return { title, objective, content,
    standards: standards.map(s => ({ id: s.id, code: s.code || "", description: s.description || "" })),
    sources: sources.map(s => ({ sourceId: s.sourceId, title: s.title || "", prompts: s.prompts })) };
}

/** Validate and normalise a draft body; null when it isn't a valid lesson or unit. */
export function cleanDraftBody(kind, body) {
  if (!body || typeof body !== "object") return null;
  if (kind === "lesson") return cleanLesson(body);
  const title = str(body.title ?? "", 120), summary = body.summary == null ? null : str(body.summary, 1000);
  if (title === null || (body.summary != null && summary === null) || !Array.isArray(body.lessons) || body.lessons.length < 1 || body.lessons.length > 30) return null;
  const lessons = body.lessons.map(cleanLesson);
  return lessons.every(Boolean) ? { title, summary, lessons } : null;
}

/** What's still missing before the draft can become course lessons. */
export function missingForCourse(kind, body) {
  const gaps = [];
  const check = (l, at) => { for (const f of ["title", "objective", "content"]) if (!String(l[f] || "").trim()) gaps.push(`${at}${f}`); };
  if (kind === "lesson") check(body, "");
  else { if (!String(body.title || "").trim()) gaps.push("title"); body.lessons.forEach((l, i) => check(l, `lessons[${i}].`)); }
  return gaps;
}

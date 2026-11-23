// COACH-02: what a practice plan or playbook holds. PURE: no I/O.
//
//   { summary, items: [ { kind: "drill"|"play"|"note", title, minutes, description, equipment } ] }
//
// Plans name drills and plays, never players. While a plan is being written
// (a co-written draft) its text may be empty; to keep or share it, every item
// needs a title.

export const PLAN_KINDS = ["practice", "playbook"];
export const ITEM_KINDS = ["drill", "play", "note"];
const str = (v, max) => typeof v === "string" && v.length <= max ? v : null;

/** Validate and normalise a plan body; null when it isn't valid. */
export function cleanPlanBody(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.items) || body.items.length > 40) return null;
  const summary = body.summary == null || body.summary === "" ? null : str(body.summary, 1000);
  if (body.summary && summary === null) return null;
  const items = [];
  for (const it of body.items) {
    if (!it || typeof it !== "object" || !ITEM_KINDS.includes(it.kind)) return null;
    const title = str(it.title ?? "", 120), description = str(it.description ?? "", 4000), equipment = str(it.equipment ?? "", 300);
    const minutes = it.minutes == null || it.minutes === "" ? null : Number(it.minutes);
    if (title === null || description === null || equipment === null || (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 240))) return null;
    items.push({ kind: it.kind, title, minutes, description, equipment });
  }
  return { summary, items };
}

/** What's missing before a plan can be kept or shared. */
export function missingForPlan(title, body) {
  const gaps = [];
  if (!String(title || "").trim()) gaps.push("title");
  if (!body.items.length) gaps.push("items");
  body.items.forEach((it, i) => { if (!it.title.trim()) gaps.push(`items[${i}].title`); });
  return gaps;
}

export const planText = (title, body) => [title, body.summary, ...body.items.flatMap(i => [i.title, i.description, i.equipment])].filter(Boolean).join("\n");
export const planMinutes = body => body.items.reduce((n, i) => n + (i.minutes || 0), 0);

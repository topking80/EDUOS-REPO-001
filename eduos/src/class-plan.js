// TEACH-04: the blocks of a daily class plan. PURE: no I/O.
//
// A block is one step of the lesson as it's taught:
//   lesson      { lessonId }           a lesson from this course (its text is presented)
//   assignment  { assignmentId }       an assignment or quiz from this course
//   text        { title, body }        instructions or notes for the class
//   warmup      { prompt }             a question to start with
//   timer       { label }              a countdown (uses minutes)
//   link        { label, url }         an https link (opened by the teacher)
// Every block may have planned minutes (0-240) and a private note for the
// teacher, which present mode never shows.

export const BLOCK_KINDS = ["lesson", "assignment", "text", "warmup", "timer", "link"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v, min, max) => typeof v === "string" && v.trim().length >= min && v.trim().length <= max ? v.trim() : null;

/** Validate and normalise the blocks; returns { blocks } or { error, index }. */
export function cleanBlocks(input) {
  if (!Array.isArray(input) || input.length > 30) return { error: "invalid_blocks" };
  const out = [];
  for (const [index, b] of input.entries()) {
    if (!b || typeof b !== "object" || !BLOCK_KINDS.includes(b.kind)) return { error: "invalid_block", index };
    const minutes = b.minutes == null || b.minutes === "" ? null : Number(b.minutes);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 0 || minutes > 240)) return { error: "invalid_minutes", index };
    const note = b.note == null || b.note === "" ? null : str(b.note, 1, 1000);
    if (b.note && note === null) return { error: "invalid_note", index };
    const block = { kind: b.kind, minutes, note };
    if (b.kind === "lesson") { if (!UUID.test(b.lessonId || "")) return { error: "invalid_block", index }; block.lessonId = b.lessonId; }
    else if (b.kind === "assignment") { if (!UUID.test(b.assignmentId || "")) return { error: "invalid_block", index }; block.assignmentId = b.assignmentId; }
    else if (b.kind === "text") { const title = str(b.title ?? "", 0, 120), body = str(b.body, 1, 4000); if (title === null || body === null) return { error: "invalid_block", index }; Object.assign(block, { title, body }); }
    else if (b.kind === "warmup") { const prompt = str(b.prompt, 1, 500); if (!prompt) return { error: "invalid_block", index }; block.prompt = prompt; }
    else if (b.kind === "timer") { const label = str(b.label ?? "", 0, 80); if (label === null || !minutes) return { error: "timer_needs_minutes", index }; block.label = label; }
    else if (b.kind === "link") {
      const label = str(b.label, 1, 120), url = str(b.url, 1, 500);
      let ok = false; try { const u = new URL(url); ok = u.protocol === "https:" && !u.username && !u.password; } catch { ok = false; }
      if (!label || !ok) return { error: "invalid_link", index };
      Object.assign(block, { label, url: new URL(url).href });
    }
    out.push(block);
  }
  return { blocks: out };
}

export const totalMinutes = blocks => blocks.reduce((n, b) => n + (b.minutes || 0), 0);

// Removing student names and student numbers from text before it may leave
// the server (external AI providers for Christie and the staff assistant).
// src/student-identifiers.js finds whom the text names; this removes them.
//
// Built for any script, not just English:
// - Unicode-aware word edges: a name part is removed when it isn't inside a
//   longer word, where "word" means letters, marks and digits of any script
//   (JavaScript's \b only knows A-Z, 0-9 and _).
// - Scripts written without spaces between words (Chinese, Japanese, Thai)
//   and Korean (particles attach to names) match anywhere, with no word edges.
// - Text and names are compared in NFC, case-insensitively, with curly and
//   straight apostrophes treated alike.
// - A stored name is split on spaces and punctuation ("Doe, Jane" is Doe and
//   Jane). The whole name is removed as a phrase first, then each part of two
//   or more characters, including each side of a hyphen or apostrophe.
//
// Policy for one-character parts (initials, "A B", a one-character family
// name): they are removed only as part of the whole name ("A B", "A. B.",
// "Alice A", "李 明" or "李明"), never on their own. Removing every lone "A" or
// "明" would wreck ordinary text, and a lone initial doesn't identify anyone.
//
// A student number is removed as a phrase: its letter/digit runs in order,
// with up to three separator characters (or none) between them, so
// "SIS 2026 55417" also matches "SIS-2026-55417" and "SIS202655417".
const WORDCH = "\\p{L}\\p{M}\\p{N}";
const SEP = `[^${WORDCH}]`;
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const len = (s) => [...s].length;
export const normalizeName = (s) => String(s ?? "").normalize("NFC").replace(/[‘’ʼ]/g, "'");
export const hasNoSpaceScript = (s) => NO_SPACE_SCRIPT.test(String(s ?? ""));

const edged = (core, raw) => (NO_SPACE_SCRIPT.test(raw) ? core : `(?<![${WORDCH}])${core}(?![${WORDCH}])`);

/** Pattern sources that remove one name. `occurs(part)` filters parts not in the text. */
export function namePatterns(name, occurs = () => true) {
  const full = normalizeName(name).trim();
  const words = full.split(new RegExp(`[^${WORDCH}'\\-]+`, "u")).filter(Boolean);
  if (!words.length) return [];
  const out = [];
  // The whole name: its parts in order, separated by spaces or punctuation
  // (none needed in scripts written without spaces).
  if (words.length > 1 && words.every(occurs))
    out.push(edged(words.map(esc).join(`${SEP}${NO_SPACE_SCRIPT.test(full) ? "{0,3}" : "{1,3}"}`), full));
  const parts = new Set();
  for (const w of words) for (const p of [w, ...w.split(/['\-]/)]) if (p) parts.add(p);
  for (const p of parts) if (len(p) >= 2 && occurs(p)) out.push(edged(esc(p), p));
  // A name that is one single character is removed as a whole word.
  if (words.length === 1 && len(words[0]) === 1 && occurs(words[0])) out.push(edged(esc(words[0]), words[0]));
  return out;
}

/** Pattern source that removes one student number, however it is punctuated. */
export function numberPattern(number, occurs = () => true) {
  const runs = normalizeName(number).split(new RegExp(`${SEP}+`, "u")).filter(Boolean);
  if (!runs.length || !runs.every(occurs)) return null;
  return `(?<![${WORDCH}])${runs.map(esc).join(`${SEP}{0,3}`)}(?![${WORDCH}])`;
}

/**
 * Replace every occurrence of the names and student numbers. With a `tally`
 * (SEC-06), each removal is counted there by kind (student_name,
 * student_number); counts only, never what was removed.
 */
export function removeIdentifiers(text, { names = [], numbers = [] } = {}, { nameLabel = "[name]", numberLabel = "[removed]", tally = null } = {}) {
  let out = normalizeName(text);
  // Only parts that occur in the text make patterns: a common surname can
  // match thousands of students, but the text names a few.
  const lower = out.toLowerCase();
  const occurs = (p) => lower.includes(p.toLowerCase());
  const uniq = (list) => [...new Set(list.map(normalizeName).filter(n => n.trim()))];
  const apply = (sources, label, kind) => {
    const replacement = tally ? () => { tally[kind] = (tally[kind] || 0) + 1; return label; } : label;
    for (const src of [...new Set(sources)].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(src, "giu"), replacement);
  };
  // Numbers first: a number's runs could otherwise be eaten as name parts.
  apply(uniq(numbers).map(n => numberPattern(n, occurs)).filter(Boolean), numberLabel, "student_number");
  apply(uniq(names).flatMap(n => namePatterns(n, occurs)), nameLabel, "student_name");
  return out;
}

/** Names only (kept for callers that have no student numbers). */
export const removeNames = (text, names, label = "[name]") => removeIdentifiers(text, { names }, { nameLabel: label });

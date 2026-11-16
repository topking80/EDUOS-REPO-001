// Removing student names from text before it may leave the server (external
// AI providers for Christie and the staff assistant). Shared by both.
//
// Built for any script, not just English:
// - Unicode-aware word edges: a name part is removed when it isn't inside a
//   longer word, where "word" means letters, marks and digits of any script
//   (JavaScript's \b only knows A-Z, 0-9 and _, so it missed Мария, محمد or José).
// - Scripts written without spaces between words (Chinese, Japanese, Thai)
//   and Korean (particles attach to names: 민준이) match anywhere, with no
//   word edges.
// - Text and names are compared in NFC, case-insensitively, with curly and
//   straight apostrophes treated alike.
// - The whole name is removed as a phrase first, which also catches parts
//   too short to remove on their own (initials, one-letter names: "A B",
//   "Alice A", "A. B."), then each part of two or more characters, including
//   each side of a hyphenated name.
const WORDCH = "\\p{L}\\p{M}\\p{N}";
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const normalizeName = (s) => String(s ?? "").normalize("NFC").replace(/[‘’ʼ]/g, "'");

function pattern(core, raw) {
  return NO_SPACE_SCRIPT.test(raw) ? core : `(?<![${WORDCH}])${core}(?![${WORDCH}])`;
}

/** Regular expressions that remove one name, longest first. When `inText`
 *  (lowercased, normalized) is given, only parts that occur in it are kept. */
export function namePatterns(name, inText = null) {
  const full = normalizeName(name).trim();
  if (!full) return [];
  const occurs = (p) => inText === null || inText.includes(p.toLowerCase());
  const words = full.split(/\s+/).filter(Boolean);
  const out = [];
  // The whole name, with any spacing and optional dots after parts ("A. B.").
  if (words.length > 1 && words.every(occurs)) out.push(pattern(words.map(w => `${esc(w)}\\.?`).join("[\\s\\u00A0]+"), full));
  // Each part of 2+ characters, and each side of a hyphenated part.
  const parts = new Set();
  for (const w of words) {
    parts.add(w);
    for (const p of w.split("-")) parts.add(p);
  }
  for (const p of [...parts].filter(p => [...p].length >= 2 && occurs(p)).sort((a, b) => b.length - a.length)) out.push(pattern(esc(p), p));
  // A name that is a single one-character part (rare) is removed as a whole word.
  if (words.length === 1 && [...words[0]].length === 1 && occurs(words[0])) out.push(pattern(esc(words[0]), words[0]));
  return out.map(src => new RegExp(src, "giu"));
}

/** Replace every occurrence of any of the names (and numbers) with the label. */
export function removeNames(text, names, label = "[name]") {
  let out = normalizeName(text);
  // Only parts that occur in the text make patterns: a common surname can
  // match thousands of students, but the text names a few. Patterns are
  // de-duplicated and applied longest first.
  const lower = out.toLowerCase();
  const seen = new Set();
  const regexes = [...new Set(names.map(normalizeName).filter(n => n.trim()))]
    .flatMap(n => namePatterns(n, lower)).filter(re => !seen.has(re.source) && seen.add(re.source))
    .sort((a, b) => b.source.length - a.source.length);
  for (const re of regexes) out = out.replace(re, label);
  return out;
}

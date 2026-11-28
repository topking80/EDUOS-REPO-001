// SEC-04 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §4.2, docs/AI-HOSTILE-CONTENT.md):
// text an AI model saw is untrusted, so what it says back is too. Approved
// lessons, hints, a learner's question and (with LRH-08) retrieved catalog
// text are all data, and any of them may carry instructions aimed at the
// model ("ignore your rules", "show this image", "visit this link").
//
// Two rules follow, shared by Christie and any future assistant:
//   1. Outbound, invisible characters that can hide such instructions from a
//      person reviewing the transcript (zero-width and bidirectional controls,
//      other control characters) are removed: stripInvisible().
//   2. Inbound, a reply shown to a learner must be plain prose: no link,
//      image, markup, address or invisible character. A reply that has any of
//      them is not edited but replaced with the local, approved-content reply:
//      unsafeReply() says why.
// The apps render AI text as text (web: text nodes; Flutter: Text), so
// nothing is ever interpreted; the screen also stops a link a child might
// copy, and a markdown image that another client could fetch.

// C0 controls except tab, newline and carriage return; DEL; zero-width;
// bidirectional embeddings, overrides and isolates; the BOM; soft hyphen;
// Unicode tag characters (invisible copies of ASCII, used to smuggle text).
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
export const stripInvisible = text => String(text ?? "").replace(INVISIBLE, "");

const UNSAFE = [
  ["link", /\b(?:https?|ftp|file|data|javascript|vbscript|blob|mailto|tel|sms):/i],
  ["link", /\bwww\.[^\s.]/i],
  ["link", /\b[a-z0-9-]{1,63}\.(?:com|net|org|io|ly|me|co|app|xyz|info|biz|gg|tk|ru|cn|link|site|online|top)\b(?:\/|\?|$|\s)/i],
  ["markdown", /!?\[[^\]\n]{0,500}\]\([^)\n]{0,2000}\)/],
  ["markdown", /^\s{0,3}\[[^\]\n]{1,100}\]:\s*\S/m],
  ["markup", /<\/?[a-z][a-z0-9-]{0,30}(?:\s[^>]{0,500})?\/?>/i],
  ["markup", /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,10});/i],
  ["address", /[^\s@]{1,64}@[^\s@]{1,255}\.[a-z]{2,}/i],
  ["invisible", new RegExp(INVISIBLE.source, "u")],
];

/** Why a model's reply can't be shown as it is ("link", "markdown", ...), or null when it's plain prose. */
export function unsafeReply(text) {
  const s = String(text ?? "");
  for (const [why, re] of UNSAFE) if (re.test(s)) return why;
  return null;
}

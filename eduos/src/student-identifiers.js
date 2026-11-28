// Which students in the district does this text name? Used before any text
// may leave the server for an external AI provider (staff assistant, Christie).
//
// The database does the matching with the same tokenizer it used to index the
// students (db/043: eduos_redact_tokens), so lookup rules can't drift from the
// stored data: a student is returned when
//   - a part of their name of two or more characters is a word of the text
//     ("Okonkwo-Reyes" alone finds Marisol Okonkwo-Reyes; "Doe" finds
//     "Doe, Jane"), or every part of their name is (initials: "Q Z");
//   - every part of their student number is in the text ("SIS 2026 55417",
//     "A/2026/001"), or the number without separators is a word of it;
//   - for names in scripts written without spaces (Chinese, Japanese, Korean,
//     Thai...), a part of two or more characters, or every part, appears
//     anywhere in the text.
// District-wide for every role, no row limit; only the matches come back
// (the lookups run as definers, db/179, so school-scoped readers still match
// students at other schools).
// src/redact-names.js then removes them (and decides how precisely).
import { normalizeName, hasNoSpaceScript } from "./redact-names.js";

const titleCase = (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{M}\p{N}])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

export async function findStudentIdentifiers(c, districtId, text) {
  const base = normalizeName(text);
  if (!base.trim()) return { names: [], numbers: [] };
  // Case variants, so matching is case-insensitive even where the database's
  // own lower() only knows ASCII.
  const variants = [base, base.toLowerCase(), base.toUpperCase(), titleCase(base)].join("\n");
  const all = (await c.query("SELECT eduos_redact_tokens($1) AS t", [variants])).rows[0].t;
  if (!all.length) return { names: [], numbers: [] };
  // Equality joins on the token table (db/043), one indexable branch each.
  // They run in definers (db/179): matching is district-wide whoever asks,
  // and only the matches come back.
  const found = (await c.query("SELECT display_name, local_student_number FROM eduos_student_identifiers_match($1::text[])", [all])).rows;
  if (hasNoSpaceScript(base))
    found.push(...(await c.query("SELECT display_name, local_student_number FROM eduos_student_identifiers_nospace($1)", [variants.toLowerCase()])).rows);
  return { names: [...new Set(found.map(r => r.display_name))], numbers: [...new Set(found.map(r => r.local_student_number))] };
}

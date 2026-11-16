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
// District-wide for every role, no row limit; only the matches come back.
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
  const found = (await c.query(`
    WITH words AS (SELECT DISTINCT w FROM unnest($2::text[]) w)
    SELECT s.display_name, s.local_student_number FROM students s WHERE s.district_id = $1 AND s.id IN (
        -- a name part of two or more characters is a word of the text
        SELECT t.student_id FROM student_redact_tokens t JOIN words ON words.w = t.token
         WHERE t.district_id = $1 AND t.kind = 'name' AND t.long
        UNION
        -- every part of the name, or of the student number, is a word of the text
        SELECT t.student_id FROM student_redact_tokens t JOIN words ON words.w = t.token
         WHERE t.district_id = $1 GROUP BY t.student_id, t.kind HAVING count(*) = min(t.n)
        UNION
        -- the student number without its separators is a word of the text
        SELECT s2.id FROM students s2 JOIN words ON words.w = s2.redact_number_compact WHERE s2.district_id = $1)`,
    [districtId, all])).rows;
  if (hasNoSpaceScript(base)) {
    found.push(...(await c.query(`SELECT s.display_name, s.local_student_number FROM students s
       WHERE s.district_id = $1 AND s.redact_name_nospace
         AND (EXISTS (SELECT 1 FROM unnest(eduos_redact_tokens(s.display_name)) w WHERE char_length(w) >= 2 AND strpos($2, w) > 0)
           OR NOT EXISTS (SELECT 1 FROM unnest(eduos_redact_tokens(s.display_name)) w WHERE strpos($2, w) = 0))`, [districtId, variants.toLowerCase()])).rows);
  }
  return { names: [...new Set(found.map(r => r.display_name))], numbers: [...new Set(found.map(r => r.local_student_number))] };
}

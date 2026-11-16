-- Finding which students a text names, before it may leave the server for an
-- external AI provider (staff assistant and Christie).
--
-- One tokenizer, eduos_redact_tokens(), splits both the stored names and
-- student numbers (into the indexed table below) and the text being checked
-- (at request time), so the two sides can't disagree: NFC, lowercase,
-- split on whitespace and punctuation (ASCII and the common Unicode ranges,
-- including hyphens, commas, slashes and all apostrophes). "Doe, Jane",
-- "Okonkwo-Reyes", "O'Brien", "SIS 2026 55417" and "A/2026/001" all become
-- plain tokens. Matching is then plain equality on indexed tokens, which
-- stays fast for large districts (array overlap on the roster did not:
-- 14 s at 100,000 students).
CREATE FUNCTION eduos_redact_tokens(p text) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_remove(regexp_split_to_array(lower(normalize(coalesce(p, ''), NFC)),
    '[\s[:punct:] -©«-´¶-¹»-¿×÷ʼ՚-՟։֊־׀׃׆׳״؀-؏؛-؟٪-٭۔।॥॰๏๚๛༄-༔၊-၏፡-፨។-៚᠀-᠊ -⯿　-〿︐-﹯＀-／：-＠［-｀｛-･]+'), '')
$$;

-- A student number with its separators removed ("SIS 2026 55417" -> "sis202655417").
CREATE FUNCTION eduos_redact_compact(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string(eduos_redact_tokens(p), '') $$;

-- Names in scripts written without spaces between words (Chinese, Japanese,
-- Korean, Thai, Lao, Khmer, Burmese) are matched inside the text instead.
CREATE FUNCTION eduos_redact_is_nospace(p text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(p, '') ~ '[぀-ヿ㐀-鿿가-힯฀-໿ក-៿က-႟]'
$$;

-- One row per distinct token of each student's name and number. `n` is how
-- many distinct tokens that name (or number) has, so "every part is in the
-- text" is a count. Kept current by a trigger on students, whichever code
-- path writes them (API, SIS import, connectors, node sync).
CREATE TABLE student_redact_tokens (
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('name','number')),
  token text NOT NULL,
  long boolean NOT NULL,
  n integer NOT NULL CHECK (n >= 1),
  PRIMARY KEY (district_id, token, kind, student_id)
);
CREATE INDEX student_redact_tokens_student ON student_redact_tokens(student_id);
ALTER TABLE student_redact_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_redact_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY student_redact_tokens_tenant_scope ON student_redact_tokens
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);

CREATE FUNCTION eduos_student_redact_rows(p_district uuid, p_student uuid, p_name text, p_number text)
RETURNS TABLE (district_id uuid, student_id uuid, kind text, token text, long boolean, n integer)
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_district, p_student, k.kind, t.token, char_length(t.token) >= 2, (count(*) OVER (PARTITION BY k.kind))::int
    FROM (VALUES ('name', p_name), ('number', p_number)) k(kind, src)
   CROSS JOIN LATERAL (SELECT DISTINCT x AS token FROM unnest(eduos_redact_tokens(k.src)) x) t
$$;

CREATE FUNCTION eduos_students_redact_tokens_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN DELETE FROM student_redact_tokens WHERE student_id = NEW.id; END IF;
  INSERT INTO student_redact_tokens SELECT * FROM eduos_student_redact_rows(NEW.district_id, NEW.id, NEW.display_name, NEW.local_student_number);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION eduos_students_redact_tokens_sync() FROM PUBLIC;
CREATE TRIGGER students_redact_tokens_sync AFTER INSERT OR UPDATE OF display_name, local_student_number, district_id ON students
  FOR EACH ROW EXECUTE FUNCTION eduos_students_redact_tokens_sync();

INSERT INTO student_redact_tokens
SELECT r.* FROM students s CROSS JOIN LATERAL eduos_student_redact_rows(s.district_id, s.id, s.display_name, s.local_student_number) r;

ALTER TABLE students
  ADD COLUMN redact_number_compact text GENERATED ALWAYS AS (eduos_redact_compact(local_student_number)) STORED,
  ADD COLUMN redact_name_nospace boolean GENERATED ALWAYS AS (eduos_redact_is_nospace(display_name)) STORED;
CREATE INDEX students_redact_number_compact ON students (district_id, redact_number_compact);
CREATE INDEX students_redact_nospace ON students (district_id) WHERE redact_name_nospace;

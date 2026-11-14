-- EduOS 32.6.0: learning core (courses, units, lessons, standards, rubrics,
-- quizzes with accommodations, gradebook, explainable mastery per standard),
-- PSLN primary sources (public-domain items from public archives), and the
-- first step of EDAL: an append-only, hash-chained ledger for key academic
-- records. EDAL is a tamper-EVIDENT log inside PostgreSQL, not a blockchain.

-- ---------------------------------------------------------------------------
-- Standards catalog (district-wide).
-- ---------------------------------------------------------------------------
-- Inside SECURITY DEFINER helpers current_user is always the owner, so the
-- owner bypass there must look at the SESSION (seed / migrate / CLI run as the
-- owner; the API never does). Policies keep eduos_is_table_owner(): it lets the
-- definer functions below (and the owner session) pass the restrictive checks.
CREATE FUNCTION eduos_owner_session() RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT session_user = (SELECT r.rolname FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='public.districts'::regclass)
$$;

CREATE TABLE learning_standards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  framework text NOT NULL CHECK(framework ~ '^[A-Za-z0-9 ._-]{1,40}$'),
  code text NOT NULL CHECK(code ~ '^[A-Za-z0-9._-]{1,60}$'),
  subject text NOT NULL CHECK(length(btrim(subject)) BETWEEN 1 AND 40),
  grade_level text NOT NULL CHECK(length(btrim(grade_level)) BETWEEN 1 AND 4),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 500),
  source_url text CHECK(source_url IS NULL OR source_url ~ '^https://[^ ]{4,255}$'),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id, code),
  UNIQUE(district_id, id)
);

-- ---------------------------------------------------------------------------
-- Courses, enrollment, units and lessons.
-- ---------------------------------------------------------------------------
CREATE TABLE courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  teacher_user_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
  subject text NOT NULL CHECK(length(btrim(subject)) BETWEEN 1 AND 40),
  grade_level text NOT NULL CHECK(length(btrim(grade_level)) BETWEEN 1 AND 4),
  term text NOT NULL DEFAULT 'Year' CHECK(length(btrim(term)) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','archived')),
  -- Category weights for the course grade, e.g. {"Classwork":40,"Quizzes":60}.
  grade_weights jsonb NOT NULL DEFAULT '{"Classwork":40,"Quizzes":60}'::jsonb CHECK(jsonb_typeof(grade_weights)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE TABLE course_enrollments (
  course_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  student_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','dropped')),
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(course_id, student_id),
  FOREIGN KEY(district_id, course_id) REFERENCES courses(district_id, id),
  FOREIGN KEY(district_id, student_id) REFERENCES students(district_id, id)
);
CREATE INDEX course_enrollments_student ON course_enrollments(district_id, student_id);
CREATE TABLE course_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  course_id uuid NOT NULL,
  seq integer NOT NULL CHECK(seq BETWEEN 1 AND 200),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
  summary text CHECK(summary IS NULL OR length(summary) <= 1000),
  UNIQUE(course_id, seq),
  UNIQUE(district_id, id),
  FOREIGN KEY(district_id, course_id) REFERENCES courses(district_id, id)
);
CREATE TABLE lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  course_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  seq integer NOT NULL CHECK(seq BETWEEN 1 AND 200),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 120),
  objective text NOT NULL CHECK(length(btrim(objective)) BETWEEN 1 AND 300),
  content text NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 8000),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
  -- A school leader approves a lesson's content before Christie may use it.
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(unit_id, seq),
  UNIQUE(district_id, id),
  FOREIGN KEY(district_id, course_id) REFERENCES courses(district_id, id),
  FOREIGN KEY(district_id, unit_id) REFERENCES course_units(district_id, id)
);
CREATE TABLE lesson_standards (
  lesson_id uuid NOT NULL,
  standard_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  PRIMARY KEY(lesson_id, standard_id),
  FOREIGN KEY(district_id, lesson_id) REFERENCES lessons(district_id, id),
  FOREIGN KEY(district_id, standard_id) REFERENCES learning_standards(district_id, id)
);

-- ---------------------------------------------------------------------------
-- PSLN: curated primary sources. Public domain only, from public archives,
-- with the archive's own URL and rights statement. Content is a transcription
-- or a description; EduOS does not hotlink or re-host the archive's images.
-- ---------------------------------------------------------------------------
CREATE TABLE primary_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),
  creator text CHECK(creator IS NULL OR length(creator) <= 200),
  created_date text CHECK(created_date IS NULL OR length(created_date) <= 60),
  media_kind text NOT NULL CHECK(media_kind IN ('document','photograph','telegram','letter','map','speech','other')),
  archive text NOT NULL CHECK(archive IN ('Library of Congress','National Archives')),
  archive_url text NOT NULL CHECK(archive_url ~ '^https://(www\.)?(loc\.gov|archives\.gov)/[^ ]{1,255}$'),
  rights text NOT NULL CHECK(length(btrim(rights)) BETWEEN 1 AND 300),
  excerpt text CHECK(excerpt IS NULL OR length(excerpt) <= 6000),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
  curated_by uuid NOT NULL REFERENCES users(id),
  curated_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  CHECK((status='approved') <= (approved_at IS NOT NULL)),
  UNIQUE(district_id, id)
);
CREATE TABLE lesson_sources (
  lesson_id uuid NOT NULL,
  source_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  seq integer NOT NULL DEFAULT 1 CHECK(seq BETWEEN 1 AND 50),
  prompts text[] NOT NULL CHECK(cardinality(prompts) BETWEEN 1 AND 6),
  PRIMARY KEY(lesson_id, source_id),
  FOREIGN KEY(district_id, lesson_id) REFERENCES lessons(district_id, id),
  FOREIGN KEY(district_id, source_id) REFERENCES primary_sources(district_id, id)
);

-- ---------------------------------------------------------------------------
-- Assignments become course work: points, category, rubric, quiz settings.
-- ---------------------------------------------------------------------------
ALTER TABLE assignments
  ADD COLUMN course_id uuid,
  ADD COLUMN lesson_id uuid,
  ADD COLUMN kind text NOT NULL DEFAULT 'work' CHECK(kind IN ('work','quiz')),
  ADD COLUMN points_possible numeric(6,2) NOT NULL DEFAULT 100 CHECK(points_possible > 0 AND points_possible <= 1000),
  ADD COLUMN category text NOT NULL DEFAULT 'Classwork' CHECK(length(btrim(category)) BETWEEN 1 AND 40),
  ADD COLUMN rubric jsonb CHECK(rubric IS NULL OR (jsonb_typeof(rubric)='array' AND jsonb_array_length(rubric) BETWEEN 1 AND 12)),
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 1 CHECK(max_attempts BETWEEN 1 AND 10),
  ADD COLUMN retake_policy text NOT NULL DEFAULT 'highest' CHECK(retake_policy IN ('highest','latest','average')),
  ADD COLUMN time_limit_minutes integer CHECK(time_limit_minutes IS NULL OR time_limit_minutes BETWEEN 1 AND 240),
  ADD CONSTRAINT assignments_course_fk FOREIGN KEY(district_id, course_id) REFERENCES courses(district_id, id),
  ADD CONSTRAINT assignments_lesson_fk FOREIGN KEY(district_id, lesson_id) REFERENCES lessons(district_id, id),
  ADD CONSTRAINT assignments_lesson_needs_course CHECK(lesson_id IS NULL OR course_id IS NOT NULL);
CREATE INDEX assignments_course ON assignments(district_id, course_id) WHERE course_id IS NOT NULL;
CREATE TABLE assignment_standards (
  assignment_id uuid NOT NULL,
  standard_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  PRIMARY KEY(assignment_id, standard_id),
  FOREIGN KEY(district_id, assignment_id) REFERENCES assignments(district_id, id),
  FOREIGN KEY(district_id, standard_id) REFERENCES learning_standards(district_id, id)
);
ALTER TABLE assignment_submissions
  ADD COLUMN rubric_scores jsonb CHECK(rubric_scores IS NULL OR jsonb_typeof(rubric_scores)='array'),
  ADD COLUMN points_earned numeric(6,2) CHECK(points_earned IS NULL OR points_earned >= 0),
  ADD COLUMN returned_at timestamptz;

-- ---------------------------------------------------------------------------
-- Quizzes. Answer keys live in their own table that only staff can read.
-- ---------------------------------------------------------------------------
CREATE TABLE quiz_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  assignment_id uuid NOT NULL,
  seq integer NOT NULL CHECK(seq BETWEEN 1 AND 100),
  kind text NOT NULL CHECK(kind IN ('mc','short','numeric','source')),
  prompt text NOT NULL CHECK(length(btrim(prompt)) BETWEEN 1 AND 1000),
  choices text[] CHECK(choices IS NULL OR cardinality(choices) BETWEEN 2 AND 6),
  points numeric(5,2) NOT NULL DEFAULT 1 CHECK(points > 0 AND points <= 100),
  standard_id uuid,
  source_id uuid,                -- PSLN item: a primary source to analyse
  CHECK((kind='mc') = (choices IS NOT NULL)),
  CHECK((kind='source') <= (source_id IS NOT NULL)),
  UNIQUE(assignment_id, seq),
  UNIQUE(district_id, id),
  FOREIGN KEY(district_id, assignment_id) REFERENCES assignments(district_id, id),
  FOREIGN KEY(district_id, standard_id) REFERENCES learning_standards(district_id, id),
  FOREIGN KEY(district_id, source_id) REFERENCES primary_sources(district_id, id)
);
CREATE TABLE quiz_item_keys (
  item_id uuid PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  -- mc: {"index":n}; numeric: {"value":"3/4","tolerance":0}; short: {"accepted":["..."]};
  -- source: {} (always teacher-reviewed).
  answer_key jsonb NOT NULL CHECK(jsonb_typeof(answer_key)='object'),
  FOREIGN KEY(district_id, item_id) REFERENCES quiz_items(district_id, id)
);
CREATE TABLE student_accommodations (
  student_id uuid PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  extra_time_pct integer NOT NULL DEFAULT 0 CHECK(extra_time_pct BETWEEN 0 AND 200),
  read_aloud boolean NOT NULL DEFAULT false,
  notes text CHECK(notes IS NULL OR length(notes) <= 300),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  attempt_no integer NOT NULL CHECK(attempt_no BETWEEN 1 AND 10),
  status text NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','needs_review','scored','returned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz,                      -- NULL: untimed
  extra_time_pct integer NOT NULL DEFAULT 0 CHECK(extra_time_pct BETWEEN 0 AND 200),
  read_aloud boolean NOT NULL DEFAULT false,
  submitted_at timestamptz,
  late boolean NOT NULL DEFAULT false,
  auto_points numeric(7,2),
  total_points numeric(7,2),
  possible_points numeric(7,2),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  returned_at timestamptz,
  CHECK((status='in_progress') = (submitted_at IS NULL)),
  UNIQUE(assignment_id, student_id, attempt_no),
  UNIQUE(district_id, id),
  FOREIGN KEY(district_id, assignment_id) REFERENCES assignments(district_id, id),
  FOREIGN KEY(district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE UNIQUE INDEX quiz_attempts_one_open ON quiz_attempts(assignment_id, student_id) WHERE status='in_progress';
CREATE TABLE quiz_responses (
  attempt_id uuid NOT NULL,
  item_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  response text NOT NULL DEFAULT '' CHECK(length(response) <= 2000),
  saved_at timestamptz NOT NULL DEFAULT now(),
  auto_correct boolean,                          -- NULL: needs a teacher
  auto_points numeric(5,2),
  teacher_points numeric(5,2) CHECK(teacher_points IS NULL OR teacher_points >= 0),
  teacher_comment text CHECK(teacher_comment IS NULL OR length(teacher_comment) <= 1000),
  PRIMARY KEY(attempt_id, item_id),
  FOREIGN KEY(district_id, attempt_id) REFERENCES quiz_attempts(district_id, id),
  FOREIGN KEY(district_id, item_id) REFERENCES quiz_items(district_id, id)
);

-- ---------------------------------------------------------------------------
-- Mastery per standard: an append-only evidence log plus the current value,
-- computed by src/mastery-model.js (documented, explainable, no prediction).
-- ---------------------------------------------------------------------------
CREATE TABLE mastery_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  standard_id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('quiz','rubric','christie')),
  source_ref uuid,
  label text NOT NULL CHECK(length(btrim(label)) BETWEEN 1 AND 160),
  score numeric(5,4) NOT NULL CHECK(score >= 0 AND score <= 1),
  weight numeric(3,2) NOT NULL CHECK(weight > 0 AND weight <= 1),
  observed_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid REFERENCES users(id),
  FOREIGN KEY(district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY(district_id, standard_id) REFERENCES learning_standards(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE INDEX mastery_evidence_student ON mastery_evidence(district_id, student_id, standard_id, observed_at DESC);
CREATE TRIGGER mastery_evidence_append_only BEFORE UPDATE OR DELETE ON mastery_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TABLE standard_mastery (
  student_id uuid NOT NULL,
  standard_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  mastery integer NOT NULL CHECK(mastery BETWEEN 0 AND 100),
  level text NOT NULL CHECK(level IN ('emerging','developing','mastered')),
  evidence_count integer NOT NULL CHECK(evidence_count >= 0),
  assessed_count integer NOT NULL CHECK(assessed_count >= 0),
  mastered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(student_id, standard_id),
  FOREIGN KEY(district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY(district_id, standard_id) REFERENCES learning_standards(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
-- Christie skills point at the lesson and standard they practise.
ALTER TABLE christie_skills
  ADD COLUMN standard_id uuid,
  ADD COLUMN lesson_id uuid,
  ADD CONSTRAINT christie_skills_standard_fk FOREIGN KEY(district_id, standard_id) REFERENCES learning_standards(district_id, id),
  ADD CONSTRAINT christie_skills_lesson_fk FOREIGN KEY(district_id, lesson_id) REFERENCES lessons(district_id, id);

-- ---------------------------------------------------------------------------
-- Final grades (append-only; a correction is a new row) and credentials.
-- ---------------------------------------------------------------------------
CREATE TABLE course_final_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  course_id uuid NOT NULL,
  student_id uuid NOT NULL,
  percent numeric(5,2) NOT NULL CHECK(percent >= 0 AND percent <= 100),
  letter text NOT NULL CHECK(letter ~ '^[A-F][+-]?$'),
  reason text CHECK(reason IS NULL OR length(reason) BETWEEN 10 AND 300),
  supersedes uuid REFERENCES course_final_grades(id),
  posted_by uuid NOT NULL REFERENCES users(id),
  posted_at timestamptz NOT NULL DEFAULT now(),
  edal_entry_id uuid,
  CHECK((supersedes IS NULL) OR (reason IS NOT NULL)),
  FOREIGN KEY(district_id, course_id) REFERENCES courses(district_id, id),
  FOREIGN KEY(district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE INDEX course_final_grades_lookup ON course_final_grades(course_id, student_id, posted_at DESC);
CREATE TRIGGER course_final_grades_append_only BEFORE UPDATE OR DELETE ON course_final_grades
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TABLE credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('course_completion','standard_mastery','award')),
  title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 160),
  description text CHECK(description IS NULL OR length(description) <= 500),
  course_id uuid,
  standard_id uuid,
  issued_by uuid NOT NULL REFERENCES users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  revoke_reason text CHECK(revoke_reason IS NULL OR length(revoke_reason) BETWEEN 10 AND 300),
  edal_entry_id uuid,
  CHECK((revoked_at IS NULL) = (revoke_reason IS NULL)),
  FOREIGN KEY(district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY(district_id, course_id) REFERENCES courses(district_id, id),
  FOREIGN KEY(district_id, standard_id) REFERENCES learning_standards(district_id, id),
  FOREIGN KEY(district_id, school_id) REFERENCES schools(district_id, id)
);

-- ---------------------------------------------------------------------------
-- EDAL ledger, step 1. One hash chain per district:
--   entry_hash = sha256("EDAL1|district|seq|kind|school|subject|payload_hash|prev_hash|recorded_at")
--   payload_hash = sha256(canonical JSON payload)
-- The payload sits in edal_payloads so a FERPA deletion can erase it while the
-- chain (hashes and an opaque id) still verifies. Entries can never be updated
-- or deleted, not even by the retention job. Checkpoints (the head hash at a
-- moment) are what a district copies outside EduOS today; anchor_kind/ref are
-- reserved for a future external anchor (e.g. an RFC 3161 timestamp).
-- ---------------------------------------------------------------------------
CREATE TABLE edal_heads (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  seq bigint NOT NULL DEFAULT 0 CHECK(seq >= 0),
  head_hash text NOT NULL DEFAULT repeat('0', 64) CHECK(head_hash ~ '^[0-9a-f]{64}$')
);
CREATE TABLE edal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  seq bigint NOT NULL CHECK(seq >= 1),
  kind text NOT NULL CHECK(kind IN ('final_grade','credential','credential_revoked','mastery_milestone')),
  school_id uuid,
  subject_student_id uuid,                     -- opaque id, deliberately no FK
  payload_hash text NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
  prev_hash text NOT NULL CHECK(prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text NOT NULL UNIQUE CHECK(entry_hash ~ '^[0-9a-f]{64}$'),
  recorded_at text NOT NULL CHECK(recorded_at ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'),
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id, seq),
  UNIQUE(district_id, id)
);
CREATE INDEX edal_entries_subject ON edal_entries(district_id, subject_student_id, seq);
CREATE TABLE edal_payloads (
  entry_id uuid PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  payload text NOT NULL CHECK(length(payload) BETWEEN 2 AND 8000),
  FOREIGN KEY(district_id, entry_id) REFERENCES edal_entries(district_id, id)
);
CREATE TABLE edal_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  seq bigint NOT NULL CHECK(seq >= 0),
  head_hash text NOT NULL CHECK(head_hash ~ '^[0-9a-f]{64}$'),
  note text CHECK(note IS NULL OR length(note) <= 300),
  anchor_kind text NOT NULL DEFAULT 'none' CHECK(anchor_kind IN ('none')),   -- future: 'rfc3161', ...
  anchor_ref text CHECK(anchor_ref IS NULL),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE course_final_grades ADD CONSTRAINT course_final_grades_edal_fk FOREIGN KEY(edal_entry_id) REFERENCES edal_entries(id);
ALTER TABLE credentials ADD CONSTRAINT credentials_edal_fk FOREIGN KEY(edal_entry_id) REFERENCES edal_entries(id);

CREATE FUNCTION reject_edal_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only (EDAL)', TG_TABLE_NAME; END; $$;
CREATE TRIGGER edal_entries_immutable BEFORE UPDATE OR DELETE ON edal_entries FOR EACH ROW EXECUTE FUNCTION reject_edal_mutation();
CREATE TRIGGER edal_entries_no_truncate BEFORE TRUNCATE ON edal_entries FOR EACH STATEMENT EXECUTE FUNCTION reject_edal_mutation();
CREATE TRIGGER edal_checkpoints_immutable BEFORE UPDATE OR DELETE ON edal_checkpoints FOR EACH ROW EXECUTE FUNCTION reject_edal_mutation();
-- Payloads: never updated; deleted only by the FERPA purge (eduos.retention_purge=on).
CREATE TRIGGER edal_payloads_append_only BEFORE UPDATE OR DELETE ON edal_payloads FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Lock and return this district's chain head (creates the genesis head).
CREATE FUNCTION eduos_edal_head() RETURNS TABLE(seq bigint, head_hash text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district();
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  INSERT INTO edal_heads(district_id) VALUES(d) ON CONFLICT DO NOTHING;
  RETURN QUERY SELECT h.seq, h.head_hash FROM edal_heads h WHERE h.district_id=d FOR UPDATE;
END; $$;
-- Every insert must extend the head exactly; the head then moves.
CREATE FUNCTION eduos_edal_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE h record;
BEGIN
  INSERT INTO edal_heads(district_id) VALUES(NEW.district_id) ON CONFLICT DO NOTHING;
  SELECT * INTO h FROM edal_heads WHERE district_id=NEW.district_id FOR UPDATE;
  IF NEW.seq <> h.seq + 1 OR NEW.prev_hash <> h.head_hash THEN
    RAISE EXCEPTION 'EDAL entry does not extend the chain head (expected seq %, prev %)', h.seq + 1, h.head_hash USING ERRCODE = '40001';
  END IF;
  UPDATE edal_heads SET seq=NEW.seq, head_hash=NEW.entry_hash WHERE district_id=NEW.district_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER edal_entries_link BEFORE INSERT ON edal_entries FOR EACH ROW EXECUTE FUNCTION eduos_edal_link();

CREATE FUNCTION eduos_edal_verifier() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT eduos_owner_session() OR eduos_ctx_role() IN ('superintendent','it_admin','principal')
$$;
-- The whole chain without payloads (only header fields and whether each stored
-- payload still matches its hash), for district / school leaders and IT.
CREATE FUNCTION eduos_edal_chain(p_after bigint, p_limit integer)
RETURNS TABLE(seq bigint, kind text, school_id uuid, subject_student_id uuid, payload_hash text, prev_hash text, entry_hash text,
              recorded_at text, payload_state text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.seq, e.kind, e.school_id, e.subject_student_id, e.payload_hash, e.prev_hash, e.entry_hash, e.recorded_at,
         CASE WHEN p.entry_id IS NULL THEN 'erased'
              WHEN encode(sha256(convert_to(p.payload, 'UTF8')), 'hex') = e.payload_hash THEN 'ok' ELSE 'mismatch' END
    FROM edal_entries e LEFT JOIN edal_payloads p ON p.entry_id=e.id
   WHERE e.district_id=eduos_ctx_district() AND eduos_edal_verifier() AND e.seq > p_after
   ORDER BY e.seq LIMIT least(greatest(p_limit, 1), 5000)
$$;
CREATE FUNCTION eduos_edal_head_info() RETURNS TABLE(seq bigint, head_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT h.seq, h.head_hash FROM edal_heads h WHERE h.district_id=eduos_ctx_district()
$$;
-- For one entry the caller can already read (RLS): the previous entry's hash,
-- the next entry's prev_hash and the head, so the record's links can be checked.
CREATE FUNCTION eduos_edal_neighbors(p_entry uuid) RETURNS TABLE(prev_entry_hash text, next_prev_hash text, head_seq bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e record;
BEGIN
  SELECT x.seq, x.district_id INTO e FROM edal_entries x WHERE x.id=p_entry AND x.district_id=eduos_ctx_district();
  IF e IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT
    CASE WHEN e.seq=1 THEN repeat('0', 64) ELSE (SELECT a.entry_hash FROM edal_entries a WHERE a.district_id=e.district_id AND a.seq=e.seq-1) END,
    (SELECT b.prev_hash FROM edal_entries b WHERE b.district_id=e.district_id AND b.seq=e.seq+1),
    (SELECT h.seq FROM edal_heads h WHERE h.district_id=e.district_id);
END; $$;

-- ---------------------------------------------------------------------------
-- Visibility helpers (caller's context).
-- ---------------------------------------------------------------------------
CREATE FUNCTION eduos_can_manage_course(p_course uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_owner_session() OR EXISTS(SELECT 1 FROM courses c WHERE c.id=p_course AND c.district_id=eduos_ctx_district() AND (
    eduos_ctx_role()='superintendent'
    OR (eduos_ctx_role()='principal' AND c.school_id=eduos_ctx_school())
    OR (eduos_ctx_role()='teacher' AND c.school_id=eduos_ctx_school() AND c.teacher_user_id=eduos_ctx_user())))
$$;
CREATE FUNCTION eduos_can_see_course(p_course uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_can_manage_course(p_course) OR EXISTS(SELECT 1 FROM course_enrollments e
    WHERE e.course_id=p_course AND e.district_id=eduos_ctx_district() AND e.status='active' AND eduos_is_linked_student(e.student_id))
$$;
-- Teachers see a learner's academic records through their roster or a course they teach.
CREATE FUNCTION eduos_teaches_student(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='teacher' AND (eduos_on_my_roster(p_student) OR EXISTS(SELECT 1 FROM course_enrollments e JOIN courses c ON c.id=e.course_id
    WHERE e.student_id=p_student AND e.district_id=eduos_ctx_district() AND e.status='active' AND c.teacher_user_id=eduos_ctx_user()))
$$;
CREATE FUNCTION eduos_learning_staff(p_school uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_owner_session() OR eduos_ctx_role()='superintendent'
      OR (eduos_ctx_role()='principal' AND p_school=eduos_ctx_school())
      OR (eduos_ctx_role()='teacher' AND p_school=eduos_ctx_school() AND eduos_teaches_student(p_student))
$$;
CREATE FUNCTION eduos_can_see_learning(p_school uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT eduos_learning_staff(p_school, p_student) OR eduos_is_linked_student(p_student) $$;
CREATE FUNCTION eduos_can_manage_assignment(p_assignment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_owner_session() OR EXISTS(SELECT 1 FROM assignments a WHERE a.id=p_assignment AND a.district_id=eduos_ctx_district() AND (
    eduos_ctx_role()='superintendent'
    OR (eduos_ctx_role()='principal' AND a.school_id=eduos_ctx_school())
    OR (eduos_ctx_role()='teacher' AND a.school_id=eduos_ctx_school() AND (a.created_by=eduos_ctx_user() OR (a.course_id IS NOT NULL AND eduos_can_manage_course(a.course_id))))))
$$;
CREATE FUNCTION eduos_parent_or_pupil_at(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM student_user_links l JOIN students s ON s.id=l.student_id
    WHERE l.user_id=eduos_ctx_user() AND l.district_id=eduos_ctx_district() AND l.status='active' AND s.school_id=p_school
      AND ((eduos_ctx_role()='parent' AND l.relationship IN ('parent','guardian')) OR (eduos_ctx_role()='pupil' AND l.relationship='pupil')))
$$;
CREATE FUNCTION eduos_can_see_assignment(p_assignment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_can_manage_assignment(p_assignment) OR EXISTS(SELECT 1 FROM assignments a WHERE a.id=p_assignment AND a.district_id=eduos_ctx_district()
    AND a.status IN ('published','closed') AND (
      (a.course_id IS NOT NULL AND eduos_can_see_course(a.course_id))
      OR (a.course_id IS NULL AND eduos_ctx_role() IN ('pupil','parent') AND eduos_parent_or_pupil_at(a.school_id))
      OR (a.course_id IS NULL AND eduos_ctx_role()='teacher' AND a.school_id=eduos_ctx_school())))
$$;
CREATE FUNCTION eduos_can_see_lesson(p_lesson uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM lessons l WHERE l.id=p_lesson AND l.district_id=eduos_ctx_district()
    AND (eduos_can_manage_course(l.course_id) OR (l.status='published' AND eduos_can_see_course(l.course_id))))
$$;
-- The learner's own in-progress attempt (responses may change only then).
CREATE FUNCTION eduos_my_open_attempt(p_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role()='pupil' AND EXISTS(SELECT 1 FROM quiz_attempts a WHERE a.id=p_attempt AND a.district_id=eduos_ctx_district()
    AND a.user_id=eduos_ctx_user() AND a.status='in_progress' AND eduos_is_linked_student(a.student_id))
$$;
CREATE FUNCTION eduos_can_see_attempt(p_attempt uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM quiz_attempts a WHERE a.id=p_attempt AND a.district_id=eduos_ctx_district()
    AND eduos_can_see_learning(a.school_id, a.student_id))
$$;
-- Answer keys for scoring a SUBMITTED attempt (the learner's own, or staff).
-- Keys are never readable directly by learners or families.
CREATE FUNCTION eduos_quiz_keys(p_attempt uuid) RETURNS TABLE(item_id uuid, answer_key jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.item_id, k.answer_key FROM quiz_attempts a JOIN quiz_items i ON i.assignment_id=a.assignment_id JOIN quiz_item_keys k ON k.item_id=i.id
   WHERE a.id=p_attempt AND a.district_id=eduos_ctx_district() AND a.status <> 'in_progress'
     AND ((eduos_ctx_role()='pupil' AND a.user_id=eduos_ctx_user()) OR eduos_learning_staff(a.school_id, a.student_id))
$$;
-- A learner submits their own open attempt (late = after the deadline + 60 s grace).
CREATE FUNCTION eduos_quiz_submit(p_attempt uuid) RETURNS TABLE(id uuid, late boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT eduos_my_open_attempt(p_attempt) THEN RETURN; END IF;
  RETURN QUERY UPDATE quiz_attempts a SET status='needs_review', submitted_at=now(),
      late = (a.deadline_at IS NOT NULL AND now() > a.deadline_at + interval '60 seconds')
    WHERE a.id=p_attempt RETURNING a.id, a.late;
END; $$;
-- Record the automatic scores once, right after submit (learner's own attempt
-- or staff). p_scores: [{"itemId":..,"correct":true|false|null,"points":n}].
-- Items with correct=null wait for the teacher, so the attempt stays needs_review.
CREATE FUNCTION eduos_quiz_record_auto(p_attempt uuid, p_scores jsonb, p_possible numeric) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a record; pending int; auto numeric;
BEGIN
  SELECT * INTO a FROM quiz_attempts x WHERE x.id=p_attempt AND x.district_id=eduos_ctx_district() FOR UPDATE;
  IF a IS NULL OR a.status <> 'needs_review' OR a.auto_points IS NOT NULL THEN RETURN NULL; END IF;
  IF NOT ((eduos_ctx_role()='pupil' AND a.user_id=eduos_ctx_user()) OR eduos_learning_staff(a.school_id, a.student_id)) THEN RETURN NULL; END IF;
  INSERT INTO quiz_responses(attempt_id,item_id,district_id,response)
    SELECT p_attempt, (x->>'itemId')::uuid, a.district_id, '' FROM jsonb_array_elements(p_scores) x
    WHERE EXISTS(SELECT 1 FROM quiz_items i WHERE i.id=(x->>'itemId')::uuid AND i.assignment_id=a.assignment_id)
    ON CONFLICT DO NOTHING;
  UPDATE quiz_responses r SET auto_correct=(x->>'correct')::boolean,
      auto_points=CASE WHEN x->>'correct' IS NULL THEN NULL ELSE least(greatest((x->>'points')::numeric, 0), i.points) END
    FROM jsonb_array_elements(p_scores) x, quiz_items i
   WHERE r.attempt_id=p_attempt AND r.item_id=(x->>'itemId')::uuid AND i.id=r.item_id AND i.assignment_id=a.assignment_id;
  SELECT count(*) FILTER (WHERE r.auto_correct IS NULL), coalesce(sum(r.auto_points), 0) INTO pending, auto
    FROM quiz_responses r WHERE r.attempt_id=p_attempt;
  UPDATE quiz_attempts SET auto_points=auto, possible_points=p_possible,
      total_points=CASE WHEN pending=0 THEN auto END, status=CASE WHEN pending=0 THEN 'scored' ELSE 'needs_review' END
   WHERE quiz_attempts.id=p_attempt;
  RETURN CASE WHEN pending=0 THEN 'scored' ELSE 'needs_review' END;
END; $$;
-- Course roster names for teachers who teach the course but not the learner's homeroom.
CREATE FUNCTION eduos_course_students(p_course uuid) RETURNS TABLE(student_id uuid, display_name text, grade_level text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.display_name, s.grade_level FROM course_enrollments e JOIN students s ON s.id=e.student_id
   WHERE e.course_id=p_course AND e.status='active' AND e.district_id=eduos_ctx_district() AND eduos_can_manage_course(p_course)
   ORDER BY s.display_name
$$;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['learning_standards','courses','course_enrollments','course_units','lessons','lesson_standards',
    'primary_sources','lesson_sources','assignment_standards','quiz_items','quiz_item_keys','student_accommodations','quiz_attempts',
    'quiz_responses','mastery_evidence','standard_mastery','course_final_grades','credentials',
    'edal_heads','edal_entries','edal_payloads','edal_checkpoints'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

CREATE FUNCTION eduos_is_school_lead(p_school uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT eduos_owner_session() OR eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND p_school=eduos_ctx_school())
$$;
CREATE FUNCTION eduos_is_staff() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT eduos_owner_session() OR eduos_ctx_role() IN ('superintendent','principal','teacher')
$$;

-- Standards: everyone in the district may read; staff add.
CREATE POLICY scope_write ON learning_standards AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_is_staff()));
-- Courses and their structure.
-- (Direct teacher/lead terms too: INSERT ... RETURNING checks the new row before helpers can see it.)
CREATE POLICY scope_read ON courses AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_is_school_lead(school_id)
  OR (eduos_ctx_role()='teacher' AND school_id=eduos_ctx_school() AND teacher_user_id=eduos_ctx_user()) OR eduos_can_see_course(id));
CREATE POLICY scope_insert ON courses AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_is_school_lead(school_id)
  OR (eduos_ctx_role()='teacher' AND school_id=eduos_ctx_school() AND teacher_user_id=eduos_ctx_user())));
CREATE POLICY scope_update ON courses AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR (eduos_can_manage_course(id))) WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(id)));
CREATE POLICY scope_read ON course_enrollments AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_manage_course(course_id) OR eduos_is_linked_student(student_id)));
CREATE POLICY scope_write ON course_enrollments AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id)));
CREATE POLICY scope_update ON course_enrollments AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR (eduos_can_manage_course(course_id))) WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id)));
CREATE POLICY scope_read ON course_units AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_course(course_id)));
CREATE POLICY scope_write ON course_units AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id)));
CREATE POLICY scope_update ON course_units AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR (eduos_can_manage_course(course_id))) WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id)));
CREATE POLICY scope_read ON lessons AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_manage_course(course_id) OR (status='published' AND eduos_can_see_course(course_id))));
CREATE POLICY scope_write ON lessons AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id) AND approved_at IS NULL));
CREATE POLICY scope_update ON lessons AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR (eduos_can_manage_course(course_id))) WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id)));
-- Only a school leader sets the approval; any content edit by someone else clears it.
CREATE FUNCTION eduos_lesson_approval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE lead boolean := eduos_is_school_lead((SELECT c.school_id FROM courses c WHERE c.id=NEW.course_id));
BEGIN
  IF NOT lead AND (NEW.approved_at IS DISTINCT FROM OLD.approved_at OR NEW.approved_by IS DISTINCT FROM OLD.approved_by)
     AND NEW.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'only a school leader approves lesson content for Christie';
  END IF;
  IF NOT lead AND (NEW.content IS DISTINCT FROM OLD.content OR NEW.title IS DISTINCT FROM OLD.title OR NEW.objective IS DISTINCT FROM OLD.objective) THEN
    NEW.approved_at := NULL; NEW.approved_by := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER lessons_approval_guard BEFORE UPDATE ON lessons FOR EACH ROW EXECUTE FUNCTION eduos_lesson_approval_guard();
CREATE POLICY scope_read ON lesson_standards AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_lesson(lesson_id)));
CREATE POLICY scope_write ON lesson_standards AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_is_staff()));
CREATE POLICY scope_read ON lesson_sources AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_lesson(lesson_id)));
CREATE POLICY scope_write ON lesson_sources AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_is_staff()));
-- Primary sources: approved ones for everyone in the district; drafts for staff.
CREATE POLICY scope_read ON primary_sources AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (status='approved' OR eduos_is_staff()));
CREATE POLICY scope_insert ON primary_sources AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_is_staff() AND curated_by=coalesce(eduos_ctx_user(), curated_by) AND (status='draft' OR eduos_is_table_owner())));
CREATE POLICY scope_update ON primary_sources AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','principal'))
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','principal'));
-- Assignment standards and quiz items follow the assignment.
CREATE POLICY scope_read ON assignment_standards AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_assignment(assignment_id)));
CREATE POLICY scope_write ON assignment_standards AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_assignment(assignment_id)));
CREATE POLICY scope_read ON quiz_items AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_assignment(assignment_id)));
CREATE POLICY scope_write ON quiz_items AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_assignment(assignment_id)));
CREATE POLICY scope_read ON quiz_item_keys AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent','principal','teacher')
         AND eduos_can_manage_assignment((SELECT i.assignment_id FROM quiz_items i WHERE i.id=item_id))));
CREATE POLICY scope_write ON quiz_item_keys AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_assignment((SELECT i.assignment_id FROM quiz_items i WHERE i.id=item_id))));
-- Accommodations: staff with scope set them; the learner and family can read.
CREATE POLICY scope_read ON student_accommodations AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_learning(school_id, student_id)));
CREATE POLICY scope_insert ON student_accommodations AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id)));
CREATE POLICY scope_update ON student_accommodations AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id))) WITH CHECK (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id)));
-- Attempts and responses.
CREATE POLICY scope_read ON quiz_attempts AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_learning(school_id, student_id)));
CREATE POLICY scope_insert ON quiz_attempts AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='pupil' AND user_id=eduos_ctx_user() AND eduos_is_linked_student(student_id) AND status='in_progress'));
-- Learners never update attempts directly: eduos_quiz_submit / eduos_quiz_record_auto do it.
CREATE POLICY scope_update ON quiz_attempts AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id))) WITH CHECK (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id)));
CREATE POLICY scope_read ON quiz_responses AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_attempt(attempt_id)));
CREATE POLICY scope_insert ON quiz_responses AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_my_open_attempt(attempt_id));
CREATE POLICY scope_update ON quiz_responses AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_my_open_attempt(attempt_id) OR (eduos_ctx_role() IN ('superintendent','principal','teacher') AND eduos_can_see_attempt(attempt_id)))
  WITH CHECK (eduos_is_table_owner() OR eduos_my_open_attempt(attempt_id) OR (eduos_ctx_role() IN ('superintendent','principal','teacher') AND eduos_can_see_attempt(attempt_id)));
-- Mastery: staff with scope, the learner and their family read. Evidence is
-- written by staff (grading) or in the learner's own session (quiz auto-score,
-- Christie practice).
CREATE POLICY scope_read ON mastery_evidence AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_learning(school_id, student_id)));
CREATE POLICY scope_insert ON mastery_evidence AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id) OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(student_id) AND source IN ('quiz','christie'))));
CREATE POLICY scope_read ON standard_mastery AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_learning(school_id, student_id)));
CREATE POLICY scope_insert ON standard_mastery AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id) OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(student_id))));
CREATE POLICY scope_update ON standard_mastery AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id) OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(student_id))))
  WITH CHECK (eduos_is_table_owner() OR (eduos_learning_staff(school_id, student_id) OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(student_id))));
-- Final grades: the course's teacher or a school leader posts.
CREATE POLICY scope_read ON course_final_grades AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_learning(school_id, student_id)));
CREATE POLICY scope_insert ON course_final_grades AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id) AND posted_by=coalesce(eduos_ctx_user(), posted_by)));
-- Credentials: school leaders issue and revoke.
CREATE POLICY scope_read ON credentials AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_can_see_learning(school_id, student_id)));
CREATE POLICY scope_insert ON credentials AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_is_school_lead(school_id)));
CREATE POLICY scope_update ON credentials AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR (eduos_is_school_lead(school_id))) WITH CHECK (eduos_is_table_owner() OR (eduos_is_school_lead(school_id)));
-- EDAL: heads only through the definer functions.
CREATE POLICY scope_none ON edal_heads AS RESTRICTIVE FOR ALL USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_read ON edal_entries AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())
      OR (subject_student_id IS NOT NULL AND (eduos_teaches_student(subject_student_id) OR eduos_is_linked_student(subject_student_id))));
CREATE POLICY scope_insert ON edal_entries AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (recorded_by=eduos_ctx_user() AND (
       (kind='final_grade' AND eduos_learning_staff(school_id, subject_student_id))
    OR (kind IN ('credential','credential_revoked') AND eduos_is_school_lead(school_id))
    OR (kind='mastery_milestone' AND (eduos_learning_staff(school_id, subject_student_id) OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(subject_student_id)))))));
CREATE POLICY scope_read ON edal_payloads AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR (EXISTS(SELECT 1 FROM edal_entries e WHERE e.id=entry_id)));   -- the entry's own RLS decides
CREATE POLICY scope_insert ON edal_payloads AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (EXISTS(SELECT 1 FROM edal_entries e WHERE e.id=entry_id)));
CREATE POLICY scope_read ON edal_checkpoints AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR (eduos_edal_verifier()));
CREATE POLICY scope_insert ON edal_checkpoints AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_edal_verifier() AND created_by=coalesce(eduos_ctx_user(), created_by)));

-- ---------------------------------------------------------------------------
-- FERPA record deletion: 32.6.0 learner records first, then the 32.5.0 body.
-- EDAL entries stay (hashes + an opaque id) so the chain still verifies; the
-- payloads that hold the learner's data are erased.
-- ---------------------------------------------------------------------------
ALTER FUNCTION eduos_purge_student(uuid) RENAME TO eduos_purge_student_325;
CREATE FUNCTION eduos_purge_student(p_student uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; out jsonb := '{}'::jsonb; rest jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM students WHERE id=p_student AND district_id=d) THEN RETURN NULL; END IF;
  PERFORM set_config('eduos.retention_purge', 'on', true);
  DELETE FROM quiz_responses r USING quiz_attempts a WHERE r.attempt_id=a.id AND a.student_id=p_student AND a.district_id=d;
  DELETE FROM quiz_attempts WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('quiz_attempts', n);
  DELETE FROM mastery_evidence WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('mastery_evidence', n);
  DELETE FROM standard_mastery WHERE student_id=p_student AND district_id=d;
  DELETE FROM student_accommodations WHERE student_id=p_student AND district_id=d;
  DELETE FROM course_final_grades WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('final_grades', n);
  DELETE FROM credentials WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('credentials', n);
  DELETE FROM course_enrollments WHERE student_id=p_student AND district_id=d;
  DELETE FROM edal_payloads p USING edal_entries e WHERE p.entry_id=e.id AND e.subject_student_id=p_student AND e.district_id=d;
  GET DIAGNOSTICS n = ROW_COUNT; out := out || jsonb_build_object('edal_payloads_erased', n);
  rest := eduos_purge_student_325(p_student);
  RETURN out || coalesce(rest, '{}'::jsonb);
END; $$;
REVOKE ALL ON FUNCTION eduos_purge_student(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_purge_student_325(uuid) FROM PUBLIC;

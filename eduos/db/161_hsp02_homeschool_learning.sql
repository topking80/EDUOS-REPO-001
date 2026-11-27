-- HSP-02: homeschool learning operations (design: docs/product/hsp-02-homeschool-learning.md).
--
-- Family-owned learning records, isolated by app.family_id like HSP-01, with
-- per-learner authority: anyone with authority over a learner reads; the
-- owner or a co-educator with educational authority writes; exports need
-- full authority. Nothing here touches a district table.
--
--   family_courses        a learner's plan: courses for a school year, with a final grade and credits when done
--   family_goals          learning goals, optionally under a course
--   family_attendance     instruction sessions: date, minutes, kind; corrected by voiding, never deleted
--   family_work           work and evidence: parent-entered or from an outside source (named), with an optional score
--   family_exports        every progress report, transcript or portfolio export (who, what, its hash)

CREATE TABLE family_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  subject text CHECK (subject IS NULL OR length(btrim(subject)) BETWEEN 1 AND 80),
  school_year text NOT NULL CHECK (school_year ~ '^[0-9]{4}-[0-9]{4}$'),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','archived')),
  final_grade text CHECK (final_grade IS NULL OR length(btrim(final_grade)) BETWEEN 1 AND 20),
  credits numeric(4,2) CHECK (credits IS NULL OR (credits >= 0 AND credits <= 10)),
  completed_on date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id),
  CHECK ((status = 'completed') = (completed_on IS NOT NULL)),
  UNIQUE (family_id, id)
);
CREATE INDEX family_courses_learner ON family_courses(family_id, learner_id, school_year);

CREATE TABLE family_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  course_id uuid,
  text text NOT NULL CHECK (length(btrim(text)) BETWEEN 1 AND 500),
  target_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','met','dropped')),
  met_on date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id),
  FOREIGN KEY (family_id, course_id) REFERENCES family_courses(family_id, id),
  CHECK ((status = 'met') = (met_on IS NOT NULL))
);

CREATE TABLE family_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  day date NOT NULL,
  minutes integer NOT NULL CHECK (minutes BETWEEN 0 AND 1440),
  kind text NOT NULL DEFAULT 'instruction' CHECK (kind IN ('instruction','field_trip','co_op','independent','absent')),
  course_id uuid,
  note text CHECK (note IS NULL OR length(note) <= 500),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 300),
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id),
  FOREIGN KEY (family_id, course_id) REFERENCES family_courses(family_id, id),
  CHECK (kind <> 'absent' OR minutes = 0),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX family_attendance_learner_day ON family_attendance(family_id, learner_id, day);

CREATE TABLE family_work (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  course_id uuid,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'assignment' CHECK (kind IN ('assignment','project','test','reading','activity','certificate')),
  done_on date NOT NULL,
  score numeric(7,2) CHECK (score IS NULL OR score >= 0),
  max_score numeric(7,2) CHECK (max_score IS NULL OR max_score > 0),
  grade_label text CHECK (grade_label IS NULL OR length(btrim(grade_label)) BETWEEN 1 AND 20),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  -- Who the record comes from. 'parent_entered': this family. 'external': an
  -- outside course, test or program, named in source; still entered by the
  -- family and not verified by EduOS.
  provenance text NOT NULL DEFAULT 'parent_entered' CHECK (provenance IN ('parent_entered','external')),
  source text CHECK (source IS NULL OR length(btrim(source)) BETWEEN 2 AND 200),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 300),
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id),
  FOREIGN KEY (family_id, course_id) REFERENCES family_courses(family_id, id),
  CHECK ((provenance = 'external') = (source IS NOT NULL)),
  CHECK (score IS NULL OR max_score IS NOT NULL),
  CHECK (score IS NULL OR score <= max_score * 2),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX family_work_learner ON family_work(family_id, learner_id, done_on);

CREATE TABLE family_exports (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES homeschool_families(id),
  learner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('progress_report','transcript','portfolio')),
  period_from date,
  period_to date,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (family_id, learner_id) REFERENCES family_learners(family_id, id)
);
CREATE TRIGGER family_exports_append_only BEFORE UPDATE OR DELETE ON family_exports FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- Can the signed-in user write this learner's learning records?
CREATE FUNCTION eduos_family_can_teach(p_learner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_family_authority(p_learner) IN ('full','educational'), false)
     AND EXISTS (SELECT 1 FROM family_learners l WHERE l.id = p_learner AND l.family_id = eduos_ctx_family() AND l.status = 'active')
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['family_courses','family_goals','family_attendance','family_work','family_exports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY family_isolation ON %I
      USING (eduos_is_table_owner() OR family_id = eduos_ctx_family())
      WITH CHECK (eduos_is_table_owner() OR family_id = eduos_ctx_family())$p$, t);
    -- Read: any authority over the learner. Write: owner or educational authority.
    EXECUTE format($p$CREATE POLICY learner_read ON %I AS RESTRICTIVE FOR SELECT
      USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_authority(learner_id) IS NOT NULL END)$p$, t);
    EXECUTE format($p$CREATE POLICY learner_write ON %I AS RESTRICTIVE FOR INSERT
      WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_can_teach(learner_id) END)$p$, t);
    EXECUTE format($p$CREATE POLICY learner_update ON %I AS RESTRICTIVE FOR UPDATE
      USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_can_teach(learner_id) END)$p$, t);
  END LOOP;
END $$;
-- Exports: full authority only, and the exporter is the signed-in user.
CREATE POLICY export_full_authority ON family_exports AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_family_authority(learner_id) = 'full' AND created_by = eduos_ctx_user() END);

REVOKE ALL ON FUNCTION eduos_family_can_teach(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN GRANT EXECUTE ON FUNCTION eduos_family_can_teach(uuid) TO eduos_app; END IF;
END $$;

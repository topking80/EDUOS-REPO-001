-- HSP-04: private school admissions and academics (design: docs/product/hsp-04-private-school-academics.md).
--
--   ps_applications           admissions: inquiry -> application -> review -> offer / waitlist / decline
--                             -> accepted -> enrolled (creates the learner); re-enrollment for current learners
--   ps_classes, ps_class_meetings, ps_class_rosters
--                             classes for a school year and term, a weekly schedule, and who's in them
--   ps_attendance             daily or per-class attendance; corrected by voiding with a reason
--   ps_report_cards, ps_report_card_lines
--                             a learner's term report: teachers write their classes' lines while it's a draft;
--                             the registrar or school administrator publishes it; guardians see it once published
--
-- Isolated by school like HSP-03, with the session's own membership deciding
-- the role. Applicants are not learners: their records stay with admissions
-- until they enroll.

CREATE TABLE ps_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  campus_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'new' CHECK (kind IN ('new','re_enrollment')),
  learner_id uuid,
  applicant_name text NOT NULL CHECK (length(btrim(applicant_name)) BETWEEN 1 AND 120),
  grade_level text CHECK (grade_level IS NULL OR grade_level IN ('pre_k','k','1','2','3','4','5','6','7','8','9','10','11','12')),
  school_year text NOT NULL CHECK (school_year ~ '^[0-9]{4}-[0-9]{4}$'),
  guardian_name text CHECK (guardian_name IS NULL OR length(btrim(guardian_name)) BETWEEN 1 AND 120),
  guardian_email text CHECK (guardian_email IS NULL OR (guardian_email = lower(guardian_email) AND guardian_email LIKE '%@%' AND length(guardian_email) <= 320)),
  status text NOT NULL DEFAULT 'inquiry' CHECK (status IN ('inquiry','applied','under_review','offered','waitlisted','accepted','declined','withdrawn','not_offered','enrolled')),
  waitlist_position integer CHECK (waitlist_position IS NULL OR waitlist_position >= 1),
  documents jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(documents) = 'array' AND length(documents::text) <= 4000),
  notes text CHECK (notes IS NULL OR length(notes) <= 4000),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, campus_id) REFERENCES private_school_campuses(school_id, id),
  FOREIGN KEY (school_id, learner_id) REFERENCES private_school_learners(school_id, id),
  CHECK (kind = 'new' OR learner_id IS NOT NULL),
  CHECK (status <> 'enrolled' OR learner_id IS NOT NULL),
  CHECK ((status = 'waitlisted') = (waitlist_position IS NOT NULL)),
  UNIQUE (school_id, id)
);
CREATE INDEX ps_applications_status ON ps_applications(school_id, school_year, status);

CREATE TABLE ps_application_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  school_id uuid NOT NULL,
  application_id uuid NOT NULL,
  from_status text,
  to_status text NOT NULL,
  note text CHECK (note IS NULL OR length(note) <= 1000),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, application_id) REFERENCES ps_applications(school_id, id)
);
CREATE TRIGGER ps_application_events_append_only BEFORE UPDATE OR DELETE ON ps_application_events FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE ps_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  campus_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  subject text CHECK (subject IS NULL OR length(btrim(subject)) BETWEEN 1 AND 80),
  grade_level text CHECK (grade_level IS NULL OR grade_level IN ('pre_k','k','1','2','3','4','5','6','7','8','9','10','11','12')),
  school_year text NOT NULL CHECK (school_year ~ '^[0-9]{4}-[0-9]{4}$'),
  term text NOT NULL DEFAULT 'year' CHECK (length(btrim(term)) BETWEEN 1 AND 40),
  teacher_membership_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, campus_id) REFERENCES private_school_campuses(school_id, id),
  FOREIGN KEY (school_id, teacher_membership_id) REFERENCES private_school_memberships(school_id, id),
  UNIQUE (school_id, id)
);

CREATE TABLE ps_class_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  starts time NOT NULL,
  ends time NOT NULL,
  room text CHECK (room IS NULL OR length(btrim(room)) BETWEEN 1 AND 40),
  FOREIGN KEY (school_id, class_id) REFERENCES ps_classes(school_id, id),
  CHECK (ends > starts)
);

CREATE TABLE ps_class_rosters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  class_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  added_by uuid NOT NULL REFERENCES users(id),
  added_on date NOT NULL DEFAULT CURRENT_DATE,
  removed_by uuid REFERENCES users(id),
  removed_on date,
  FOREIGN KEY (school_id, class_id) REFERENCES ps_classes(school_id, id),
  FOREIGN KEY (school_id, learner_id) REFERENCES private_school_learners(school_id, id),
  CHECK ((removed_on IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX ps_class_rosters_open ON ps_class_rosters(class_id, learner_id) WHERE removed_on IS NULL;

CREATE TABLE ps_attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  class_id uuid,
  day date NOT NULL,
  status text NOT NULL CHECK (status IN ('present','tardy','absent','excused')),
  note text CHECK (note IS NULL OR length(note) <= 300),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 300),
  FOREIGN KEY (school_id, learner_id) REFERENCES private_school_learners(school_id, id),
  FOREIGN KEY (school_id, class_id) REFERENCES ps_classes(school_id, id),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
-- One live mark per learner, day and class (or the daily mark).
CREATE UNIQUE INDEX ps_attendance_live ON ps_attendance(learner_id, day, coalesce(class_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE voided_at IS NULL;

CREATE TABLE ps_report_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  school_year text NOT NULL CHECK (school_year ~ '^[0-9]{4}-[0-9]{4}$'),
  term text NOT NULL CHECK (length(btrim(term)) BETWEEN 1 AND 40),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  comment text CHECK (comment IS NULL OR length(comment) <= 2000),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  FOREIGN KEY (school_id, learner_id) REFERENCES private_school_learners(school_id, id),
  CHECK ((status = 'published') = (published_at IS NOT NULL AND published_by IS NOT NULL)),
  UNIQUE (school_id, id),
  UNIQUE (learner_id, school_year, term)
);

CREATE TABLE ps_report_card_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  report_card_id uuid NOT NULL,
  class_id uuid NOT NULL,
  grade text CHECK (grade IS NULL OR length(btrim(grade)) BETWEEN 1 AND 20),
  comment text CHECK (comment IS NULL OR length(comment) <= 1000),
  written_by uuid NOT NULL REFERENCES users(id),
  written_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, report_card_id) REFERENCES ps_report_cards(school_id, id),
  FOREIGN KEY (school_id, class_id) REFERENCES ps_classes(school_id, id),
  UNIQUE (report_card_id, class_id)
);

-- ---------------------------------------------------------------- helpers
-- The session's membership teaches this class.
CREATE FUNCTION eduos_ps_teaches(p_class uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ps_has(ARRAY['teacher']) AND EXISTS (SELECT 1 FROM ps_classes k WHERE k.id = p_class AND k.school_id = eduos_ctx_private_school()
    AND k.teacher_membership_id = eduos_ctx_ps_membership() AND k.status = 'active')
$$;
-- School-wide admissions and scheduling, or a campus administrator for their campus.
CREATE FUNCTION eduos_ps_runs_campus(p_campus uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ps_has(ARRAY['school_admin','registrar']) OR (eduos_ps_has(ARRAY['campus_admin']) AND p_campus = ANY(eduos_ps_campuses()))
$$;
CREATE FUNCTION eduos_ps_class_campus(p_class uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT campus_id FROM ps_classes WHERE id = p_class AND school_id = eduos_ctx_private_school() $$;
CREATE FUNCTION eduos_ps_learner_campus(p_learner uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT campus_id FROM private_school_learners WHERE id = p_learner AND school_id = eduos_ctx_private_school() $$;
-- Guardians see a class when one of their children is on its roster.
CREATE FUNCTION eduos_ps_sees_class(p_class uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ps_has(ARRAY['school_admin','registrar','campus_admin','teacher','staff']) AND (eduos_ps_has(ARRAY['school_admin','registrar']) OR eduos_ps_class_campus(p_class) = ANY(eduos_ps_campuses()))
      OR (eduos_ps_has(ARRAY['guardian']) AND EXISTS (SELECT 1 FROM ps_class_rosters r WHERE r.class_id = p_class AND r.removed_on IS NULL AND eduos_ps_sees_learner(r.learner_id)))
$$;

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_applications','ps_application_events','ps_classes','ps_class_meetings','ps_class_rosters','ps_attendance','ps_report_cards','ps_report_card_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY school_isolation ON %I
      USING (eduos_is_table_owner() OR school_id = eduos_ctx_private_school())
      WITH CHECK (eduos_is_table_owner() OR school_id = eduos_ctx_private_school())$p$, t);
    EXECUTE format($p$CREATE POLICY members_only ON %I AS RESTRICTIVE
      USING (CASE WHEN eduos_is_table_owner() THEN true ELSE cardinality(eduos_ps_roles()) > 0 END)$p$, t);
  END LOOP;
END $$;
-- Admissions: the school admin, the registrar, a campus admin for their campus; only once the school is verified.
CREATE POLICY admissions_visible ON ps_applications AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_runs_campus(campus_id) END);
CREATE POLICY admissions_written ON ps_applications AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_active() AND eduos_ps_runs_campus(campus_id) END);
CREATE POLICY admissions_changed ON ps_applications AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_active() AND eduos_ps_runs_campus(campus_id) END);
CREATE POLICY admission_events_visible ON ps_application_events AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE EXISTS (SELECT 1 FROM ps_applications a WHERE a.id = application_id) END);
CREATE POLICY admission_events_written ON ps_application_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE actor_user_id = eduos_ctx_user() AND EXISTS (SELECT 1 FROM ps_applications a WHERE a.id = application_id) END);
-- Classes and schedules: seen by staff on the campus and guardians of rostered children; run by the school admin, registrar or campus admin.
CREATE POLICY class_visible ON ps_classes AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_sees_class(id) END);
CREATE POLICY class_written ON ps_classes AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_runs_campus(campus_id) END);
CREATE POLICY class_changed ON ps_classes AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_runs_campus(campus_id) END);
CREATE POLICY meeting_visible ON ps_class_meetings AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_sees_class(class_id) END);
CREATE POLICY meeting_written ON ps_class_meetings AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_runs_campus(eduos_ps_class_campus(class_id)) END);
CREATE POLICY roster_visible ON ps_class_rosters AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_sees_learner(learner_id) AND eduos_ps_sees_class(class_id) END);
CREATE POLICY roster_written ON ps_class_rosters AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_active() AND eduos_ps_runs_campus(eduos_ps_class_campus(class_id)) END);
CREATE POLICY roster_changed ON ps_class_rosters AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_runs_campus(eduos_ps_class_campus(class_id)) END);
-- Attendance: seen with the learner; a class mark by its teacher, a daily mark by the campus's administrators or the registrar.
CREATE POLICY attendance_visible ON ps_attendance AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_sees_learner(learner_id) END);
CREATE POLICY attendance_written ON ps_attendance AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_active() AND recorded_by = eduos_ctx_user() AND
    (CASE WHEN class_id IS NOT NULL THEN eduos_ps_teaches(class_id) OR eduos_ps_runs_campus(eduos_ps_class_campus(class_id))
          ELSE eduos_ps_runs_campus(eduos_ps_learner_campus(learner_id)) END) END);
CREATE POLICY attendance_voided ON ps_attendance AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE
    (CASE WHEN class_id IS NOT NULL THEN eduos_ps_teaches(class_id) OR eduos_ps_runs_campus(eduos_ps_class_campus(class_id))
          ELSE eduos_ps_runs_campus(eduos_ps_learner_campus(learner_id)) END) END);
-- Report cards: staff see them with the learner; guardians only once published. Drafts are made and published by the registrar or school admin
-- (or a campus admin for their campus); teachers write lines for their own classes while a card is a draft.
CREATE POLICY card_visible ON ps_report_cards AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_sees_learner(learner_id) AND (status = 'published' OR NOT eduos_ps_has(ARRAY['guardian'])) END);
CREATE POLICY card_written ON ps_report_cards AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_active() AND eduos_ps_runs_campus(eduos_ps_learner_campus(learner_id)) END);
CREATE POLICY card_changed ON ps_report_cards AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_runs_campus(eduos_ps_learner_campus(learner_id)) END);
CREATE POLICY line_visible ON ps_report_card_lines AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE EXISTS (SELECT 1 FROM ps_report_cards r WHERE r.id = report_card_id) END);
CREATE POLICY line_written ON ps_report_card_lines AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE written_by = eduos_ctx_user()
    AND EXISTS (SELECT 1 FROM ps_report_cards r WHERE r.id = report_card_id AND r.status = 'draft')
    AND (eduos_ps_teaches(class_id) OR eduos_ps_runs_campus(eduos_ps_class_campus(class_id))) END);
CREATE POLICY line_changed ON ps_report_card_lines AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE EXISTS (SELECT 1 FROM ps_report_cards r WHERE r.id = report_card_id AND r.status = 'draft')
    AND (eduos_ps_teaches(class_id) OR eduos_ps_runs_campus(eduos_ps_class_campus(class_id))) END);

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_ps_teaches(uuid)','eduos_ps_runs_campus(uuid)','eduos_ps_class_campus(uuid)','eduos_ps_learner_campus(uuid)','eduos_ps_sees_class(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;
CREATE POLICY meeting_deleted ON ps_class_meetings AS RESTRICTIVE FOR DELETE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_runs_campus(eduos_ps_class_campus(class_id)) END);

-- TC-05: the remaining privacy controls for Student History and Time Capsules.
--
-- 088/090 decide who may see or write what from how the session relates to
-- the student (guardian, student, teacher, school lead, district). This adds:
--
--   * Custody restrictions: a school lead or the superintendent records a
--     court order or a disputed guardianship, with its basis. While it stands,
--     that guardian has no relationship to the student's history or capsules
--     (and can't be a capsule recipient). Lifting it needs a note.
--   * Student rights transition: the school records that the student now holds
--     their own record rights (age 18, postsecondary, emancipation). Guardians
--     then see only what the student shares with them, and what they wrote.
--   * Sharing grants: after the transition, the student shares chosen kinds of
--     records with a guardian, until a date; revoking takes effect at once
--     (every read checks the grant).
--   * Emergency access: a counselor, nurse or school resource officer at the
--     student's school states a reason and sees official records only, for at
--     most four hours; the superintendent reviews every one.
--   * Access log: reads of a student's history are logged; the student, their
--     guardians and school leads can see who looked.
--
-- Grants and emergency access only add read access to published items; they
-- never make someone a guardian, teacher or lead, so they can't write records
-- or create capsules. Staff offboarding needs nothing new: relationships
-- require an active membership (and, for teachers, the roster) at read time.

CREATE TABLE student_custody_restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  restricted_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('court_order','disputed')),
  basis text NOT NULL CHECK (length(btrim(basis)) BETWEEN 5 AND 300),
  document_ref text CHECK (document_ref IS NULL OR length(btrim(document_ref)) BETWEEN 1 AND 200),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now(),
  ends_on date,
  lifted_by uuid REFERENCES users(id),
  lifted_at timestamptz,
  lift_note text CHECK (lift_note IS NULL OR length(btrim(lift_note)) BETWEEN 5 AND 300),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL) AND (lifted_at IS NULL) = (lift_note IS NULL)),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX student_custody_restrictions_open ON student_custody_restrictions(student_id, restricted_user_id) WHERE lifted_at IS NULL;

CREATE TABLE student_rights_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  basis text NOT NULL CHECK (basis IN ('age_18','postsecondary','emancipated','other')),
  effective_on date NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  reversed_by uuid REFERENCES users(id),
  reversed_at timestamptz,
  reverse_note text CHECK (reverse_note IS NULL OR length(btrim(reverse_note)) BETWEEN 5 AND 300),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id)
);
CREATE UNIQUE INDEX student_rights_transitions_open ON student_rights_transitions(student_id) WHERE reversed_at IS NULL;

CREATE TABLE history_sharing_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  granted_by uuid NOT NULL REFERENCES users(id),
  grantee_user_id uuid NOT NULL REFERENCES users(id),
  classifications text[] NOT NULL CHECK (cardinality(classifications) BETWEEN 1 AND 4
    AND classifications <@ ARRAY['family_memory','student_portfolio','teacher_artifact','official_record']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days'),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  CHECK (grantee_user_id <> granted_by),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id)
);
CREATE INDEX history_sharing_grants_grantee ON history_sharing_grants(district_id, grantee_user_id, student_id) WHERE revoked_at IS NULL;

CREATE TABLE history_emergency_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('counselor','nurse','sro')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 20 AND 500),
  opened_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > opened_at AND expires_at <= opened_at + interval '4 hours'),
  closed_at timestamptz,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(btrim(review_note)) BETWEEN 1 AND 500),
  CHECK (reviewed_by IS NULL OR reviewed_by <> user_id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id)
);
CREATE INDEX history_emergency_access_open ON history_emergency_access(district_id, user_id, student_id, expires_at);

CREATE TABLE history_access_log (
  id bigserial PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  student_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  access text NOT NULL CHECK (access IN ('guardian','student','teacher','school_lead','district','grant','emergency')),
  action text NOT NULL CHECK (action IN ('view_history','view_capsule')),
  item_count integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id)
);
CREATE INDEX history_access_log_student ON history_access_log(district_id, student_id, at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['student_custody_restrictions','student_rights_transitions','history_sharing_grants','history_emergency_access','history_access_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- ---------- the checks every read and write goes through ----------
CREATE FUNCTION eduos_custody_blocked(p_student uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM student_custody_restrictions r WHERE r.student_id = p_student AND r.restricted_user_id = p_user
    AND r.lifted_at IS NULL AND (r.ends_on IS NULL OR r.ends_on >= current_date))
$$;
CREATE FUNCTION eduos_student_holds_rights(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM student_rights_transitions t WHERE t.student_id = p_student AND t.reversed_at IS NULL AND t.effective_on <= current_date)
$$;

-- 088's relationship, with custody restrictions and the rights transition for guardians.
CREATE OR REPLACE FUNCTION eduos_history_relation(p_district uuid, p_school uuid, p_student uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_district IS DISTINCT FROM eduos_ctx_district() OR eduos_ctx_user() IS NULL THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM memberships m WHERE m.district_id=p_district AND m.user_id=eduos_ctx_user()
          AND m.role=eduos_ctx_role() AND m.school_id IS NOT DISTINCT FROM eduos_ctx_school() AND m.status='active') THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM students s WHERE s.id=p_student AND s.district_id=p_district) THEN NULL
    WHEN eduos_ctx_role()='superintendent' THEN 'district'
    WHEN eduos_ctx_role()='parent' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
          AND l.student_id=p_student AND l.user_id=eduos_ctx_user() AND l.status='active' AND l.relationship IN ('parent','guardian'))
          AND NOT public.eduos_custody_blocked(p_student, eduos_ctx_user()) AND NOT public.eduos_student_holds_rights(p_student) THEN 'guardian'
    WHEN eduos_ctx_role()='pupil' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
          AND l.student_id=p_student AND l.user_id=eduos_ctx_user() AND l.status='active' AND l.relationship='pupil') THEN 'student'
    WHEN eduos_ctx_role()='teacher' AND p_school=eduos_ctx_school() AND EXISTS (SELECT 1 FROM teacher_student_rosters r
          WHERE r.district_id=p_district AND r.school_id=p_school AND r.student_id=p_student AND r.teacher_user_id=eduos_ctx_user()) THEN 'teacher'
    WHEN eduos_ctx_role() IN ('principal','vice_principal') AND p_school=eduos_ctx_school() THEN 'school_lead'
  END
$$;

-- 088's "is this user related" check (capsule recipients, named guardian
-- authors): a custody-restricted guardian isn't one.
CREATE OR REPLACE FUNCTION eduos_history_user_is(p_district uuid, p_school uuid, p_student uuid, p_user uuid, p_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'guardian' THEN EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district AND l.student_id=p_student
      AND l.user_id=p_user AND l.status='active' AND l.relationship IN ('parent','guardian')) AND NOT public.eduos_custody_blocked(p_student, p_user)
    WHEN 'student' THEN EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district AND l.student_id=p_student
      AND l.user_id=p_user AND l.status='active' AND l.relationship='pupil')
    WHEN 'teacher' THEN EXISTS (SELECT 1 FROM teacher_student_rosters r WHERE r.district_id=p_district AND r.school_id=p_school
      AND r.student_id=p_student AND r.teacher_user_id=p_user)
    WHEN 'school_staff' THEN EXISTS (SELECT 1 FROM memberships m WHERE m.district_id=p_district AND m.school_id=p_school
      AND m.user_id=p_user AND m.status='active' AND m.role NOT IN ('parent','pupil'))
    ELSE false END
$$;

-- Read-only access from a sharing grant (for this session user, now).
CREATE FUNCTION eduos_history_granted(p_district uuid, p_student uuid, p_classification text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_district = eduos_ctx_district() AND EXISTS (SELECT 1 FROM history_sharing_grants g WHERE g.district_id = p_district AND g.student_id = p_student
    AND g.grantee_user_id = eduos_ctx_user() AND g.revoked_at IS NULL AND g.expires_at > now() AND p_classification = ANY (g.classifications))
    AND NOT public.eduos_custody_blocked(p_student, eduos_ctx_user()) AND public.eduos_student_holds_rights(p_student)
$$;
-- Read-only emergency access to official records (for this session, now).
CREATE FUNCTION eduos_history_emergency(p_district uuid, p_school uuid, p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_district = eduos_ctx_district() AND coalesce(eduos_ctx_role(), '') IN ('counselor','nurse','sro') AND p_school = eduos_ctx_school()
    AND EXISTS (SELECT 1 FROM history_emergency_access a WHERE a.district_id = p_district AND a.student_id = p_student AND a.user_id = eduos_ctx_user()
      AND a.closed_at IS NULL AND a.expires_at > now())
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.district_id = p_district AND m.user_id = eduos_ctx_user() AND m.role = eduos_ctx_role()
      AND m.school_id = p_school AND m.status = 'active')
$$;
-- A guardian keeps seeing what they wrote after the student takes over their rights (not under a custody restriction).
CREATE FUNCTION eduos_history_own_after_transition(p_district uuid, p_student uuid, p_author uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_author = eduos_ctx_user() AND p_district = eduos_ctx_district() AND eduos_ctx_role() = 'parent'
    AND public.eduos_student_holds_rights(p_student) AND NOT public.eduos_custody_blocked(p_student, eduos_ctx_user())
    AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id = p_district AND l.student_id = p_student AND l.user_id = eduos_ctx_user()
      AND l.status = 'active' AND l.relationship IN ('parent','guardian'))
$$;

-- 090's visibility, plus grants, emergency access and a guardian's own items after the transition.
CREATE OR REPLACE FUNCTION eduos_history_entry_visible(p_district uuid, p_school uuid, p_student uuid,
  p_classification text, p_audience text, p_status text, p_author uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_status <> 'deleted' AND (
    (rel IS NOT NULL AND (
      p_author = eduos_ctx_user()
      OR (p_status IN ('published','archived') AND CASE p_audience
            WHEN 'student'   THEN rel IN ('student','guardian')
            WHEN 'family'    THEN rel IN ('student','guardian')
            WHEN 'classroom' THEN rel IN ('student','guardian','teacher','school_lead')
            WHEN 'school'    THEN rel IN ('student','guardian','teacher','school_lead','district')
            ELSE false END)
      OR (p_status = 'approved' AND p_audience <> 'private' AND (
            (rel = 'guardian' AND p_audience IN ('student','family','classroom','school'))
            OR (rel IN ('school_lead','district') AND p_classification <> 'family_memory')))
      OR (rel IN ('school_lead','district') AND p_classification <> 'family_memory'
          AND p_audience <> 'private' AND p_status IN ('submitted','restricted','pending_deletion'))))
    OR (p_status IN ('published','archived') AND p_audience <> 'private' AND public.eduos_history_granted(p_district, p_student, p_classification))
    OR (p_classification = 'official_record' AND p_audience <> 'private' AND p_status IN ('published','archived','restricted')
        AND public.eduos_history_emergency(p_district, p_school, p_student))
    OR public.eduos_history_own_after_transition(p_district, p_student, p_author))
  FROM (SELECT public.eduos_history_relation(p_district, p_school, p_student) AS rel) r
$$;

-- ---------- who manages the controls ----------
CREATE FUNCTION eduos_records_office(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal') AND p_school = eduos_ctx_school())
$$;
CREATE FUNCTION eduos_is_student_self(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() = 'pupil' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.student_id = p_student AND l.user_id = eduos_ctx_user()
    AND l.district_id = eduos_ctx_district() AND l.relationship = 'pupil' AND l.status = 'active')
$$;
CREATE FUNCTION eduos_is_linked_guardian(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() = 'parent' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.student_id = p_student AND l.user_id = eduos_ctx_user()
    AND l.district_id = eduos_ctx_district() AND l.relationship IN ('parent','guardian') AND l.status = 'active') AND NOT public.eduos_custody_blocked(p_student, eduos_ctx_user())
$$;

CREATE POLICY scope_read ON student_custody_restrictions AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_records_office(school_id));
CREATE POLICY scope_insert ON student_custody_restrictions AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_records_office(school_id) AND set_by = eduos_ctx_user() AND lifted_at IS NULL));
CREATE POLICY scope_update ON student_custody_restrictions AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_records_office(school_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_records_office(school_id) AND lifted_by = eduos_ctx_user()));

CREATE POLICY scope_read ON student_rights_transitions AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_records_office(school_id)
  OR eduos_is_student_self(student_id) OR eduos_is_linked_guardian(student_id));
CREATE POLICY scope_insert ON student_rights_transitions AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_records_office(school_id) AND recorded_by = eduos_ctx_user() AND reversed_at IS NULL));
CREATE POLICY scope_update ON student_rights_transitions AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_records_office(school_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_records_office(school_id) AND reversed_by = eduos_ctx_user()));

-- Grants: made and revoked by the student (once they hold their rights), for a linked guardian.
CREATE POLICY scope_read ON history_sharing_grants AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR granted_by = eduos_ctx_user()
  OR grantee_user_id = eduos_ctx_user() OR eduos_records_office(school_id));
CREATE POLICY scope_insert ON history_sharing_grants AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (granted_by = eduos_ctx_user()
  AND eduos_is_student_self(student_id) AND eduos_student_holds_rights(student_id) AND revoked_at IS NULL
  AND eduos_history_user_is(district_id, school_id, student_id, grantee_user_id, 'guardian')));
CREATE POLICY scope_update ON history_sharing_grants AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR granted_by = eduos_ctx_user())
  WITH CHECK (eduos_is_table_owner() OR (granted_by = eduos_ctx_user() AND revoked_by = eduos_ctx_user()));

CREATE POLICY scope_read ON history_emergency_access AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR eduos_records_office(school_id));
CREATE POLICY scope_insert ON history_emergency_access AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (user_id = eduos_ctx_user()
  AND role = eduos_ctx_role() AND school_id = eduos_ctx_school() AND closed_at IS NULL AND reviewed_by IS NULL));
CREATE POLICY scope_update ON history_emergency_access AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR coalesce(eduos_ctx_role(), '') = 'superintendent')
  WITH CHECK (eduos_is_table_owner() OR (user_id = eduos_ctx_user() AND reviewed_by IS NULL) OR (coalesce(eduos_ctx_role(), '') = 'superintendent' AND reviewed_by = eduos_ctx_user()));

CREATE POLICY scope_read ON history_access_log AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR user_id = eduos_ctx_user()
  OR eduos_is_student_self(student_id) OR (eduos_is_linked_guardian(student_id) AND NOT eduos_student_holds_rights(student_id))
  OR EXISTS (SELECT 1 FROM students s WHERE s.id = student_id AND eduos_records_office(s.school_id)));
CREATE POLICY scope_insert ON history_access_log AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR user_id = eduos_ctx_user());

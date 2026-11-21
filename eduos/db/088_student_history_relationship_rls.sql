-- Student history and Time Capsule privacy (audit 2026-11-21).
--
-- 086 scoped these seven tables only by district and the session's school:
-- any account at the school (another family's parent, a teacher who doesn't
-- teach the student, a pupil) could read every student's history and
-- capsules, and could write an "official record" into any of them. Who may
-- see what was left to API code. The feature's own rule is that family notes
-- and memories are private by default and that teachers' items go through
-- approval, so it is enforced here, in the database, for every route.
--
-- How someone relates to the student (from the session, checked against an
-- active membership, never taken from the caller):
--   guardian     active parent/guardian link (follows the child to any school)
--   student      the learner's own active pupil link
--   teacher      teaches the student on a roster at that school
--   school_lead  principal or vice principal of that school
--   district     superintendent
-- Anyone else: no access.
--
-- History entries. The author sees their own entries (unless deleted).
-- Others see only approved/published/archived entries, by audience:
--   private    author only
--   student    the student and guardians
--   family     the student and guardians
--   classroom  + the student's teachers and school leads
--   school     + the district office
-- School leads and the district office also see submitted, restricted and
-- pending-deletion items for review, except family memories.
--
-- Who may write what:
--   guardian     family_memory, source guardian, private/student/family
--   student      student_portfolio, source student, private/student/family
--   teacher      teacher_artifact, source teacher, draft/submitted only (a
--                teacher can't publish; approval is a later TC step)
--   school_lead  official_record or teacher_artifact
--   district     official_record
-- A reviewer (school lead or district office) may publish a family memory in
-- a guardian's name only when that guardian is actively linked to the student
-- (TC-02 approval).
-- system_milestone is never written by the runtime role.
--
-- A reviewer publishing a family memory for a guardian (TC-02) can't read it
-- back afterwards, so that insert can't use RETURNING: the app makes the id.
--
-- Time Capsules are private to their owner. Recipients see one only after it
-- is released and only with approved consent. Recipients must be related to
-- the student. Items can only reference entries the owner can see.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['student_history_entries','student_history_entry_revisions','student_history_entry_attachments',
    'student_time_capsules','student_time_capsule_items','student_time_capsule_recipients','student_time_capsule_events'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_district_school_scope', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (district_id = eduos_ctx_district()) WITH CHECK (district_id = eduos_ctx_district())',
      t || '_tenant', t);
  END LOOP;
END $$;

-- How a user relates to a student. For the session user, the session's role
-- and school must match an active membership.
CREATE FUNCTION eduos_history_relation(p_district uuid, p_school uuid, p_student uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_district IS DISTINCT FROM eduos_ctx_district() OR eduos_ctx_user() IS NULL THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM memberships m WHERE m.district_id=p_district AND m.user_id=eduos_ctx_user()
          AND m.role=eduos_ctx_role() AND m.school_id IS NOT DISTINCT FROM eduos_ctx_school() AND m.status='active') THEN NULL
    WHEN NOT EXISTS (SELECT 1 FROM students s WHERE s.id=p_student AND s.district_id=p_district) THEN NULL
    WHEN eduos_ctx_role()='superintendent' THEN 'district'
    WHEN eduos_ctx_role()='parent' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
          AND l.student_id=p_student AND l.user_id=eduos_ctx_user() AND l.status='active' AND l.relationship IN ('parent','guardian')) THEN 'guardian'
    WHEN eduos_ctx_role()='pupil' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district
          AND l.student_id=p_student AND l.user_id=eduos_ctx_user() AND l.status='active' AND l.relationship='pupil') THEN 'student'
    WHEN eduos_ctx_role()='teacher' AND p_school=eduos_ctx_school() AND EXISTS (SELECT 1 FROM teacher_student_rosters r
          WHERE r.district_id=p_district AND r.school_id=p_school AND r.student_id=p_student AND r.teacher_user_id=eduos_ctx_user()) THEN 'teacher'
    WHEN eduos_ctx_role() IN ('principal','vice_principal') AND p_school=eduos_ctx_school() THEN 'school_lead'
  END
$$;

-- Whether another user (a capsule recipient, a named guardian author) has
-- the stated relationship to the student. No session role is involved.
CREATE FUNCTION eduos_history_user_is(p_district uuid, p_school uuid, p_student uuid, p_user uuid, p_kind text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE p_kind
    WHEN 'guardian' THEN EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district AND l.student_id=p_student
      AND l.user_id=p_user AND l.status='active' AND l.relationship IN ('parent','guardian'))
    WHEN 'student' THEN EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id=p_district AND l.student_id=p_student
      AND l.user_id=p_user AND l.status='active' AND l.relationship='pupil')
    WHEN 'teacher' THEN EXISTS (SELECT 1 FROM teacher_student_rosters r WHERE r.district_id=p_district AND r.school_id=p_school
      AND r.student_id=p_student AND r.teacher_user_id=p_user)
    WHEN 'school_staff' THEN EXISTS (SELECT 1 FROM memberships m WHERE m.district_id=p_district AND m.school_id=p_school
      AND m.user_id=p_user AND m.status='active' AND m.role NOT IN ('parent','pupil'))
    ELSE false END
$$;

CREATE FUNCTION eduos_history_entry_visible(p_district uuid, p_school uuid, p_student uuid,
  p_classification text, p_audience text, p_status text, p_author uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT rel IS NOT NULL AND p_status <> 'deleted' AND (
    p_author = eduos_ctx_user()
    OR (p_status IN ('approved','published','archived') AND CASE p_audience
          WHEN 'student'   THEN rel IN ('student','guardian')
          WHEN 'family'    THEN rel IN ('student','guardian')
          WHEN 'classroom' THEN rel IN ('student','guardian','teacher','school_lead')
          WHEN 'school'    THEN rel IN ('student','guardian','teacher','school_lead','district')
          ELSE false END)
    OR (rel IN ('school_lead','district') AND p_classification <> 'family_memory'
        AND p_audience <> 'private' AND p_status IN ('submitted','restricted','pending_deletion')))
  FROM (SELECT public.eduos_history_relation(p_district, p_school, p_student) AS rel) r
$$;

-- Insert rule (and, for the author's own entries, the update rule).
CREATE FUNCTION eduos_history_entry_writable(p_district uuid, p_school uuid, p_student uuid,
  p_classification text, p_audience text, p_status text, p_source text, p_author uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT rel IS NOT NULL AND p_classification <> 'system_milestone' AND (
    (p_author = eduos_ctx_user() AND CASE rel
      WHEN 'guardian' THEN p_classification='family_memory' AND p_source='guardian'
        AND p_audience IN ('private','student','family') AND p_status IN ('draft','published','archived','pending_deletion')
      WHEN 'student' THEN p_classification='student_portfolio' AND p_source='student'
        AND p_audience IN ('private','student','family') AND p_status IN ('draft','published','archived','pending_deletion')
      WHEN 'teacher' THEN p_classification='teacher_artifact' AND p_source='teacher' AND p_status IN ('draft','submitted')
      WHEN 'school_lead' THEN p_classification IN ('official_record','teacher_artifact') AND p_source IN ('school','teacher')
      WHEN 'district' THEN p_classification='official_record' AND p_source='district'
      ELSE false END)
    OR (rel IN ('school_lead','district') AND p_classification='family_memory' AND p_source='guardian' AND p_audience='family'
        AND p_status='published' AND p_author IS DISTINCT FROM eduos_ctx_user()
        AND public.eduos_history_user_is(p_district, p_school, p_student, p_author, 'guardian')))
  FROM (SELECT public.eduos_history_relation(p_district, p_school, p_student) AS rel) r
$$;

-- School leads and the district office manage official records and
-- teacher artifacts (review, restrict, archive); authors manage their own.
CREATE FUNCTION eduos_history_entry_manageable(p_district uuid, p_school uuid, p_student uuid, p_classification text, p_author uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT rel IS NOT NULL AND p_classification <> 'system_milestone' AND (
    p_author = eduos_ctx_user()
    OR (rel IN ('school_lead','district') AND p_classification IN ('official_record','teacher_artifact')))
  FROM (SELECT public.eduos_history_relation(p_district, p_school, p_student) AS rel) r
$$;

-- Child rows (revisions, attachments) follow their entry.
CREATE FUNCTION eduos_history_entry_access(p_entry uuid, p_need text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT CASE p_need
      WHEN 'read' THEN public.eduos_history_entry_visible(e.district_id, e.school_id, e.student_id, e.classification, e.audience, e.status, e.author_user_id)
      WHEN 'manage' THEN public.eduos_history_entry_manageable(e.district_id, e.school_id, e.student_id, e.classification, e.author_user_id)
                         AND public.eduos_history_entry_visible(e.district_id, e.school_id, e.student_id, e.classification, e.audience, e.status, e.author_user_id)
      ELSE false END
    FROM public.student_history_entries e WHERE e.id=p_entry), false)
$$;

-- 'owner': the session user owns the capsule and still relates to the
-- student. 'recipient': released, consent approved, still related. Takes the
-- capsule's own columns, so it also works on a row being inserted.
CREATE FUNCTION eduos_capsule_role(p_district uuid, p_school uuid, p_student uuid, p_capsule uuid, p_owner uuid, p_status text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN public.eduos_history_relation(p_district, p_school, p_student) IS NULL THEN NULL
    WHEN p_owner = eduos_ctx_user() THEN 'owner'
    WHEN p_status='released' AND EXISTS (SELECT 1 FROM public.student_time_capsule_recipients r WHERE r.capsule_id=p_capsule
        AND r.district_id=p_district AND r.recipient_user_id=eduos_ctx_user() AND r.consent_status='approved') THEN 'recipient'
  END
$$;
-- The same, for rows that belong to a capsule (items, recipients, events).
CREATE FUNCTION eduos_capsule_access(p_capsule uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.eduos_capsule_role(c.district_id, c.school_id, c.student_id, c.id, c.owner_user_id, c.status)
    FROM public.student_time_capsules c WHERE c.id=p_capsule
$$;

-- ---- entries ----
CREATE POLICY relationship_read ON student_history_entries AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_entry_visible(district_id, school_id, student_id, classification, audience, status, author_user_id));
CREATE POLICY relationship_insert ON student_history_entries AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_history_entry_writable(district_id, school_id, student_id, classification, audience, status, source_type, author_user_id));
CREATE POLICY relationship_update ON student_history_entries AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (eduos_history_entry_manageable(district_id, school_id, student_id, classification, author_user_id)
         AND eduos_history_entry_visible(district_id, school_id, student_id, classification, audience, status, author_user_id)))
  WITH CHECK (eduos_is_table_owner() OR eduos_history_entry_writable(district_id, school_id, student_id, classification, audience, status, source_type, author_user_id)
         OR (author_user_id IS DISTINCT FROM eduos_ctx_user()
             AND eduos_history_entry_manageable(district_id, school_id, student_id, classification, author_user_id)));

-- ---- revisions (written only by the owner-run trigger) and attachments ----
CREATE POLICY relationship_read ON student_history_entry_revisions AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_entry_access(entry_id, 'read'));
CREATE POLICY relationship_insert ON student_history_entry_revisions AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner());
CREATE POLICY relationship_read ON student_history_entry_attachments AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_entry_access(entry_id, 'read'));
CREATE POLICY relationship_insert ON student_history_entry_attachments AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_history_entry_access(entry_id, 'manage'));

-- ---- capsules ----
CREATE POLICY relationship_read ON student_time_capsules AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_capsule_role(district_id, school_id, student_id, id, owner_user_id, status) IS NOT NULL);
CREATE POLICY relationship_insert ON student_time_capsules AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user() AND status = 'draft'
    AND eduos_history_relation(district_id, school_id, student_id) IN ('guardian','student','teacher','school_lead')));
CREATE POLICY relationship_update ON student_time_capsules AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_capsule_role(district_id, school_id, student_id, id, owner_user_id, status) = 'owner')
  WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user()
    AND eduos_history_relation(district_id, school_id, student_id) IN ('guardian','student','teacher','school_lead')));

CREATE POLICY relationship_read ON student_time_capsule_items AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_capsule_access(capsule_id) IS NOT NULL);
CREATE POLICY relationship_insert ON student_time_capsule_items AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_capsule_access(capsule_id) = 'owner'
    AND EXISTS (SELECT 1 FROM student_time_capsules c WHERE c.id = capsule_id AND c.status = 'draft')
    AND eduos_history_entry_access(entry_id, 'read')));

CREATE POLICY relationship_read ON student_time_capsule_recipients AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_capsule_access(capsule_id) = 'owner' OR recipient_user_id = eduos_ctx_user());
CREATE POLICY relationship_insert ON student_time_capsule_recipients AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_capsule_access(capsule_id) = 'owner'
    AND eduos_history_user_is(district_id, school_id, student_id, recipient_user_id, recipient_type)));
-- Only the recipient answers their own consent request.
CREATE POLICY relationship_update ON student_time_capsule_recipients AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR recipient_user_id = eduos_ctx_user())
  WITH CHECK (eduos_is_table_owner() OR recipient_user_id = eduos_ctx_user());

CREATE POLICY relationship_read ON student_time_capsule_events AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_capsule_access(capsule_id) = 'owner');
CREATE POLICY relationship_insert ON student_time_capsule_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_capsule_access(capsule_id) = 'owner' AND actor_user_id = eduos_ctx_user()));

REVOKE ALL ON FUNCTION eduos_history_relation(uuid,uuid,uuid), eduos_history_user_is(uuid,uuid,uuid,uuid,text),
  eduos_history_entry_visible(uuid,uuid,uuid,text,text,text,uuid), eduos_history_entry_writable(uuid,uuid,uuid,text,text,text,text,uuid),
  eduos_history_entry_manageable(uuid,uuid,uuid,text,uuid), eduos_history_entry_access(uuid,text),
  eduos_capsule_role(uuid,uuid,uuid,uuid,uuid,text), eduos_capsule_access(uuid) FROM PUBLIC;

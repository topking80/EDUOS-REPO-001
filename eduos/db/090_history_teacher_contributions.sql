-- TC-03: teacher contributions to a student's history, reviewed by the school
-- and then accepted (or declined) by the family.
--
--   teacher writes a draft          status draft      (088: rostered teachers only)
--   teacher submits                 status submitted
--   school lead or district office  approve           -> approved (awaiting the family)
--                                   ask for changes   -> draft    (reason required)
--                                   reject            -> restricted (reason required)
--   a guardian of the student       accept            -> published (family can see it)
--                                   decline           -> restricted
--
-- A reviewer can't review their own item. Every step is recorded, permanently,
-- in student_history_entry_decisions. Text only: media waits until private
-- storage and scanning are configured.
--
-- Status is not writable by the runtime role (TC-01 grants), so these steps
-- go through the owner-run functions below, each checking the caller's
-- relationship to the student (088) and the item's current state.

CREATE TABLE student_history_entry_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_relation text NOT NULL CHECK (actor_relation IN ('teacher','school_lead','district','guardian')),
  decision text NOT NULL CHECK (decision IN ('submitted','approved','changes_requested','rejected','accepted','declined')),
  reason_code text CHECK (reason_code IS NULL OR reason_code IN (
    'needs_edits','inaccurate','privacy_concern','other_students_identifiable','not_appropriate',
    'duplicate','not_relevant','family_preference','other')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id, student_id, entry_id)
    REFERENCES student_history_entries(district_id, school_id, student_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, actor_user_id) REFERENCES district_users(district_id, user_id),
  CHECK (decision NOT IN ('changes_requested','rejected','declined') OR reason_code IS NOT NULL)
);
CREATE INDEX student_history_entry_decisions_entry_idx ON student_history_entry_decisions(district_id, entry_id, decided_at);

ALTER TABLE student_history_entry_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_history_entry_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY student_history_entry_decisions_tenant ON student_history_entry_decisions
  USING (district_id = eduos_ctx_district()) WITH CHECK (district_id = eduos_ctx_district());
CREATE POLICY relationship_read ON student_history_entry_decisions AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_entry_access(entry_id, 'read'));
CREATE POLICY relationship_insert ON student_history_entry_decisions AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner());
CREATE TRIGGER student_history_entry_decisions_append_only
  BEFORE UPDATE OR DELETE ON student_history_entry_decisions
  FOR EACH ROW EXECUTE FUNCTION eduos_student_history_reject_immutable_mutation();

-- Visibility (replaces 088's version). Change: an 'approved' item is awaiting
-- the family's decision, so only guardians and reviewers see it; the student
-- (and anyone else the audience covers) sees it once it is published.
CREATE OR REPLACE FUNCTION eduos_history_entry_visible(p_district uuid, p_school uuid, p_student uuid,
  p_classification text, p_audience text, p_status text, p_author uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT rel IS NOT NULL AND p_status <> 'deleted' AND (
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
        AND p_audience <> 'private' AND p_status IN ('submitted','restricted','pending_deletion')))
  FROM (SELECT public.eduos_history_relation(p_district, p_school, p_student) AS rel) r
$$;

-- Teacher submits their own draft (also used right after creating it).
CREATE FUNCTION eduos_history_submit(p_entry uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.student_history_entries%ROWTYPE;
BEGIN
  SELECT * INTO e FROM public.student_history_entries WHERE id=p_entry FOR UPDATE;
  IF NOT FOUND OR e.classification <> 'teacher_artifact' OR e.author_user_id IS DISTINCT FROM eduos_ctx_user()
     OR public.eduos_history_relation(e.district_id, e.school_id, e.student_id) IS DISTINCT FROM 'teacher' THEN
    RAISE EXCEPTION 'history_item_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF e.status <> 'draft' THEN RAISE EXCEPTION 'history_item_not_a_draft' USING ERRCODE = '55000'; END IF;
  UPDATE public.student_history_entries SET status='submitted' WHERE id=p_entry;
  INSERT INTO public.student_history_entry_decisions(district_id,school_id,student_id,entry_id,actor_user_id,actor_relation,decision)
    VALUES (e.district_id, e.school_id, e.student_id, e.id, eduos_ctx_user(), 'teacher', 'submitted');
  RETURN 'submitted';
END $$;

-- School review: approve, request changes or reject, never one's own item.
CREATE FUNCTION eduos_history_review(p_entry uuid, p_decision text, p_reason text, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.student_history_entries%ROWTYPE; rel text; next_status text; recorded text;
BEGIN
  IF p_decision NOT IN ('approve','request_changes','reject') OR (p_decision <> 'approve' AND p_reason IS NULL)
     OR (p_note IS NOT NULL AND length(p_note) > 1000) THEN
    RAISE EXCEPTION 'invalid_review' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO e FROM public.student_history_entries WHERE id=p_entry FOR UPDATE;
  rel := CASE WHEN FOUND THEN public.eduos_history_relation(e.district_id, e.school_id, e.student_id) END;
  IF rel IS NULL OR rel NOT IN ('school_lead','district') OR e.classification <> 'teacher_artifact' THEN
    RAISE EXCEPTION 'history_item_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF e.author_user_id = eduos_ctx_user() THEN RAISE EXCEPTION 'self_review_forbidden' USING ERRCODE = '42501'; END IF;
  IF e.status <> 'submitted' THEN RAISE EXCEPTION 'history_item_not_awaiting_review' USING ERRCODE = '55000'; END IF;
  next_status := CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'request_changes' THEN 'draft' ELSE 'restricted' END;
  recorded := CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'request_changes' THEN 'changes_requested' ELSE 'rejected' END;
  UPDATE public.student_history_entries SET status=next_status WHERE id=p_entry;
  INSERT INTO public.student_history_entry_decisions(district_id,school_id,student_id,entry_id,actor_user_id,actor_relation,decision,reason_code,note)
    VALUES (e.district_id, e.school_id, e.student_id, e.id, eduos_ctx_user(), rel, recorded,
            CASE WHEN p_decision = 'approve' THEN NULL ELSE p_reason END, nullif(btrim(p_note), ''));
  RETURN next_status;
END $$;

-- The family's decision on a school-approved item. The first guardian to
-- decide settles it.
CREATE FUNCTION eduos_history_family_decide(p_entry uuid, p_decision text, p_reason text, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e public.student_history_entries%ROWTYPE; next_status text;
BEGIN
  IF p_decision NOT IN ('accept','decline') OR (p_note IS NOT NULL AND length(p_note) > 1000) THEN
    RAISE EXCEPTION 'invalid_decision' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO e FROM public.student_history_entries WHERE id=p_entry FOR UPDATE;
  IF NOT FOUND OR e.classification <> 'teacher_artifact'
     OR public.eduos_history_relation(e.district_id, e.school_id, e.student_id) IS DISTINCT FROM 'guardian' THEN
    RAISE EXCEPTION 'history_item_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF e.status <> 'approved' THEN RAISE EXCEPTION 'history_item_not_awaiting_family' USING ERRCODE = '55000'; END IF;
  next_status := CASE p_decision WHEN 'accept' THEN 'published' ELSE 'restricted' END;
  UPDATE public.student_history_entries SET status=next_status WHERE id=p_entry;
  INSERT INTO public.student_history_entry_decisions(district_id,school_id,student_id,entry_id,actor_user_id,actor_relation,decision,reason_code,note)
    VALUES (e.district_id, e.school_id, e.student_id, e.id, eduos_ctx_user(), 'guardian',
            CASE p_decision WHEN 'accept' THEN 'accepted' ELSE 'declined' END,
            CASE WHEN p_decision = 'decline' THEN coalesce(p_reason, 'family_preference') END, nullif(btrim(p_note), ''));
  RETURN next_status;
END $$;

REVOKE ALL ON FUNCTION eduos_history_submit(uuid), eduos_history_review(uuid,text,text,text),
  eduos_history_family_decide(uuid,text,text,text) FROM PUBLIC;

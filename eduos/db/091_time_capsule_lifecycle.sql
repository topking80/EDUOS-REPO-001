-- Time Capsule lifecycle: seal, cancel, consent, and release.
--
--   draft      the owner adds history items and recipients, edits the title
--   sealed     contents and recipients are locked (milestone capsules wait here)
--   scheduled  sealed, with a release date
--   released   recipients who accepted can open it
--   cancelled  by the owner, any time before release
--
-- Rules:
-- * Nothing is released to anyone who hasn't accepted. If no recipient has
--   accepted when the date comes, the release is blocked (and logged) and
--   retried on later runs; reaching the date alone never releases it.
-- * A milestone capsule is released by a principal, vice principal or the
--   district office of that student's school confirming the milestone.
-- * Each item is the entry as it was when added (its revision), so later edits
--   don't change a sealed capsule. An entry later withdrawn (restricted,
--   pending deletion, deleted) is withheld when the capsule is opened.
-- * Recipients see a capsule only after release, only with approved consent,
--   and only while still related to the student (088).
--
-- Status columns aren't writable by the runtime role (TC-01 grants); every
-- transition goes through the owner-run functions below.

-- Once sealed, title, message and recipients are fixed.
CREATE POLICY draft_only_update ON student_time_capsules AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR status = 'draft') WITH CHECK (eduos_is_table_owner() OR status = 'draft');
CREATE FUNCTION eduos_capsule_is_draft(p_capsule uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public.student_time_capsules c WHERE c.id = p_capsule AND c.status = 'draft')
$$;
CREATE POLICY draft_only_insert ON student_time_capsule_recipients AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR eduos_capsule_is_draft(capsule_id));

CREATE FUNCTION eduos_capsule_event(c public.student_time_capsules, p_actor uuid, p_type text, p_outcome text, p_reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.student_time_capsule_events(district_id,school_id,student_id,capsule_id,actor_user_id,event_type,outcome,reason_code)
  VALUES (c.district_id, c.school_id, c.student_id, c.id, p_actor, p_type, p_outcome, p_reason)
$$;

-- Release one locked capsule if anyone has accepted; otherwise log the block
-- (at most once a day per capsule, so the sweep doesn't flood the log).
CREATE FUNCTION eduos_capsule_try_release(p_capsule uuid, p_actor uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.student_time_capsules%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.student_time_capsules WHERE id = p_capsule FOR UPDATE;
  IF NOT FOUND OR c.status NOT IN ('sealed','scheduled') THEN RETURN 'not_releasable'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.student_time_capsule_recipients r WHERE r.capsule_id = c.id
                  AND r.district_id = c.district_id AND r.consent_status = 'approved'
                  AND public.eduos_history_user_is(c.district_id, c.school_id, c.student_id, r.recipient_user_id, r.recipient_type)) THEN
    IF NOT EXISTS (SELECT 1 FROM public.student_time_capsule_events e WHERE e.capsule_id = c.id AND e.event_type = 'release_blocked'
                    AND e.occurred_at > now() - interval '1 day') THEN
      PERFORM public.eduos_capsule_event(c, p_actor, 'release_blocked', 'denied', 'no_consenting_recipient');
    END IF;
    RETURN 'blocked';
  END IF;
  UPDATE public.student_time_capsules SET status = 'released', released_at = now(), updated_at = now() WHERE id = c.id;
  PERFORM public.eduos_capsule_event(c, p_actor, 'released', 'success', NULL);
  RETURN 'released';
END $$;

CREATE FUNCTION eduos_capsule_seal(p_capsule uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.student_time_capsules%ROWTYPE; next_status text;
BEGIN
  SELECT * INTO c FROM public.student_time_capsules WHERE id = p_capsule FOR UPDATE;
  IF NOT FOUND OR c.owner_user_id IS DISTINCT FROM eduos_ctx_user()
     OR public.eduos_history_relation(c.district_id, c.school_id, c.student_id) IS NULL THEN
    RAISE EXCEPTION 'capsule_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF c.status <> 'draft' THEN RAISE EXCEPTION 'capsule_not_a_draft' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.student_time_capsule_items i WHERE i.capsule_id = c.id) THEN
    RAISE EXCEPTION 'capsule_needs_an_item' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.student_time_capsule_recipients r WHERE r.capsule_id = c.id) THEN
    RAISE EXCEPTION 'capsule_needs_a_recipient' USING ERRCODE = '55000'; END IF;
  IF c.release_kind = 'scheduled' AND c.release_at <= now() THEN
    RAISE EXCEPTION 'capsule_release_date_passed' USING ERRCODE = '55000'; END IF;
  next_status := CASE c.release_kind WHEN 'scheduled' THEN 'scheduled' ELSE 'sealed' END;
  UPDATE public.student_time_capsules SET status = next_status, sealed_at = now(), updated_at = now() WHERE id = c.id;
  PERFORM public.eduos_capsule_event(c, eduos_ctx_user(), 'sealed', 'success', NULL);
  IF next_status = 'scheduled' THEN PERFORM public.eduos_capsule_event(c, eduos_ctx_user(), 'scheduled', 'success', NULL); END IF;
  RETURN next_status;
END $$;

CREATE FUNCTION eduos_capsule_cancel(p_capsule uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.student_time_capsules%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.student_time_capsules WHERE id = p_capsule FOR UPDATE;
  IF NOT FOUND OR c.owner_user_id IS DISTINCT FROM eduos_ctx_user()
     OR public.eduos_history_relation(c.district_id, c.school_id, c.student_id) IS NULL THEN
    RAISE EXCEPTION 'capsule_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF c.status NOT IN ('draft','sealed','scheduled') THEN RAISE EXCEPTION 'capsule_cannot_be_cancelled' USING ERRCODE = '55000'; END IF;
  UPDATE public.student_time_capsules SET status = 'cancelled', cancelled_at = now(), updated_at = now() WHERE id = c.id;
  PERFORM public.eduos_capsule_event(c, eduos_ctx_user(), 'cancelled', 'success', NULL);
  RETURN 'cancelled';
END $$;

-- A school lead or the district office confirms a milestone was reached.
CREATE FUNCTION eduos_capsule_release_milestone(p_capsule uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c public.student_time_capsules%ROWTYPE; outcome text;
BEGIN
  SELECT * INTO c FROM public.student_time_capsules WHERE id = p_capsule;
  -- coalesce: no relationship at all is NULL, and NULL NOT IN (...) is not true.
  IF NOT FOUND OR coalesce(public.eduos_history_relation(c.district_id, c.school_id, c.student_id), '') NOT IN ('school_lead','district') THEN
    RAISE EXCEPTION 'capsule_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF c.release_kind <> 'milestone' OR c.status <> 'sealed' THEN RAISE EXCEPTION 'capsule_not_awaiting_milestone' USING ERRCODE = '55000'; END IF;
  PERFORM public.eduos_capsule_event(c, eduos_ctx_user(), 'release_attempted', 'success', 'milestone_confirmed');
  outcome := public.eduos_capsule_try_release(c.id, eduos_ctx_user());
  IF outcome = 'blocked' THEN RAISE EXCEPTION 'capsule_has_no_consenting_recipient' USING ERRCODE = '55000'; END IF;
  RETURN outcome;
END $$;

-- The release sweep: every district's scheduled capsules whose date has come.
-- Safe to run concurrently (SKIP LOCKED) and repeatedly (released capsules are
-- no longer 'scheduled'). Restores the caller's tenant setting.
CREATE FUNCTION eduos_capsule_release_due(p_limit integer DEFAULT 100)
RETURNS TABLE(district_id uuid, capsule_id uuid, outcome text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid; c record; prior text := current_setting('app.district_id', true); n integer := 0;
BEGIN
  FOR d IN SELECT id FROM public.districts LOOP
    PERFORM set_config('app.district_id', d::text, true);
    FOR c IN SELECT x.id FROM public.student_time_capsules x
              WHERE x.district_id = d AND x.status = 'scheduled' AND x.release_at <= now()
              ORDER BY x.release_at, x.id FOR UPDATE SKIP LOCKED LIMIT greatest(1, least(p_limit, 1000)) - n LOOP
      district_id := d; capsule_id := c.id; outcome := public.eduos_capsule_try_release(c.id, NULL);
      n := n + 1;
      RETURN NEXT;
    END LOOP;
    EXIT WHEN n >= p_limit;
  END LOOP;
  PERFORM set_config('app.district_id', coalesce(prior, ''), true);
END $$;

-- What's inside, for the owner (any time) or an accepting recipient (after
-- release). Items are the entry revision saved when added; withdrawn entries
-- are withheld.
CREATE FUNCTION eduos_capsule_contents(p_capsule uuid)
RETURNS TABLE(item_position integer, entry_id uuid, withheld boolean, entry_type text, classification text,
  title text, body text, occurred_at timestamptz, added_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.position, i.entry_id, e.status IN ('restricted','pending_deletion','deleted') AS withheld,
         CASE WHEN e.status IN ('restricted','pending_deletion','deleted') THEN NULL ELSE r.snapshot->>'entryType' END,
         CASE WHEN e.status IN ('restricted','pending_deletion','deleted') THEN NULL ELSE r.snapshot->>'classification' END,
         CASE WHEN e.status IN ('restricted','pending_deletion','deleted') THEN NULL ELSE r.snapshot->>'title' END,
         CASE WHEN e.status IN ('restricted','pending_deletion','deleted') THEN NULL ELSE r.snapshot->>'body' END,
         CASE WHEN e.status IN ('restricted','pending_deletion','deleted') THEN NULL ELSE (r.snapshot->>'occurredAt')::timestamptz END,
         i.created_at
    FROM public.student_time_capsule_items i
    JOIN public.student_history_entries e ON e.id = i.entry_id AND e.district_id = i.district_id
    JOIN public.student_history_entry_revisions r ON r.district_id = i.district_id AND r.entry_id = i.entry_id AND r.revision_no = i.entry_revision_no
   WHERE i.capsule_id = p_capsule AND i.district_id = eduos_ctx_district()
     AND public.eduos_capsule_access(p_capsule) IN ('owner','recipient')
   ORDER BY i.position
$$;

-- Capsules I've been invited to receive: who it's from and when it opens,
-- never what's inside, until it is released to me.
CREATE FUNCTION eduos_capsule_invitations()
RETURNS TABLE(capsule_id uuid, student_id uuid, student_name text, from_name text, status text, release_kind text,
  release_at timestamptz, milestone_key text, consent_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.student_id, s.display_name, u.display_name, c.status, c.release_kind, c.release_at, c.milestone_key, r.consent_status
    FROM public.student_time_capsule_recipients r
    JOIN public.student_time_capsules c ON c.id = r.capsule_id AND c.district_id = r.district_id
    JOIN public.students s ON s.id = c.student_id AND s.district_id = c.district_id
    JOIN public.users u ON u.id = c.owner_user_id
   WHERE r.district_id = eduos_ctx_district() AND r.recipient_user_id = eduos_ctx_user()
     AND c.status IN ('sealed','scheduled','released')
     AND public.eduos_history_relation(c.district_id, c.school_id, c.student_id) IS NOT NULL
   ORDER BY coalesce(c.release_at, c.sealed_at)
$$;

-- People the owner may name as recipients: the student, their guardians and
-- teachers. Only for someone related to the student.
CREATE FUNCTION eduos_capsule_recipient_options(p_student uuid)
RETURNS TABLE(user_id uuid, display_name text, recipient_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH s AS (SELECT st.id, st.district_id, st.school_id FROM public.students st
              WHERE st.id = p_student AND st.district_id = eduos_ctx_district()
                AND public.eduos_history_relation(st.district_id, st.school_id, st.id) IS NOT NULL)
  SELECT u.id, u.display_name, CASE l.relationship WHEN 'pupil' THEN 'student' ELSE 'guardian' END
    FROM s JOIN public.student_user_links l ON l.student_id = s.id AND l.district_id = s.district_id AND l.status = 'active'
                                           AND l.relationship IN ('pupil','parent','guardian')
           JOIN public.users u ON u.id = l.user_id
  UNION
  SELECT u.id, u.display_name, 'teacher'
    FROM s JOIN public.teacher_student_rosters r ON r.student_id = s.id AND r.district_id = s.district_id AND r.school_id = s.school_id
           JOIN public.users u ON u.id = r.teacher_user_id
  ORDER BY 3, 2
$$;

-- Milestone capsules waiting for a school to confirm the milestone: for that
-- school's leads (or the district office). Who it's for, which milestone, and
-- whether anyone has accepted; never the title, message or contents.
CREATE FUNCTION eduos_capsule_milestones_pending()
RETURNS TABLE(capsule_id uuid, student_id uuid, student_name text, from_name text, milestone_key text, sealed_at timestamptz, accepted integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.student_id, s.display_name, u.display_name, c.milestone_key, c.sealed_at,
         (SELECT count(*)::int FROM public.student_time_capsule_recipients r WHERE r.capsule_id = c.id AND r.consent_status = 'approved')
    FROM public.student_time_capsules c
    JOIN public.students s ON s.id = c.student_id AND s.district_id = c.district_id
    JOIN public.users u ON u.id = c.owner_user_id
   WHERE c.district_id = eduos_ctx_district() AND c.release_kind = 'milestone' AND c.status = 'sealed'
     AND public.eduos_history_relation(c.district_id, c.school_id, c.student_id) IN ('school_lead','district')
   ORDER BY s.display_name, c.sealed_at
$$;

REVOKE ALL ON FUNCTION eduos_capsule_milestones_pending() FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_capsule_is_draft(uuid), eduos_capsule_event(public.student_time_capsules, uuid, text, text, text),
  eduos_capsule_try_release(uuid, uuid), eduos_capsule_seal(uuid), eduos_capsule_cancel(uuid), eduos_capsule_release_milestone(uuid),
  eduos_capsule_release_due(integer), eduos_capsule_contents(uuid), eduos_capsule_invitations(), eduos_capsule_recipient_options(uuid) FROM PUBLIC;

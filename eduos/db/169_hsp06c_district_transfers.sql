-- HSP-06 part 3: school districts in the learner transfer workflow (design:
-- docs/product/hsp-06c-district-transfers.md). Extends migration 165.
--
--   * A district takes part only after its superintendent turns transfers on.
--   * Sending: the records office (the student's principal, a vice principal
--     acting as one, or the superintendent) prepares a field-selective
--     snapshot; a guardian linked to the student in the district, with no
--     open custody restriction, releases it and gets the code. The district's
--     records stay where they are.
--   * Receiving: the records office previews and accepts onto an EXISTING
--     student it chooses (never matched or created automatically; enroll the
--     child first), or declines.
--   * District-to-district moves keep using the signed history transfer (TC-06).

-- ---------------------------------------------------------------- settings
CREATE TABLE district_transfer_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  enabled boolean NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE district_transfer_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_transfer_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY district_isolation ON district_transfer_settings USING (eduos_is_table_owner() OR district_id = eduos_ctx_district())
  WITH CHECK (eduos_is_table_owner() OR district_id = eduos_ctx_district());
CREATE POLICY superintendent_sets ON district_transfer_settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ctx_role() = 'superintendent' AND changed_by = eduos_ctx_user() END);
CREATE POLICY superintendent_changes ON district_transfer_settings AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ctx_role() = 'superintendent' END);

-- ---------------------------------------------------------------- tables
ALTER TABLE learner_transfers DROP CONSTRAINT learner_transfers_source_kind_check;
ALTER TABLE learner_transfers ADD CONSTRAINT learner_transfers_source_kind_check CHECK (source_kind IN ('homeschool_family','private_school','district'));
ALTER TABLE learner_transfers DROP CONSTRAINT learner_transfers_receiver_kind_check;
ALTER TABLE learner_transfers ADD CONSTRAINT learner_transfers_receiver_kind_check CHECK (receiver_kind IN ('homeschool_family','private_school','district'));
ALTER FUNCTION eduos_transfer_preview(text) VOLATILE;
-- A transfer withdrawn before anyone released it was never released (fixes 165's check).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'learner_transfers'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%awaiting_release%released_at IS NULL%';
  EXECUTE format('ALTER TABLE learner_transfers DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE learner_transfers ADD CONSTRAINT learner_transfers_released CHECK ((status <> 'awaiting_release' OR released_at IS NULL) AND (status IN ('awaiting_release','revoked') OR released_at IS NOT NULL));
ALTER TABLE learner_transfers ADD CONSTRAINT learner_transfers_not_district_to_district CHECK (NOT (source_kind = 'district' AND receiver_kind = 'district'));

ALTER TABLE transferred_records ADD COLUMN district_id uuid, ADD COLUMN student_id uuid;
ALTER TABLE transferred_records ADD CONSTRAINT transferred_records_student_fk FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id);
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'transferred_records'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ps_learner_id IS NULL%family_id IS NULL%';
  EXECUTE format('ALTER TABLE transferred_records DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE transferred_records ADD CONSTRAINT transferred_records_one_receiver CHECK (
  (family_id IS NULL) = (family_learner_id IS NULL) AND (school_id IS NULL) = (ps_learner_id IS NULL) AND (district_id IS NULL) = (student_id IS NULL)
  AND num_nonnulls(family_id, school_id, district_id) = 1);
CREATE INDEX transferred_records_district ON transferred_records(district_id, student_id) WHERE district_id IS NOT NULL;
CREATE OR REPLACE FUNCTION eduos_transferred_records_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.voided_at IS NOT NULL OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.title IS DISTINCT FROM OLD.title OR NEW.detail IS DISTINCT FROM OLD.detail
     OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id OR NEW.family_learner_id IS DISTINCT FROM OLD.family_learner_id
     OR NEW.ps_learner_id IS DISTINCT FROM OLD.ps_learner_id OR NEW.student_id IS DISTINCT FROM OLD.student_id THEN
    RAISE EXCEPTION 'transferred records can only be voided' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE transferred_records DROP CONSTRAINT transferred_records_kind_check;
ALTER TABLE transferred_records ADD CONSTRAINT transferred_records_kind_check CHECK (kind IN ('course','attendance_year','work','report_card','enrollment','final_grade'));

-- ---------------------------------------------------------------- helpers
-- The session is this student's records office: the superintendent, or the
-- principal (or a vice principal acting as one) of the student's school.
CREATE FUNCTION eduos_district_records_office(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_district() IS NOT NULL AND eduos_ctx_user() IS NOT NULL AND EXISTS (SELECT 1 FROM students s WHERE s.id = p_student AND s.district_id = eduos_ctx_district()
    AND (eduos_ctx_role() = 'superintendent' OR (eduos_ctx_role() = 'principal' AND s.school_id = eduos_ctx_school())))
$$;
-- A user is a guardian of a student in this district, with no open custody
-- restriction. District tables are scoped by app.district_id, so when asked
-- from outside the district (a family receiving), it looks inside that one
-- district for this one check and then restores the context.
CREATE FUNCTION eduos_district_guardian(p_district uuid, p_student uuid, p_user uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev text := current_setting('app.district_id', true); ok boolean;
BEGIN
  IF p_district IS NULL OR p_student IS NULL OR p_user IS NULL THEN RETURN false; END IF;
  PERFORM set_config('app.district_id', p_district::text, true);
  SELECT EXISTS (SELECT 1 FROM student_user_links l JOIN memberships m ON m.district_id = l.district_id AND m.user_id = l.user_id AND m.status = 'active'
       WHERE l.district_id = p_district AND l.student_id = p_student AND l.user_id = p_user AND l.status = 'active' AND l.relationship IN ('parent','guardian'))
     AND NOT EXISTS (SELECT 1 FROM student_custody_restrictions r WHERE r.district_id = p_district AND r.student_id = p_student AND r.restricted_user_id = p_user AND r.lifted_at IS NULL
       AND (r.ends_on IS NULL OR r.ends_on >= current_date))
    INTO ok;
  PERFORM set_config('app.district_id', coalesce(prev, ''), true);
  RETURN ok;
END $$;
CREATE FUNCTION eduos_district_transfers_on(p_district uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT coalesce((SELECT enabled FROM district_transfer_settings WHERE district_id = p_district), false) $$;

CREATE OR REPLACE FUNCTION eduos_transfer_side(p_source_kind text, p_source_tenant uuid, p_source_learner uuid, p_receiver_kind text, p_receiver_tenant uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_source_kind = 'homeschool_family' AND p_source_tenant = eduos_ctx_family() AND eduos_family_authority(p_source_learner) = 'full' THEN 'sender'
    WHEN p_source_kind = 'private_school' AND p_source_tenant = eduos_ctx_private_school()
      AND (eduos_ps_has(ARRAY['school_admin','registrar']) OR eduos_ps_guards(p_source_learner)) THEN 'sender'
    WHEN p_source_kind = 'district' AND p_source_tenant = eduos_ctx_district()
      AND (eduos_district_records_office(p_source_learner) OR (eduos_ctx_role() = 'parent' AND eduos_district_guardian(p_source_tenant, p_source_learner, eduos_ctx_user()))) THEN 'sender'
    WHEN p_receiver_kind = 'homeschool_family' AND p_receiver_tenant = eduos_ctx_family() AND eduos_family_role() = 'owner' THEN 'receiver'
    WHEN p_receiver_kind = 'private_school' AND p_receiver_tenant = eduos_ctx_private_school() AND eduos_ps_has(ARRAY['school_admin','registrar']) THEN 'receiver'
    WHEN p_receiver_kind = 'district' AND p_receiver_tenant = eduos_ctx_district() AND eduos_ctx_role() IN ('principal','superintendent') THEN 'receiver'
  END
$$;
-- The receiving district's view is narrowed further to the student's records office once accepted.
CREATE POLICY district_receiver_scope ON learner_transfers AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true
              WHEN receiver_kind = 'district' AND receiver_tenant = eduos_ctx_district() AND source_tenant IS DISTINCT FROM eduos_ctx_district()
                THEN receiver_learner IS NULL OR eduos_district_records_office(receiver_learner)
              ELSE true END);

CREATE OR REPLACE FUNCTION eduos_transfer_audit(p_action text, p_id uuid, p_detail text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF eduos_ctx_family() IS NOT NULL THEN
    INSERT INTO family_audit_events(family_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
      VALUES (eduos_ctx_family(), eduos_ctx_user(), coalesce(eduos_family_role(), 'unknown'), p_action, 'learner_transfer', p_id::text, p_detail);
  ELSIF eduos_ctx_private_school() IS NOT NULL THEN
    INSERT INTO private_school_audit_events(school_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
      VALUES (eduos_ctx_private_school(), eduos_ctx_user(), coalesce((eduos_ps_roles())[1], 'unknown'), p_action, 'learner_transfer', p_id::text, p_detail);
  ELSIF eduos_ctx_district() IS NOT NULL THEN
    INSERT INTO audit_events(district_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
      VALUES (eduos_ctx_district(), eduos_ctx_user(), eduos_ctx_membership_role(), p_action, 'learner_transfer', p_id::text, left(p_detail, 1000));
  END IF;
END $$;

-- ---------------------------------------------------------------- prepare
CREATE OR REPLACE FUNCTION eduos_transfer_prepare(p_learner uuid, p_purpose text, p_sections text[], p_note text, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE fam uuid := eduos_ctx_family(); sch uuid := eduos_ctx_private_school(); dis uuid := eduos_ctx_district(); v_kind text; label text; prov text; learner jsonb; items jsonb := '[]'::jsonb;
  snap jsonb; tid uuid; allowed text[]; st text; s record;
BEGIN
  IF p_sections IS NULL OR cardinality(p_sections) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'choose_what_to_send'); END IF;
  IF fam IS NOT NULL THEN
    v_kind := 'homeschool_family'; allowed := ARRAY['courses','attendance','work'];
    IF eduos_family_authority(p_learner) IS DISTINCT FROM 'full' THEN RETURN jsonb_build_object('ok', false, 'error', 'full_authority_required'); END IF;
    SELECT jsonb_build_object('displayName', l.display_name, 'gradeBand', l.grade_band) INTO learner FROM family_learners l WHERE l.id = p_learner AND l.family_id = fam;
    IF learner IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'learner_not_found'); END IF;
    SELECT display_name INTO label FROM homeschool_families WHERE id = fam;
    prov := 'Entered by the ' || label || ' homeschool family. Not verified by EduOS or any agency.';
    IF p_token_hash IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'token_required'); END IF;
    st := 'ready';
  ELSIF sch IS NOT NULL THEN
    v_kind := 'private_school'; allowed := ARRAY['enrollment','report_cards','attendance'];
    IF NOT eduos_ps_has(ARRAY['school_admin','registrar']) THEN RETURN jsonb_build_object('ok', false, 'error', 'registrar_or_admin_only'); END IF;
    IF NOT eduos_ps_active() THEN RETURN jsonb_build_object('ok', false, 'error', 'school_not_verified'); END IF;
    SELECT jsonb_build_object('displayName', l.display_name, 'gradeLevel', l.grade_level) INTO learner FROM private_school_learners l WHERE l.id = p_learner AND l.school_id = sch;
    IF learner IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'learner_not_found'); END IF;
    SELECT display_name, 'Issued by ' || display_name || ' (' || legal_name || '), a private school verified by the platform on ' || to_char(verified_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
      || '. Not an accreditation or a government record.' INTO label, prov FROM private_schools WHERE id = sch;
    st := 'awaiting_release';
  ELSIF dis IS NOT NULL THEN
    v_kind := 'district'; allowed := ARRAY['enrollment','final_grades','attendance'];
    IF NOT eduos_district_records_office(p_learner) THEN RETURN jsonb_build_object('ok', false, 'error', 'records_office_only'); END IF;
    IF NOT eduos_district_transfers_on(dis) THEN RETURN jsonb_build_object('ok', false, 'error', 'district_transfers_off'); END IF;
    SELECT jsonb_build_object('displayName', stu.display_name, 'gradeLevel', stu.grade_level), scl.name || ', ' || dd.name,
        'Issued by ' || scl.name || ' in ' || dd.name || ', a school district on EduOS. Not a certified transcript; ask the district for one.'
      INTO learner, label, prov FROM students stu JOIN schools scl ON scl.id = stu.school_id JOIN districts dd ON dd.id = stu.district_id WHERE stu.id = p_learner AND stu.district_id = dis;
    st := 'awaiting_release';
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'no_context');
  END IF;
  IF NOT (p_sections <@ allowed) THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_sections', 'allowed', to_jsonb(allowed)); END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('enrollment','records_request','return_to_homeschool','other') THEN RETURN jsonb_build_object('ok', false, 'error', 'invalid_purpose'); END IF;

  IF v_kind = 'homeschool_family' THEN
    IF 'courses' = ANY(p_sections) THEN
      FOR s IN SELECT * FROM family_courses WHERE family_id = fam AND learner_id = p_learner AND status <> 'archived' ORDER BY school_year, title LOOP
        items := items || jsonb_build_object('kind', 'course', 'title', s.title || ' (' || s.school_year || ')', 'detail', jsonb_strip_nulls(jsonb_build_object('subject', s.subject,
          'schoolYear', s.school_year, 'status', s.status, 'finalGrade', s.final_grade, 'credits', s.credits, 'completedOn', s.completed_on)));
      END LOOP;
    END IF;
    IF 'attendance' = ANY(p_sections) THEN
      FOR s IN SELECT eduos_school_year(day) AS sy, count(DISTINCT day) FILTER (WHERE kind <> 'absent' AND minutes > 0) AS days, count(DISTINCT day) FILTER (WHERE kind = 'absent') AS absent,
          coalesce(sum(minutes), 0) AS minutes FROM family_attendance WHERE family_id = fam AND learner_id = p_learner AND voided_at IS NULL GROUP BY 1 ORDER BY 1 LOOP
        items := items || jsonb_build_object('kind', 'attendance_year', 'title', 'Attendance ' || s.sy, 'detail', jsonb_build_object('schoolYear', s.sy, 'instructionalDays', s.days,
          'absentDays', s.absent, 'minutes', s.minutes));
      END LOOP;
    END IF;
    IF 'work' = ANY(p_sections) THEN
      FOR s IN SELECT * FROM family_work WHERE family_id = fam AND learner_id = p_learner AND voided_at IS NULL ORDER BY done_on, title LIMIT 500 LOOP
        items := items || jsonb_build_object('kind', 'work', 'title', s.title, 'detail', jsonb_strip_nulls(jsonb_build_object('kind', s.kind, 'doneOn', s.done_on, 'score', s.score,
          'maxScore', s.max_score, 'gradeLabel', s.grade_label, 'provenance', s.provenance, 'source', s.source)));
      END LOOP;
    END IF;
  ELSIF v_kind = 'private_school' THEN
    IF 'enrollment' = ANY(p_sections) THEN
      SELECT jsonb_build_object('kind', 'enrollment', 'title', 'Enrollment at ' || label, 'detail', jsonb_strip_nulls(jsonb_build_object('enrolledOn', enrolled_on, 'withdrawnOn', withdrawn_on,
        'gradeLevel', grade_level, 'status', enrollment_status))) INTO snap FROM private_school_learners WHERE id = p_learner;
      items := items || snap;
    END IF;
    IF 'report_cards' = ANY(p_sections) THEN
      FOR s IN SELECT c.* FROM ps_report_cards c WHERE c.school_id = sch AND c.learner_id = p_learner AND c.status = 'published' ORDER BY c.school_year, c.term LOOP
        items := items || jsonb_build_object('kind', 'report_card', 'title', 'Report card ' || s.school_year || ' ' || s.term, 'detail', jsonb_strip_nulls(jsonb_build_object(
          'schoolYear', s.school_year, 'term', s.term, 'comment', s.comment, 'publishedOn', (s.published_at AT TIME ZONE 'UTC')::date,
          'lines', (SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('class', k.name, 'grade', x.grade, 'comment', x.comment)) ORDER BY k.name), '[]')
                      FROM ps_report_card_lines x JOIN ps_classes k ON k.id = x.class_id WHERE x.report_card_id = s.id))));
      END LOOP;
    END IF;
    IF 'attendance' = ANY(p_sections) THEN
      FOR s IN SELECT eduos_school_year(day) AS sy, count(*) FILTER (WHERE status = 'present') AS present, count(*) FILTER (WHERE status = 'tardy') AS tardy,
          count(*) FILTER (WHERE status = 'absent') AS absent, count(*) FILTER (WHERE status = 'excused') AS excused
          FROM ps_attendance WHERE school_id = sch AND learner_id = p_learner AND voided_at IS NULL GROUP BY 1 ORDER BY 1 LOOP
        items := items || jsonb_build_object('kind', 'attendance_year', 'title', 'Attendance ' || s.sy, 'detail', jsonb_build_object('schoolYear', s.sy, 'present', s.present,
          'tardy', s.tardy, 'absent', s.absent, 'excused', s.excused, 'unit', 'class or daily marks'));
      END LOOP;
    END IF;
  ELSE
    IF 'enrollment' = ANY(p_sections) THEN
      SELECT jsonb_build_object('kind', 'enrollment', 'title', 'Enrollment at ' || label, 'detail', jsonb_strip_nulls(jsonb_build_object('gradeLevel', stu.grade_level, 'school', scl.name,
        'enrolledSince', (stu.created_at AT TIME ZONE 'UTC')::date))) INTO snap FROM students stu JOIN schools scl ON scl.id = stu.school_id WHERE stu.id = p_learner;
      items := items || snap;
    END IF;
    IF 'final_grades' = ANY(p_sections) THEN
      -- The current posted grade per course (a corrected grade replaces the one it supersedes).
      FOR s IN SELECT k.title, k.subject, k.term, g.letter, g.percent, (g.posted_at AT TIME ZONE 'UTC')::date AS posted_on
          FROM course_final_grades g JOIN courses k ON k.id = g.course_id
         WHERE g.student_id = p_learner AND g.district_id = dis AND NOT EXISTS (SELECT 1 FROM course_final_grades n WHERE n.supersedes = g.id)
         ORDER BY g.posted_at, k.title LOOP
        items := items || jsonb_build_object('kind', 'final_grade', 'title', s.title || ' (' || s.term || ')', 'detail', jsonb_build_object('subject', s.subject, 'term', s.term,
          'letter', s.letter, 'percent', s.percent, 'postedOn', s.posted_on));
      END LOOP;
    END IF;
    IF 'attendance' = ANY(p_sections) THEN
      FOR s IN SELECT sy, jsonb_object_agg(status, n) AS counts FROM (SELECT eduos_school_year(event_date) AS sy, status, count(*) AS n
          FROM attendance_events WHERE district_id = dis AND student_id = p_learner GROUP BY 1, 2) a GROUP BY sy ORDER BY sy LOOP
        items := items || jsonb_build_object('kind', 'attendance_year', 'title', 'Attendance ' || s.sy, 'detail', jsonb_build_object('schoolYear', s.sy, 'counts', s.counts));
      END LOOP;
    END IF;
  END IF;

  snap := jsonb_build_object('learner', learner, 'source', jsonb_build_object('kind', v_kind, 'name', label), 'provenance', prov, 'purpose', p_purpose,
    'sections', to_jsonb(p_sections), 'items', items, 'preparedAt', now());
  INSERT INTO learner_transfers(source_kind, source_tenant, source_learner, source_label, purpose, note, sections, snapshot, sha256, status, prepared_by,
      released_by, released_at, token_hash, expires_at)
    VALUES (v_kind, coalesce(fam, sch, dis), p_learner, label, p_purpose, nullif(btrim(p_note), ''), p_sections, snap, encode(sha256(convert_to(snap::text, 'UTF8')), 'hex'), st, eduos_ctx_user(),
      CASE WHEN st = 'ready' THEN eduos_ctx_user() END, CASE WHEN st = 'ready' THEN now() END, CASE WHEN st = 'ready' THEN p_token_hash END, CASE WHEN st = 'ready' THEN now() + interval '14 days' END)
    RETURNING id INTO tid;
  PERFORM eduos_transfer_audit('prepare', tid, array_to_string(p_sections, ',') || ';items=' || jsonb_array_length(items) || ';purpose=' || p_purpose);
  RETURN jsonb_build_object('ok', true, 'id', tid, 'status', st, 'items', jsonb_array_length(items));
END $$;

-- A guardian releases a school's or district's transfer and gets the code.
CREATE OR REPLACE FUNCTION eduos_transfer_release(p_id uuid, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t learner_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM learner_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT (
       (t.source_kind = 'private_school' AND t.source_tenant = eduos_ctx_private_school() AND eduos_ps_guards(t.source_learner))
    OR (t.source_kind = 'district' AND t.source_tenant = eduos_ctx_district() AND eduos_ctx_role() = 'parent' AND eduos_district_guardian(t.source_tenant, t.source_learner, eduos_ctx_user()))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transfer_not_found'); END IF;
  IF t.status <> 'awaiting_release' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_awaiting_release'); END IF;
  IF p_token_hash IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'token_required'); END IF;
  UPDATE learner_transfers SET status = 'ready', released_by = eduos_ctx_user(), released_at = now(), token_hash = p_token_hash, expires_at = now() + interval '14 days' WHERE id = p_id;
  PERFORM eduos_transfer_audit('release', p_id, NULL);
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'expiresAt', now() + interval '14 days');
END $$;

-- ---------------------------------------------------------------- receive
CREATE OR REPLACE FUNCTION eduos_transfer_receivable(t learner_transfers) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF t.id IS NULL OR t.status <> 'ready' OR t.expires_at < now() THEN RETURN 'transfer_code_not_valid'; END IF;
  IF coalesce(eduos_ctx_family(), eduos_ctx_private_school(), eduos_ctx_district()) = t.source_tenant THEN RETURN 'same_family_or_school'; END IF;
  IF eduos_ctx_family() IS NOT NULL THEN
    IF eduos_family_role() IS DISTINCT FROM 'owner' THEN RETURN 'family_owner_only'; END IF;
    -- A school's or district's records go to a family only when the person receiving is that learner's guardian there.
    IF t.source_kind = 'private_school' AND NOT EXISTS (SELECT 1 FROM private_school_guardian_links g WHERE g.school_id = t.source_tenant AND g.learner_id = t.source_learner
        AND g.user_id = eduos_ctx_user() AND g.revoked_at IS NULL AND g.authority = 'full') THEN RETURN 'guardian_of_this_learner_only'; END IF;
    IF t.source_kind = 'district' AND NOT eduos_district_guardian(t.source_tenant, t.source_learner, eduos_ctx_user()) THEN RETURN 'guardian_of_this_learner_only'; END IF;
    RETURN NULL;
  ELSIF eduos_ctx_private_school() IS NOT NULL THEN
    IF NOT eduos_ps_has(ARRAY['school_admin','registrar']) THEN RETURN 'registrar_or_admin_only'; END IF;
    IF NOT eduos_ps_active() THEN RETURN 'school_not_verified'; END IF;
    RETURN NULL;
  ELSIF eduos_ctx_district() IS NOT NULL THEN
    IF t.source_kind = 'district' THEN RETURN 'use_the_signed_history_transfer'; END IF;
    IF eduos_ctx_role() NOT IN ('principal','superintendent') THEN RETURN 'records_office_only'; END IF;
    IF NOT eduos_district_transfers_on(eduos_ctx_district()) THEN RETURN 'district_transfers_off'; END IF;
    RETURN NULL;
  END IF;
  RETURN 'no_context';
END $$;

DROP FUNCTION eduos_transfer_accept(text, uuid);
-- p_target: the campus, for a private school; the existing student it belongs to, for a district.
CREATE FUNCTION eduos_transfer_accept(p_token_hash text, p_target uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t learner_transfers%ROWTYPE; err text; fam uuid := eduos_ctx_family(); sch uuid := eduos_ctx_private_school(); dis uuid := eduos_ctx_district();
  lid uuid; lbl text; grade text; it jsonb; n int := 0;
BEGIN
  SELECT * INTO t FROM learner_transfers WHERE token_hash = p_token_hash FOR UPDATE;
  err := eduos_transfer_receivable(t);
  IF err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', err); END IF;
  grade := coalesce(t.snapshot->'learner'->>'gradeBand', t.snapshot->'learner'->>'gradeLevel');
  IF fam IS NOT NULL THEN
    INSERT INTO family_learners(family_id, display_name, grade_band, created_by)
      VALUES (fam, t.snapshot->'learner'->>'displayName', CASE WHEN grade IN ('pre_k','k','1','2','3','4','5','6','7','8','9','10','11','12','adult') THEN grade END, eduos_ctx_user()) RETURNING id INTO lid;
    SELECT display_name INTO lbl FROM homeschool_families WHERE id = fam;
  ELSIF sch IS NOT NULL THEN
    IF p_target IS NULL OR NOT EXISTS (SELECT 1 FROM private_school_campuses WHERE id = p_target AND school_id = sch AND status = 'active') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'campus_required'); END IF;
    INSERT INTO private_school_learners(school_id, campus_id, display_name, grade_level, enrolled_on, created_by)
      VALUES (sch, p_target, t.snapshot->'learner'->>'displayName', CASE WHEN grade IN ('pre_k','k','1','2','3','4','5','6','7','8','9','10','11','12') THEN grade END,
        (now() AT TIME ZONE 'UTC')::date, eduos_ctx_user()) RETURNING id INTO lid;
    SELECT display_name INTO lbl FROM private_schools WHERE id = sch;
  ELSE
    -- Never matched or created automatically: the records office picks a student it already has.
    IF p_target IS NULL OR NOT eduos_district_records_office(p_target) THEN RETURN jsonb_build_object('ok', false, 'error', 'student_required'); END IF;
    lid := p_target;
    SELECT name INTO lbl FROM districts WHERE id = dis;
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(t.snapshot->'items') LOOP
    INSERT INTO transferred_records(transfer_id, family_id, family_learner_id, school_id, ps_learner_id, district_id, student_id, kind, title, detail, provenance)
      VALUES (t.id, fam, CASE WHEN fam IS NOT NULL THEN lid END, sch, CASE WHEN sch IS NOT NULL THEN lid END, dis, CASE WHEN dis IS NOT NULL THEN lid END,
        it->>'kind', left(it->>'title', 240), it->'detail', t.snapshot->>'provenance');
    n := n + 1;
  END LOOP;
  UPDATE learner_transfers SET status = 'accepted', receiver_kind = CASE WHEN fam IS NOT NULL THEN 'homeschool_family' WHEN sch IS NOT NULL THEN 'private_school' ELSE 'district' END,
    receiver_tenant = coalesce(fam, sch, dis), receiver_label = lbl, receiver_learner = lid, decided_by = eduos_ctx_user(), decided_at = now() WHERE id = t.id;
  PERFORM eduos_transfer_audit('accept', t.id, 'from=' || t.source_label || ';records=' || n);
  RETURN jsonb_build_object('ok', true, 'id', t.id, 'learnerId', lid, 'records', n);
END $$;

CREATE OR REPLACE FUNCTION eduos_transfer_decline(p_token_hash text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t learner_transfers%ROWTYPE; err text; fam uuid := eduos_ctx_family(); sch uuid := eduos_ctx_private_school(); dis uuid := eduos_ctx_district();
BEGIN
  SELECT * INTO t FROM learner_transfers WHERE token_hash = p_token_hash FOR UPDATE;
  err := eduos_transfer_receivable(t);
  IF err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', err); END IF;
  UPDATE learner_transfers SET status = 'declined', receiver_kind = CASE WHEN fam IS NOT NULL THEN 'homeschool_family' WHEN sch IS NOT NULL THEN 'private_school' ELSE 'district' END,
    receiver_tenant = coalesce(fam, sch, dis),
    receiver_label = coalesce((SELECT display_name FROM homeschool_families WHERE id = fam), (SELECT display_name FROM private_schools WHERE id = sch), (SELECT name FROM districts WHERE id = dis)),
    decided_by = eduos_ctx_user(), decided_at = now(), decline_reason = p_reason WHERE id = t.id;
  PERFORM eduos_transfer_audit('decline', t.id, p_reason);
  RETURN jsonb_build_object('ok', true);
END $$;

CREATE OR REPLACE FUNCTION eduos_transferred_record_void(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r transferred_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM transferred_records WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT ((r.family_id IS NOT NULL AND r.family_id = eduos_ctx_family() AND eduos_family_authority(r.family_learner_id) = 'full')
      OR (r.school_id IS NOT NULL AND r.school_id = eduos_ctx_private_school() AND eduos_ps_has(ARRAY['school_admin','registrar']))
      OR (r.district_id IS NOT NULL AND r.district_id = eduos_ctx_district() AND eduos_district_records_office(r.student_id))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'record_not_found'); END IF;
  IF r.voided_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'already_voided'); END IF;
  UPDATE transferred_records SET voided_by = eduos_ctx_user(), voided_at = now(), void_reason = p_reason WHERE id = p_id;
  PERFORM eduos_transfer_audit('void_record', r.transfer_id, r.kind || ';' || p_reason);
  RETURN jsonb_build_object('ok', true);
END $$;

-- Received records: also the receiving district's records office for that student.
DROP POLICY receiver_only ON transferred_records;
CREATE POLICY receiver_only ON transferred_records FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE
  (family_id IS NOT NULL AND family_id = eduos_ctx_family() AND eduos_family_authority(family_learner_id) IS NOT NULL)
  OR (school_id IS NOT NULL AND school_id = eduos_ctx_private_school() AND eduos_ps_sees_learner(ps_learner_id))
  OR (district_id IS NOT NULL AND district_id = eduos_ctx_district() AND eduos_district_records_office(student_id)) END);

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_district_records_office(uuid)','eduos_district_guardian(uuid,uuid,uuid)','eduos_district_transfers_on(uuid)','eduos_transfer_accept(text,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;

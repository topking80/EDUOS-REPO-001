-- HSP-06: controlled learner transfers between homeschool families and private
-- schools (design: docs/product/hsp-06-learner-transfers.md).
--
-- A transfer is a frozen, field-selective snapshot of one learner's records:
--   1. the sender prepares it: a family adult with full authority over the
--      learner, or a private school's school admin or registrar;
--   2. a school's transfer needs a guardian with full authority to release it
--      (the family's own transfer is released by preparing it);
--   3. the releaser gets a one-time code (shown once, 14 days) and gives it to
--      the receiver themselves;
--   4. the receiver previews it and accepts or declines: a family's owner, or
--      a verified private school's school admin or registrar. A school's
--      records go to a family only if the person accepting is that learner's
--      guardian at the school.
-- Nothing moves on its own: the sender's records stay where they are, and the
-- receiver gets a new learner with the snapshot attached as read-only,
-- provenance-labelled records it can void (correct) but not edit. Identities
-- are never merged. District transfers are not part of this slice.
-- All writes go through the functions below; the runtime role only reads.

CREATE TABLE learner_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('homeschool_family','private_school')),
  source_tenant uuid NOT NULL REFERENCES tenants(id),
  source_learner uuid NOT NULL,
  source_label text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('enrollment','records_request','return_to_homeschool','other')),
  note text CHECK (note IS NULL OR length(note) <= 500),
  sections text[] NOT NULL CHECK (cardinality(sections) BETWEEN 1 AND 5),
  snapshot jsonb NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('awaiting_release','ready','accepted','declined','revoked')),
  prepared_by uuid NOT NULL REFERENCES users(id),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  released_by uuid REFERENCES users(id),
  released_at timestamptz,
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz,
  receiver_kind text CHECK (receiver_kind IN ('homeschool_family','private_school')),
  receiver_tenant uuid REFERENCES tenants(id),
  receiver_label text,
  receiver_learner uuid,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decline_reason text CHECK (decline_reason IS NULL OR length(btrim(decline_reason)) BETWEEN 3 AND 300),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 300),
  CHECK ((status = 'awaiting_release') = (released_at IS NULL)),
  CHECK ((released_at IS NULL) = (token_hash IS NULL) AND (token_hash IS NULL) = (expires_at IS NULL)),
  CHECK ((status IN ('accepted','declined')) = (decided_at IS NOT NULL)),
  CHECK ((status = 'accepted') = (receiver_learner IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (receiver_tenant IS NULL OR receiver_tenant <> source_tenant)
);
CREATE INDEX learner_transfers_source ON learner_transfers(source_tenant, prepared_at DESC);
CREATE INDEX learner_transfers_receiver ON learner_transfers(receiver_tenant) WHERE receiver_tenant IS NOT NULL;
-- The snapshot never changes after it is prepared.
CREATE FUNCTION eduos_transfer_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'learner transfers are kept' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot OR NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.sections IS DISTINCT FROM OLD.sections OR NEW.source_tenant IS DISTINCT FROM OLD.source_tenant
     OR NEW.source_learner IS DISTINCT FROM OLD.source_learner OR NEW.purpose IS DISTINCT FROM OLD.purpose THEN
    RAISE EXCEPTION 'a transfer snapshot is frozen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('accepted','declined','revoked') THEN RAISE EXCEPTION 'a decided transfer is final' USING ERRCODE = 'insufficient_privilege'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learner_transfers_frozen BEFORE UPDATE OR DELETE ON learner_transfers FOR EACH ROW EXECUTE FUNCTION eduos_transfer_frozen();

-- What the receiver got: one row per item, attached to its new learner.
CREATE TABLE transferred_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transfer_id uuid NOT NULL REFERENCES learner_transfers(id),
  family_id uuid,
  family_learner_id uuid,
  school_id uuid,
  ps_learner_id uuid,
  kind text NOT NULL CHECK (kind IN ('course','attendance_year','work','report_card','enrollment')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  detail jsonb NOT NULL,
  provenance text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 300),
  FOREIGN KEY (family_id, family_learner_id) REFERENCES family_learners(family_id, id),
  FOREIGN KEY (school_id, ps_learner_id) REFERENCES private_school_learners(school_id, id),
  CHECK ((family_id IS NULL) = (family_learner_id IS NULL) AND (school_id IS NULL) = (ps_learner_id IS NULL) AND ((family_id IS NULL) <> (school_id IS NULL))),
  CHECK ((voided_at IS NULL) = (voided_by IS NULL) AND (voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX transferred_records_family ON transferred_records(family_id, family_learner_id) WHERE family_id IS NOT NULL;
CREATE INDEX transferred_records_school ON transferred_records(school_id, ps_learner_id) WHERE school_id IS NOT NULL;
CREATE FUNCTION eduos_transferred_records_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.voided_at IS NOT NULL OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.title IS DISTINCT FROM OLD.title OR NEW.detail IS DISTINCT FROM OLD.detail
     OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.transfer_id IS DISTINCT FROM OLD.transfer_id OR NEW.family_learner_id IS DISTINCT FROM OLD.family_learner_id
     OR NEW.ps_learner_id IS DISTINCT FROM OLD.ps_learner_id THEN
    RAISE EXCEPTION 'transferred records can only be voided' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER transferred_records_fixed BEFORE UPDATE OR DELETE ON transferred_records FOR EACH ROW EXECUTE FUNCTION eduos_transferred_records_fixed();

-- ---------------------------------------------------------------- helpers
-- The session holds an open full-authority guardian link to this learner at the school in context.
CREATE FUNCTION eduos_ps_guards(p_learner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ps_has(ARRAY['guardian']) AND EXISTS (SELECT 1 FROM private_school_guardian_links g WHERE g.learner_id = p_learner AND g.school_id = eduos_ctx_private_school()
    AND g.user_id = eduos_ctx_user() AND g.revoked_at IS NULL AND g.authority = 'full')
$$;
-- Which side of a transfer the session is on, if any: 'sender' or 'receiver'.
CREATE FUNCTION eduos_transfer_side(p_source_kind text, p_source_tenant uuid, p_source_learner uuid, p_receiver_kind text, p_receiver_tenant uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN p_source_kind = 'homeschool_family' AND p_source_tenant = eduos_ctx_family() AND eduos_family_authority(p_source_learner) = 'full' THEN 'sender'
    WHEN p_source_kind = 'private_school' AND p_source_tenant = eduos_ctx_private_school()
      AND (eduos_ps_has(ARRAY['school_admin','registrar']) OR eduos_ps_guards(p_source_learner)) THEN 'sender'
    WHEN p_receiver_kind = 'homeschool_family' AND p_receiver_tenant = eduos_ctx_family() AND eduos_family_role() = 'owner' THEN 'receiver'
    WHEN p_receiver_kind = 'private_school' AND p_receiver_tenant = eduos_ctx_private_school() AND eduos_ps_has(ARRAY['school_admin','registrar']) THEN 'receiver'
  END
$$;
CREATE FUNCTION eduos_school_year(d date) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN extract(month FROM d) >= 7 THEN extract(year FROM d)::int || '-' || (extract(year FROM d)::int + 1)
              ELSE (extract(year FROM d)::int - 1) || '-' || extract(year FROM d)::int END
$$;
-- Write an audit event in the tenant in context (internal; not granted).
CREATE FUNCTION eduos_transfer_audit(p_action text, p_id uuid, p_detail text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF eduos_ctx_family() IS NOT NULL THEN
    INSERT INTO family_audit_events(family_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
      VALUES (eduos_ctx_family(), eduos_ctx_user(), coalesce(eduos_family_role(), 'unknown'), p_action, 'learner_transfer', p_id::text, p_detail);
  ELSIF eduos_ctx_private_school() IS NOT NULL THEN
    INSERT INTO private_school_audit_events(school_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
      VALUES (eduos_ctx_private_school(), eduos_ctx_user(), coalesce((eduos_ps_roles())[1], 'unknown'), p_action, 'learner_transfer', p_id::text, p_detail);
  END IF;
END $$;

-- ---------------------------------------------------------------- prepare
-- Sections: a family sends courses, attendance (yearly totals) and work; a
-- school sends enrollment, report_cards (published only) and attendance
-- (yearly totals). Daily attendance, notes, goals, drafts, billing and
-- guardian details are never included.
CREATE FUNCTION eduos_transfer_prepare(p_learner uuid, p_purpose text, p_sections text[], p_note text, p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE fam uuid := eduos_ctx_family(); sch uuid := eduos_ctx_private_school(); v_kind text; label text; prov text; learner jsonb; items jsonb := '[]'::jsonb;
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
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'family_or_private_school_context_required');
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
  ELSE
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
  END IF;

  snap := jsonb_build_object('learner', learner, 'source', jsonb_build_object('kind', v_kind, 'name', label), 'provenance', prov, 'purpose', p_purpose,
    'sections', to_jsonb(p_sections), 'items', items, 'preparedAt', now());
  INSERT INTO learner_transfers(source_kind, source_tenant, source_learner, source_label, purpose, note, sections, snapshot, sha256, status, prepared_by,
      released_by, released_at, token_hash, expires_at)
    VALUES (v_kind, coalesce(fam, sch), p_learner, label, p_purpose, nullif(btrim(p_note), ''), p_sections, snap, encode(sha256(convert_to(snap::text, 'UTF8')), 'hex'), st, eduos_ctx_user(),
      CASE WHEN st = 'ready' THEN eduos_ctx_user() END, CASE WHEN st = 'ready' THEN now() END, CASE WHEN st = 'ready' THEN p_token_hash END, CASE WHEN st = 'ready' THEN now() + interval '14 days' END)
    RETURNING id INTO tid;
  PERFORM eduos_transfer_audit('prepare', tid, array_to_string(p_sections, ',') || ';items=' || jsonb_array_length(items) || ';purpose=' || p_purpose);
  RETURN jsonb_build_object('ok', true, 'id', tid, 'status', st, 'items', jsonb_array_length(items));
END $$;

-- A guardian with full authority releases a school's transfer and gets the code.
CREATE FUNCTION eduos_transfer_release(p_id uuid, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t learner_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM learner_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR t.source_kind <> 'private_school' OR t.source_tenant IS DISTINCT FROM eduos_ctx_private_school() OR NOT eduos_ps_guards(t.source_learner) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'transfer_not_found'); END IF;
  IF t.status <> 'awaiting_release' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_awaiting_release'); END IF;
  IF p_token_hash IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'token_required'); END IF;
  UPDATE learner_transfers SET status = 'ready', released_by = eduos_ctx_user(), released_at = now(), token_hash = p_token_hash, expires_at = now() + interval '14 days' WHERE id = p_id;
  PERFORM eduos_transfer_audit('release', p_id, NULL);
  RETURN jsonb_build_object('ok', true, 'id', p_id, 'expiresAt', now() + interval '14 days');
END $$;

-- The sender withdraws it before it is decided.
CREATE FUNCTION eduos_transfer_revoke(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t learner_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM learner_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR eduos_transfer_side(t.source_kind, t.source_tenant, t.source_learner, t.receiver_kind, t.receiver_tenant) IS DISTINCT FROM 'sender' THEN RETURN jsonb_build_object('ok', false, 'error', 'transfer_not_found'); END IF;
  IF t.status NOT IN ('awaiting_release','ready') THEN RETURN jsonb_build_object('ok', false, 'error', 'already_decided'); END IF;
  UPDATE learner_transfers SET status = 'revoked', revoked_by = eduos_ctx_user(), revoked_at = now(), revoke_reason = p_reason WHERE id = p_id;
  PERFORM eduos_transfer_audit('revoke', p_id, p_reason);
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------------------------------------------------------------- receive
-- May the session receive this transfer? Returns an error code or NULL.
CREATE FUNCTION eduos_transfer_receivable(t learner_transfers) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF t.id IS NULL OR t.status <> 'ready' OR t.expires_at < now() THEN RETURN 'transfer_code_not_valid'; END IF;
  IF coalesce(eduos_ctx_family(), eduos_ctx_private_school()) = t.source_tenant THEN RETURN 'same_family_or_school'; END IF;
  IF eduos_ctx_family() IS NOT NULL THEN
    IF eduos_family_role() IS DISTINCT FROM 'owner' THEN RETURN 'family_owner_only'; END IF;
    -- A school's records go to a family only when the person receiving is that learner's guardian there.
    IF t.source_kind = 'private_school' AND NOT EXISTS (SELECT 1 FROM private_school_guardian_links g WHERE g.school_id = t.source_tenant AND g.learner_id = t.source_learner
        AND g.user_id = eduos_ctx_user() AND g.revoked_at IS NULL AND g.authority = 'full') THEN RETURN 'guardian_of_this_learner_only'; END IF;
    RETURN NULL;
  ELSIF eduos_ctx_private_school() IS NOT NULL THEN
    IF NOT eduos_ps_has(ARRAY['school_admin','registrar']) THEN RETURN 'registrar_or_admin_only'; END IF;
    IF NOT eduos_ps_active() THEN RETURN 'school_not_verified'; END IF;
    RETURN NULL;
  END IF;
  RETURN 'family_or_private_school_context_required';
END $$;

CREATE FUNCTION eduos_transfer_preview(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t learner_transfers%ROWTYPE; err text;
BEGIN
  SELECT * INTO t FROM learner_transfers WHERE token_hash = p_token_hash;
  err := eduos_transfer_receivable(t);
  IF err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', err); END IF;
  RETURN jsonb_build_object('ok', true, 'id', t.id, 'from', t.source_label, 'fromKind', t.source_kind, 'purpose', t.purpose, 'note', t.note, 'sections', to_jsonb(t.sections),
    'snapshot', t.snapshot, 'sha256', t.sha256, 'expiresAt', t.expires_at);
END $$;

CREATE FUNCTION eduos_transfer_accept(p_token_hash text, p_campus uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t learner_transfers%ROWTYPE; err text; fam uuid := eduos_ctx_family(); sch uuid := eduos_ctx_private_school(); lid uuid; lbl text; grade text; it jsonb; n int := 0;
BEGIN
  SELECT * INTO t FROM learner_transfers WHERE token_hash = p_token_hash FOR UPDATE;
  err := eduos_transfer_receivable(t);
  IF err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', err); END IF;
  grade := coalesce(t.snapshot->'learner'->>'gradeBand', t.snapshot->'learner'->>'gradeLevel');
  IF fam IS NOT NULL THEN
    INSERT INTO family_learners(family_id, display_name, grade_band, created_by) VALUES (fam, t.snapshot->'learner'->>'displayName', grade, eduos_ctx_user()) RETURNING id INTO lid;
    SELECT display_name INTO lbl FROM homeschool_families WHERE id = fam;
  ELSE
    IF p_campus IS NULL OR NOT EXISTS (SELECT 1 FROM private_school_campuses WHERE id = p_campus AND school_id = sch AND status = 'active') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'campus_required'); END IF;
    INSERT INTO private_school_learners(school_id, campus_id, display_name, grade_level, enrolled_on, created_by)
      VALUES (sch, p_campus, t.snapshot->'learner'->>'displayName', CASE WHEN grade = 'adult' THEN NULL ELSE grade END, (now() AT TIME ZONE 'UTC')::date, eduos_ctx_user()) RETURNING id INTO lid;
    SELECT display_name INTO lbl FROM private_schools WHERE id = sch;
  END IF;
  FOR it IN SELECT * FROM jsonb_array_elements(t.snapshot->'items') LOOP
    INSERT INTO transferred_records(transfer_id, family_id, family_learner_id, school_id, ps_learner_id, kind, title, detail, provenance)
      VALUES (t.id, fam, CASE WHEN fam IS NOT NULL THEN lid END, sch, CASE WHEN sch IS NOT NULL THEN lid END, it->>'kind', left(it->>'title', 240), it->'detail', t.snapshot->>'provenance');
    n := n + 1;
  END LOOP;
  UPDATE learner_transfers SET status = 'accepted', receiver_kind = CASE WHEN fam IS NOT NULL THEN 'homeschool_family' ELSE 'private_school' END, receiver_tenant = coalesce(fam, sch),
    receiver_label = lbl, receiver_learner = lid, decided_by = eduos_ctx_user(), decided_at = now() WHERE id = t.id;
  PERFORM eduos_transfer_audit('accept', t.id, 'from=' || t.source_label || ';records=' || n);
  RETURN jsonb_build_object('ok', true, 'id', t.id, 'learnerId', lid, 'records', n);
END $$;

CREATE FUNCTION eduos_transfer_decline(p_token_hash text, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t learner_transfers%ROWTYPE; err text; fam uuid := eduos_ctx_family(); sch uuid := eduos_ctx_private_school();
BEGIN
  SELECT * INTO t FROM learner_transfers WHERE token_hash = p_token_hash FOR UPDATE;
  err := eduos_transfer_receivable(t);
  IF err IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', err); END IF;
  UPDATE learner_transfers SET status = 'declined', receiver_kind = CASE WHEN fam IS NOT NULL THEN 'homeschool_family' ELSE 'private_school' END, receiver_tenant = coalesce(fam, sch),
    receiver_label = coalesce((SELECT display_name FROM homeschool_families WHERE id = fam), (SELECT display_name FROM private_schools WHERE id = sch)),
    decided_by = eduos_ctx_user(), decided_at = now(), decline_reason = p_reason WHERE id = t.id;
  PERFORM eduos_transfer_audit('decline', t.id, p_reason);
  RETURN jsonb_build_object('ok', true);
END $$;

-- The receiver corrects what it got by voiding an item, with a reason.
CREATE FUNCTION eduos_transferred_record_void(p_id uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r transferred_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM transferred_records WHERE id = p_id FOR UPDATE;
  IF NOT FOUND OR NOT ((r.family_id IS NOT NULL AND r.family_id = eduos_ctx_family() AND eduos_family_authority(r.family_learner_id) = 'full')
      OR (r.school_id IS NOT NULL AND r.school_id = eduos_ctx_private_school() AND eduos_ps_has(ARRAY['school_admin','registrar']))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'record_not_found'); END IF;
  IF r.voided_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'already_voided'); END IF;
  UPDATE transferred_records SET voided_by = eduos_ctx_user(), voided_at = now(), void_reason = p_reason WHERE id = p_id;
  PERFORM eduos_transfer_audit('void_record', r.transfer_id, r.kind || ';' || p_reason);
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------------------------------------------------------------- RLS
ALTER TABLE learner_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_transfers FORCE ROW LEVEL SECURITY;
-- Seen by the sending side (full authority, or the school's admin, registrar
-- and full-authority guardians) and, once decided, by the receiving side.
-- Writes happen only inside the definer functions (the table owner).
CREATE POLICY owner_writes ON learner_transfers USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY transfer_sides ON learner_transfers FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_transfer_side(source_kind, source_tenant, source_learner, receiver_kind, receiver_tenant) IS NOT NULL END);
ALTER TABLE transferred_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE transferred_records FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_writes ON transferred_records USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY receiver_only ON transferred_records FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE
  (family_id IS NOT NULL AND family_id = eduos_ctx_family() AND eduos_family_authority(family_learner_id) IS NOT NULL)
  OR (school_id IS NOT NULL AND school_id = eduos_ctx_private_school() AND eduos_ps_sees_learner(ps_learner_id)) END);

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_ps_guards(uuid)','eduos_transfer_side(text,uuid,uuid,text,uuid)','eduos_transfer_prepare(uuid,text,text[],text,text)','eduos_transfer_release(uuid,text)',
      'eduos_transfer_revoke(uuid,text)','eduos_transfer_preview(text)','eduos_transfer_accept(text,uuid)','eduos_transfer_decline(text,text)','eduos_transferred_record_void(uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
  REVOKE ALL ON FUNCTION eduos_transfer_audit(text,uuid,text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION eduos_transfer_receivable(learner_transfers) FROM PUBLIC;
END $$;

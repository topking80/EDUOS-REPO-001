-- TC-06a: sending a student's history to another district (signed file handoff).
--
-- The school's records office (the principal, a vice principal acting as one,
-- or the superintendent) starts a transfer for one student with a basis (the
-- receiving district's enrollment or records request, a family request, or
-- another stated reason). Official records, teacher items and milestones go on
-- the records office's authority. Family memories and the student's own
-- portfolio go only if the family agrees: the student when they hold their own
-- record rights, otherwise a guardian with access. Private items never go.
--
-- When it's ready, the list of items (with the revision of each) is frozen, so
-- the package is the same every time it's downloaded. The package is a signed
-- file (src/history-transfer.js) the records office sends through its usual
-- records channel; nothing is sent automatically. Every download is logged
-- under "Who looked" and audited. Nothing here changes the student's records.

CREATE TABLE history_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  receiving_district text NOT NULL CHECK (length(btrim(receiving_district)) BETWEEN 2 AND 200),
  basis text NOT NULL CHECK (basis IN ('enrollment_request','records_request','family_request','other')),
  basis_note text NOT NULL CHECK (length(btrim(basis_note)) BETWEEN 5 AND 500),
  include_family boolean NOT NULL DEFAULT false,
  family_decision text CHECK (family_decision IS NULL OR family_decision IN ('pending','approved','declined')),
  family_decided_by uuid REFERENCES users(id),
  family_decided_at timestamptz,
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('awaiting_family','ready','cancelled')),
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ready_at timestamptz,
  item_count integer,
  package_sha256 text CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[0-9a-f]{64}$'),
  first_downloaded_at timestamptz,
  download_count integer NOT NULL DEFAULT 0,
  cancelled_by uuid REFERENCES users(id),
  cancelled_at timestamptz,
  cancel_note text CHECK (cancel_note IS NULL OR length(cancel_note) <= 300),
  CHECK (include_family = (family_decision IS NOT NULL)),
  CHECK ((status = 'awaiting_family') = (include_family AND family_decision = 'pending')),
  CHECK (status <> 'ready' OR ready_at IS NOT NULL),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id)
);
CREATE INDEX history_transfers_student ON history_transfers(district_id, student_id, created_at DESC);

CREATE TABLE history_transfer_items (
  transfer_id uuid NOT NULL REFERENCES history_transfers(id),
  district_id uuid NOT NULL REFERENCES districts(id),
  entry_id uuid NOT NULL,
  revision_no integer NOT NULL,
  classification text NOT NULL,
  position integer NOT NULL,
  PRIMARY KEY (transfer_id, entry_id),
  FOREIGN KEY (district_id, entry_id, revision_no) REFERENCES student_history_entry_revisions(district_id, entry_id, revision_no)
);

ALTER TABLE history_access_log DROP CONSTRAINT history_access_log_action_check;
ALTER TABLE history_access_log ADD CONSTRAINT history_access_log_action_check
  CHECK (action IN ('view_history','view_capsule','export_history','transfer_package'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['history_transfers','history_transfer_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The records office for a school: its principal (a vice principal acts as
-- one) or the superintendent.
CREATE FUNCTION eduos_records_office_for(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') = 'superintendent' OR (coalesce(eduos_ctx_role(), '') = 'principal' AND p_school = eduos_ctx_school())
$$;
CREATE POLICY scope_read ON history_transfers AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_records_office_for(school_id));
CREATE POLICY functions_write ON history_transfers AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY functions_update ON history_transfers AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY functions_only ON history_transfer_items AS RESTRICTIVE USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- Freeze what goes: published, not private; records always, family kinds only if agreed.
CREATE FUNCTION eduos_history_transfer_freeze(p_transfer uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t history_transfers%ROWTYPE; n int;
BEGIN
  SELECT * INTO t FROM history_transfers WHERE id = p_transfer;
  INSERT INTO history_transfer_items(transfer_id, district_id, entry_id, revision_no, classification, position)
    SELECT t.id, e.district_id, e.id, e.revision_no, e.classification, row_number() OVER (ORDER BY e.occurred_at, e.id)
      FROM student_history_entries e
     WHERE e.district_id = t.district_id AND e.student_id = t.student_id AND e.status = 'published' AND e.audience <> 'private'
       AND (e.classification IN ('official_record','teacher_artifact','system_milestone')
            OR (e.classification IN ('family_memory','student_portfolio') AND t.family_decision = 'approved'));
  GET DIAGNOSTICS n = ROW_COUNT;
  UPDATE history_transfers SET status = 'ready', ready_at = now(), item_count = n WHERE id = t.id;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION eduos_history_transfer_freeze(uuid) FROM PUBLIC;

-- Start a transfer (the records office).
CREATE FUNCTION eduos_history_transfer_start(p_student uuid, p_receiving text, p_basis text, p_note text, p_family boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s students%ROWTYPE; tid uuid;
BEGIN
  SELECT * INTO s FROM students WHERE id = p_student AND district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT eduos_records_office_for(s.school_id) THEN RETURN jsonb_build_object('error', 'student_not_found'); END IF;
  INSERT INTO history_transfers(district_id, school_id, student_id, receiving_district, basis, basis_note, include_family, family_decision, status, ready_at, requested_by)
    VALUES (s.district_id, s.school_id, s.id, btrim(p_receiving), p_basis, btrim(p_note), p_family, CASE WHEN p_family THEN 'pending' END,
            CASE WHEN p_family THEN 'awaiting_family' ELSE 'ready' END, CASE WHEN p_family THEN NULL ELSE now() END, eduos_ctx_user())
    RETURNING id INTO tid;
  IF NOT p_family THEN PERFORM eduos_history_transfer_freeze(tid); END IF;
  RETURN jsonb_build_object('id', tid);
END $$;

-- Who decides for the family: the student once they hold their own record
-- rights, otherwise a guardian with access (not under a custody restriction).
CREATE FUNCTION eduos_history_transfer_family_decider(p_transfer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM history_transfers t WHERE t.id = p_transfer AND t.district_id = eduos_ctx_district()
    AND CASE WHEN eduos_student_holds_rights(t.student_id)
             THEN eduos_ctx_role() = 'pupil' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id = t.district_id AND l.student_id = t.student_id
                    AND l.user_id = eduos_ctx_user() AND l.status = 'active' AND l.relationship = 'pupil')
             ELSE eduos_ctx_role() = 'parent' AND EXISTS (SELECT 1 FROM student_user_links l WHERE l.district_id = t.district_id AND l.student_id = t.student_id
                    AND l.user_id = eduos_ctx_user() AND l.status = 'active' AND l.relationship IN ('parent','guardian'))
                  AND NOT eduos_custody_blocked(t.student_id, eduos_ctx_user()) END)
$$;

CREATE FUNCTION eduos_history_transfer_family_pending() RETURNS TABLE(id uuid, student_id uuid, student_name text, school_name text, receiving_district text,
  basis text, basis_note text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.student_id, s.display_name, sc.name, t.receiving_district, t.basis, t.basis_note, t.created_at
    FROM history_transfers t JOIN students s ON s.id = t.student_id JOIN schools sc ON sc.id = t.school_id
   WHERE t.district_id = eduos_ctx_district() AND t.status = 'awaiting_family' AND eduos_history_transfer_family_decider(t.id)
   ORDER BY t.created_at
$$;

CREATE FUNCTION eduos_history_transfer_family_decide(p_transfer uuid, p_approve boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t history_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM history_transfers WHERE id = p_transfer AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_history_transfer_family_decider(p_transfer) THEN RETURN 'not_found'; END IF;
  IF t.status <> 'awaiting_family' THEN RETURN 'already_decided'; END IF;
  UPDATE history_transfers SET family_decision = CASE WHEN p_approve THEN 'approved' ELSE 'declined' END,
         family_decided_by = eduos_ctx_user(), family_decided_at = now(), status = 'ready', ready_at = now()
   WHERE id = t.id;
  PERFORM eduos_history_transfer_freeze(t.id);
  RETURN CASE WHEN p_approve THEN 'approved' ELSE 'declined' END;
END $$;

CREATE FUNCTION eduos_history_transfer_cancel(p_transfer uuid, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t history_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM history_transfers WHERE id = p_transfer AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_records_office_for(t.school_id) THEN RETURN 'not_found'; END IF;
  IF t.status = 'cancelled' THEN RETURN 'already_cancelled'; END IF;
  UPDATE history_transfers SET status = 'cancelled', cancelled_by = eduos_ctx_user(), cancelled_at = now(), cancel_note = p_note WHERE id = t.id;
  RETURN 'cancelled';
END $$;

-- The frozen items as they were (the saved revision), with their photos'
-- descriptions, for the records office to build the package.
CREATE FUNCTION eduos_history_transfer_contents(p_transfer uuid)
RETURNS TABLE(entry_id uuid, revision_no int, pos int, snapshot jsonb, author_name text, photos jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.entry_id, i.revision_no, i.position, r.snapshot, u.display_name,
         coalesce((SELECT jsonb_agg(jsonb_build_object('description', a.alt_text, 'caption', a.caption) ORDER BY a.position)
                     FROM student_history_entry_attachments a JOIN private_media_objects o ON o.asset_id = a.asset_id AND o.district_id = a.district_id
                    WHERE a.entry_id = i.entry_id AND a.district_id = i.district_id AND o.scan_status = 'clean' AND o.processing_status = 'processed'), '[]'::jsonb)
    FROM history_transfers t JOIN history_transfer_items i ON i.transfer_id = t.id
    JOIN student_history_entry_revisions r ON r.district_id = i.district_id AND r.entry_id = i.entry_id AND r.revision_no = i.revision_no
    JOIN student_history_entries e ON e.id = i.entry_id
    LEFT JOIN users u ON u.id = e.author_user_id
   WHERE t.id = p_transfer AND t.district_id = eduos_ctx_district() AND t.status = 'ready' AND eduos_records_office_for(t.school_id)
   ORDER BY i.position
$$;

-- Record a download: logged, counted, and the package hash fixed the first time.
CREATE FUNCTION eduos_history_transfer_downloaded(p_transfer uuid, p_sha256 text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t history_transfers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM history_transfers WHERE id = p_transfer AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_records_office_for(t.school_id) OR t.status <> 'ready' THEN RETURN 'not_found'; END IF;
  IF t.package_sha256 IS NOT NULL AND t.package_sha256 <> p_sha256 THEN RETURN 'package_changed'; END IF;
  UPDATE history_transfers SET package_sha256 = p_sha256, first_downloaded_at = coalesce(first_downloaded_at, now()), download_count = download_count + 1 WHERE id = t.id;
  INSERT INTO history_access_log(district_id, student_id, user_id, access, action, item_count)
    VALUES (t.district_id, t.student_id, eduos_ctx_user(), CASE WHEN eduos_ctx_role() = 'superintendent' THEN 'district' ELSE 'school_lead' END, 'transfer_package', t.item_count);
  RETURN 'ok';
END $$;

REVOKE ALL ON FUNCTION eduos_history_transfer_start(uuid, text, text, text, boolean), eduos_history_transfer_family_decider(uuid),
  eduos_history_transfer_family_pending(), eduos_history_transfer_family_decide(uuid, boolean), eduos_history_transfer_cancel(uuid, text),
  eduos_history_transfer_contents(uuid), eduos_history_transfer_downloaded(uuid, text) FROM PUBLIC;

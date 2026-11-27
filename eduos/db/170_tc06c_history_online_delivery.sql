-- TC-06c: deliver a student's history transfer to another district on the same
-- EduOS deployment, instead of someone carrying the signed file
-- (design: docs/HISTORY-TRANSFER.md, "Online delivery").
--
--   * A district receives online deliveries only after its superintendent
--     opts in; only opted-in districts are offered as destinations.
--   * The sending records office delivers a ready transfer (the family's
--     decision already made) to one such district. The signed file is the
--     same one a download gives, and it lands in the receiving district's
--     "Records from other districts" list for the district office.
--   * Nothing is added to any history on delivery: the receiving records
--     office still chooses the student and accepts or rejects each item
--     (TC-06b). EduOS attests who sent it, so the fingerprint phone check
--     isn't needed for an online delivery.
--   * Until the receiver has chosen a student, cancelling the transfer also
--     withdraws the delivery.
--   * Deliveries to another EduOS deployment still go as files: the
--     federation (Master Control) carries aggregates only and isn't changed.

CREATE TABLE history_delivery_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  accepting boolean NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE history_delivery_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE history_delivery_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY district_isolation ON history_delivery_settings USING (eduos_is_table_owner() OR district_id = eduos_ctx_district())
  WITH CHECK (eduos_is_table_owner() OR district_id = eduos_ctx_district());
CREATE POLICY superintendent_sets ON history_delivery_settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ctx_role() = 'superintendent' AND changed_by = eduos_ctx_user() END);
CREATE POLICY superintendent_changes ON history_delivery_settings AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ctx_role() = 'superintendent' END);

ALTER TABLE history_transfers ADD COLUMN delivered_to uuid REFERENCES districts(id), ADD COLUMN delivered_by uuid REFERENCES users(id),
  ADD COLUMN delivered_at timestamptz, ADD COLUMN delivered_import uuid REFERENCES history_imports(id),
  ADD CONSTRAINT history_transfers_delivery CHECK ((delivered_to IS NULL) = (delivered_at IS NULL) AND (delivered_at IS NULL) = (delivered_import IS NULL) AND (delivered_at IS NULL) = (delivered_by IS NULL)),
  ADD CONSTRAINT history_transfers_not_to_self CHECK (delivered_to IS DISTINCT FROM district_id);
ALTER TABLE history_imports ADD COLUMN delivered_from uuid REFERENCES districts(id), ADD COLUMN withdrawn_at timestamptz,
  ADD CONSTRAINT history_imports_not_from_self CHECK (delivered_from IS DISTINCT FROM district_id);

-- The districts on this deployment that receive online deliveries, other than your own.
CREATE FUNCTION eduos_history_delivery_directory() RETURNS TABLE(district_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.name FROM history_delivery_settings s JOIN districts d ON d.id = s.district_id AND d.status = 'active'
   WHERE s.accepting AND d.id <> eduos_ctx_district() AND eduos_ctx_role() IN ('principal','superintendent') ORDER BY d.name
$$;

-- Audit an event in another district (audit_events is scoped by app.district_id).
CREATE FUNCTION eduos_history_delivery_audit(p_district uuid, p_action text, p_id text, p_detail text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prev text := current_setting('app.district_id', true); r text := eduos_ctx_membership_role();
BEGIN
  PERFORM set_config('app.district_id', p_district::text, true);
  INSERT INTO audit_events(district_id, actor_user_id, actor_role, action, resource_type, resource_id, detail)
    VALUES (p_district, eduos_ctx_user(), 'other_district:' || r, p_action, 'history_import', p_id, left(p_detail, 1000));
  PERFORM set_config('app.district_id', coalesce(prev, ''), true);
END $$;

-- Deliver a ready transfer's signed package (built and signed by the server
-- exactly as a download) to an opted-in district on this deployment.
CREATE FUNCTION eduos_history_transfer_deliver(p_transfer uuid, p_to uuid, p_sha256 text, p_fingerprint text, p_meta jsonb, p_items jsonb, p_package jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t history_transfers%ROWTYPE; iid uuid; prior uuid;
BEGIN
  SELECT * INTO t FROM history_transfers WHERE id = p_transfer AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_records_office_for(t.school_id) THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  IF t.status <> 'ready' THEN RETURN jsonb_build_object('error', CASE WHEN t.status = 'awaiting_family' THEN 'awaiting_family_decision' ELSE 'transfer_cancelled' END); END IF;
  IF t.delivered_at IS NOT NULL THEN RETURN jsonb_build_object('error', 'already_delivered'); END IF;
  IF NOT EXISTS (SELECT 1 FROM eduos_history_delivery_directory() d WHERE d.district_id = p_to) THEN RETURN jsonb_build_object('error', 'district_not_receiving'); END IF;
  IF p_meta->>'sourceDistrictId' IS DISTINCT FROM t.district_id::text OR p_meta->>'packageId' IS DISTINCT FROM t.id::text THEN RETURN jsonb_build_object('error', 'package_mismatch'); END IF;
  IF t.package_sha256 IS NOT NULL AND t.package_sha256 <> p_sha256 THEN RETURN jsonb_build_object('error', 'package_changed'); END IF;
  SELECT id INTO prior FROM history_imports WHERE district_id = p_to AND package_sha256 = p_sha256;
  IF FOUND THEN RETURN jsonb_build_object('error', 'already_received_there'); END IF;
  -- The district office receives it first (school_id NULL), as with an upload by the superintendent.
  INSERT INTO history_imports(district_id, school_id, package_sha256, package_id, sender_fingerprint, source_district_id, source_district_name,
      source_school_name, addressed_to, basis, basis_note, includes_family, student_name, student_number, student_grade, packaged_at,
      item_count, package, received_by, delivered_from)
    VALUES (p_to, NULL, p_sha256, p_meta->>'packageId', p_fingerprint, p_meta->>'sourceDistrictId', p_meta->>'sourceDistrictName',
      coalesce(p_meta->>'sourceSchoolName', ''), p_meta->>'addressedTo', p_meta->>'basis', coalesce(p_meta->>'basisNote', ''),
      coalesce((p_meta->>'includesFamily')::boolean, false), p_meta->>'studentName', p_meta->>'studentNumber', p_meta->>'studentGrade',
      (p_meta->>'packagedAt')::timestamptz, jsonb_array_length(p_items), p_package, eduos_ctx_user(), t.district_id)
    RETURNING id INTO iid;
  INSERT INTO history_import_items(import_id, district_id, pos, source_entry_id, source_revision, item)
    SELECT iid, p_to, x.n, x.v->>'sourceEntryId', (x.v->>'revision')::int, x.v FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(v, n);
  UPDATE history_transfers SET package_sha256 = p_sha256, delivered_to = p_to, delivered_by = eduos_ctx_user(), delivered_at = now(), delivered_import = iid WHERE id = t.id;
  INSERT INTO history_access_log(district_id, student_id, user_id, access, action, item_count)
    VALUES (t.district_id, t.student_id, eduos_ctx_user(), CASE WHEN eduos_ctx_role() = 'superintendent' THEN 'district' ELSE 'school_lead' END, 'transfer_package', t.item_count);
  PERFORM eduos_history_delivery_audit(p_to, 'delivered_in', iid::text, 'from=' || (p_meta->>'sourceDistrictName') || ';items=' || jsonb_array_length(p_items));
  RETURN jsonb_build_object('id', iid, 'deliveredAt', now());
END $$;

-- Cancelling a delivered transfer withdraws the delivery while the receiver
-- hasn't chosen a student; after that, the receiving district is told by the
-- usual records channel.
CREATE OR REPLACE FUNCTION eduos_history_transfer_cancel(p_transfer uuid, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t history_transfers%ROWTYPE; withdrawn boolean := false;
BEGIN
  SELECT * INTO t FROM history_transfers WHERE id = p_transfer AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_records_office_for(t.school_id) THEN RETURN 'not_found'; END IF;
  IF t.status = 'cancelled' THEN RETURN 'already_cancelled'; END IF;
  UPDATE history_transfers SET status = 'cancelled', cancelled_by = eduos_ctx_user(), cancelled_at = now(), cancel_note = p_note WHERE id = t.id;
  IF t.delivered_import IS NOT NULL THEN
    UPDATE history_imports SET status = 'rejected', withdrawn_at = now(), closed_by = eduos_ctx_user(), closed_at = now(),
        close_note = left('Withdrawn by the sending district: ' || coalesce(p_note, ''), 300)
     WHERE id = t.delivered_import AND status = 'received' RETURNING true INTO withdrawn;
    IF withdrawn THEN PERFORM eduos_history_delivery_audit(t.delivered_to, 'withdrawn', t.delivered_import::text, p_note); END IF;
  END IF;
  RETURN CASE WHEN withdrawn THEN 'cancelled_and_withdrawn' ELSE 'cancelled' END;
END $$;

-- Confirming an online delivery: EduOS attests the sender, so no fingerprint is typed.
CREATE OR REPLACE FUNCTION eduos_history_import_confirm(p_import uuid, p_fingerprint text, p_student uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i history_imports%ROWTYPE; s students%ROWTYPE;
BEGIN
  SELECT * INTO i FROM history_imports WHERE id = p_import AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_history_import_office(i.school_id) THEN RETURN 'not_found'; END IF;
  IF i.status <> 'received' THEN RETURN CASE WHEN i.withdrawn_at IS NOT NULL THEN 'withdrawn_by_sender' ELSE 'already_confirmed' END; END IF;
  IF i.delivered_from IS NULL AND lower(regexp_replace(coalesce(p_fingerprint, ''), '[^0-9A-Fa-f]', '', 'g')) <> i.sender_fingerprint THEN RETURN 'fingerprint_mismatch'; END IF;
  SELECT * INTO s FROM students WHERE id = p_student AND district_id = i.district_id;
  IF NOT FOUND OR NOT coalesce(eduos_records_office_for(s.school_id), false) THEN RETURN 'student_not_found'; END IF;
  UPDATE history_imports SET student_id = s.id, school_id = s.school_id, status = 'reviewing', confirmed_by = eduos_ctx_user(), confirmed_at = now()
   WHERE id = i.id;
  RETURN 'reviewing';
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_history_delivery_directory()','eduos_history_transfer_deliver(uuid,uuid,text,text,jsonb,jsonb,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
  REVOKE ALL ON FUNCTION eduos_history_delivery_audit(uuid,text,text,text) FROM PUBLIC;
END $$;

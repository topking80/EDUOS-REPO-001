-- TC-06b: receiving a student's history from another district (the signed
-- file made by TC-06a).
--
-- The receiving school's records office (its principal, a vice principal
-- acting as one, or the superintendent) uploads the file. The server checks
-- the signature (src/history-transfer.js) and keeps the package exactly as
-- received. Nothing is added to anyone's history until a person:
--   1. confirms the sending district's signing fingerprint (which they got
--      from the sending district another way: phone, letterhead), and
--   2. chooses the local student it belongs to (suggestions only; never
--      matched automatically), then
--   3. accepts or rejects each item.
-- An accepted item becomes a published history item for that student with
-- its origin recorded (district, school, the sending side's item and revision,
-- the package hash, who accepted it). Receiving the same file again returns
-- the same import; an item already brought in by an earlier transfer is not
-- added twice. Nothing changes grades, enrollment or any other record.

CREATE TABLE history_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  -- The receiving school: the uploader's (a principal) until the student is
  -- chosen, then the student's. NULL while only the district office has it.
  school_id uuid,
  student_id uuid,
  package_sha256 text NOT NULL CHECK (package_sha256 ~ '^[0-9a-f]{64}$'),
  package_id text NOT NULL CHECK (length(package_id) <= 64),
  sender_fingerprint text NOT NULL CHECK (sender_fingerprint ~ '^[0-9a-f]{32}$'),
  source_district_id text NOT NULL CHECK (length(source_district_id) <= 64),
  source_district_name text NOT NULL CHECK (length(source_district_name) BETWEEN 1 AND 200),
  source_school_name text NOT NULL CHECK (length(source_school_name) <= 200),
  addressed_to text CHECK (addressed_to IS NULL OR length(addressed_to) <= 200),
  basis text NOT NULL CHECK (length(basis) <= 40),
  basis_note text NOT NULL CHECK (length(basis_note) <= 500),
  includes_family boolean NOT NULL,
  student_name text NOT NULL CHECK (length(student_name) BETWEEN 1 AND 200),
  student_number text CHECK (student_number IS NULL OR length(student_number) <= 100),
  student_grade text CHECK (student_grade IS NULL OR length(student_grade) <= 20),
  packaged_at timestamptz NOT NULL,
  item_count integer NOT NULL CHECK (item_count >= 0),
  package jsonb NOT NULL CHECK (jsonb_typeof(package) = 'object'),
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewing','completed','rejected')),
  received_by uuid NOT NULL REFERENCES users(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid REFERENCES users(id),
  confirmed_at timestamptz,
  closed_by uuid REFERENCES users(id),
  closed_at timestamptz,
  close_note text CHECK (close_note IS NULL OR length(close_note) <= 300),
  UNIQUE (district_id, package_sha256),
  CHECK (status <> 'received' OR confirmed_at IS NULL),
  CHECK (status <> 'reviewing' OR confirmed_at IS NOT NULL),
  CHECK ((student_id IS NULL) = (confirmed_at IS NULL)),
  CHECK ((status IN ('completed','rejected')) = (closed_at IS NOT NULL)),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id)
);
CREATE INDEX history_imports_open ON history_imports(district_id, status, received_at DESC);

CREATE TABLE history_import_items (
  import_id uuid NOT NULL REFERENCES history_imports(id),
  district_id uuid NOT NULL REFERENCES districts(id),
  pos integer NOT NULL CHECK (pos >= 1),
  source_entry_id text NOT NULL CHECK (length(source_entry_id) <= 64),
  source_revision integer NOT NULL CHECK (source_revision >= 1),
  item jsonb NOT NULL CHECK (jsonb_typeof(item) = 'object'),
  decision text NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','accepted','rejected')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  entry_id uuid REFERENCES student_history_entries(id),
  PRIMARY KEY (import_id, pos),
  UNIQUE (entry_id),
  CHECK ((decision = 'pending') = (decided_at IS NULL)),
  CHECK ((decision = 'accepted') = (entry_id IS NOT NULL))
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['history_imports','history_import_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The receiving records office for an import: the superintendent, or the
-- principal (a vice principal acts as one) of the import's school.
CREATE FUNCTION eduos_history_import_office(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() = 'superintendent' OR (eduos_ctx_role() = 'principal' AND p_school IS NOT NULL AND p_school IS NOT DISTINCT FROM eduos_ctx_school())
$$;
CREATE POLICY scope_read ON history_imports AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_history_import_office(school_id));
CREATE POLICY functions_write ON history_imports AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY functions_update ON history_imports AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_read ON history_import_items AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR EXISTS (SELECT 1 FROM history_imports i WHERE i.id = import_id));
CREATE POLICY functions_write ON history_import_items AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY functions_update ON history_import_items AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- Keep a checked package (the server verified the signature before calling).
-- The same file again returns the same import.
CREATE FUNCTION eduos_history_import_receive(p_sha256 text, p_fingerprint text, p_meta jsonb, p_items jsonb, p_package jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prior history_imports%ROWTYPE; iid uuid; sch uuid;
BEGIN
  IF eduos_ctx_role() NOT IN ('principal','superintendent') THEN RETURN jsonb_build_object('error', 'records_office_only'); END IF;
  SELECT * INTO prior FROM history_imports WHERE district_id = eduos_ctx_district() AND package_sha256 = p_sha256;
  IF FOUND THEN
    IF eduos_history_import_office(prior.school_id) THEN RETURN jsonb_build_object('id', prior.id, 'existing', true); END IF;
    RETURN jsonb_build_object('error', 'received_elsewhere');
  END IF;
  sch := CASE WHEN eduos_ctx_role() = 'principal' THEN eduos_ctx_school() END;
  INSERT INTO history_imports(district_id, school_id, package_sha256, package_id, sender_fingerprint, source_district_id, source_district_name,
      source_school_name, addressed_to, basis, basis_note, includes_family, student_name, student_number, student_grade, packaged_at,
      item_count, package, received_by)
    VALUES (eduos_ctx_district(), sch, p_sha256, p_meta->>'packageId', p_fingerprint, p_meta->>'sourceDistrictId', p_meta->>'sourceDistrictName',
      coalesce(p_meta->>'sourceSchoolName', ''), p_meta->>'addressedTo', p_meta->>'basis', coalesce(p_meta->>'basisNote', ''),
      coalesce((p_meta->>'includesFamily')::boolean, false), p_meta->>'studentName', p_meta->>'studentNumber', p_meta->>'studentGrade',
      (p_meta->>'packagedAt')::timestamptz, jsonb_array_length(p_items), p_package, eduos_ctx_user())
    RETURNING id INTO iid;
  INSERT INTO history_import_items(import_id, district_id, pos, source_entry_id, source_revision, item)
    SELECT iid, eduos_ctx_district(), x.n, x.v->>'sourceEntryId', (x.v->>'revision')::int, x.v
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS x(v, n);
  RETURN jsonb_build_object('id', iid, 'existing', false);
END $$;

-- Local students the package might belong to (same name or student number),
-- among those the caller may choose. Suggestions only.
CREATE FUNCTION eduos_history_import_candidates(p_import uuid)
RETURNS TABLE(id uuid, display_name text, local_student_number text, grade_level text, school_name text, same_name boolean, same_number boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.display_name, s.local_student_number, s.grade_level, sc.name,
         lower(btrim(s.display_name)) = lower(btrim(i.student_name)), s.local_student_number IS NOT DISTINCT FROM i.student_number
    FROM history_imports i JOIN students s ON s.district_id = i.district_id JOIN schools sc ON sc.id = s.school_id
   WHERE i.id = p_import AND i.district_id = eduos_ctx_district() AND eduos_history_import_office(i.school_id)
     AND coalesce(eduos_records_office_for(s.school_id), false)
     AND (lower(btrim(s.display_name)) = lower(btrim(i.student_name)) OR (i.student_number IS NOT NULL AND s.local_student_number = i.student_number))
   ORDER BY 6 DESC, 7 DESC, s.display_name LIMIT 10
$$;

-- Confirm the sender's fingerprint and choose the local student.
CREATE FUNCTION eduos_history_import_confirm(p_import uuid, p_fingerprint text, p_student uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i history_imports%ROWTYPE; s students%ROWTYPE;
BEGIN
  SELECT * INTO i FROM history_imports WHERE id = p_import AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_history_import_office(i.school_id) THEN RETURN 'not_found'; END IF;
  IF i.status <> 'received' THEN RETURN 'already_confirmed'; END IF;
  IF lower(regexp_replace(coalesce(p_fingerprint, ''), '[^0-9A-Fa-f]', '', 'g')) <> i.sender_fingerprint THEN RETURN 'fingerprint_mismatch'; END IF;
  SELECT * INTO s FROM students WHERE id = p_student AND district_id = i.district_id;
  IF NOT FOUND OR NOT coalesce(eduos_records_office_for(s.school_id), false) THEN RETURN 'student_not_found'; END IF;
  UPDATE history_imports SET student_id = s.id, school_id = s.school_id, status = 'reviewing', confirmed_by = eduos_ctx_user(), confirmed_at = now()
   WHERE id = i.id;
  RETURN 'reviewing';
END $$;

-- Accept or reject one item. Accepting adds it to the student's history as a
-- published item with its origin; the same decision again changes nothing.
CREATE FUNCTION eduos_history_import_decide(p_import uuid, p_pos integer, p_accept boolean, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i history_imports%ROWTYPE; it history_import_items%ROWTYPE; v jsonb; eid uuid; aud text; fam boolean;
BEGIN
  SELECT * INTO i FROM history_imports WHERE id = p_import AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_history_import_office(i.school_id) THEN RETURN 'not_found'; END IF;
  IF i.status = 'received' THEN RETURN 'not_confirmed'; END IF;
  SELECT * INTO it FROM history_import_items WHERE import_id = i.id AND pos = p_pos FOR UPDATE;
  IF NOT FOUND THEN RETURN 'item_not_found'; END IF;
  IF it.decision <> 'pending' THEN
    RETURN CASE WHEN (it.decision = 'accepted') = p_accept THEN 'unchanged' ELSE 'already_decided' END;
  END IF;
  IF i.status <> 'reviewing' THEN RETURN 'closed'; END IF;
  IF NOT p_accept THEN
    UPDATE history_import_items SET decision = 'rejected', decided_by = eduos_ctx_user(), decided_at = now(), decision_note = p_note
     WHERE import_id = i.id AND pos = p_pos;
  ELSIF EXISTS (SELECT 1 FROM history_import_items x JOIN history_imports y ON y.id = x.import_id
                 WHERE y.district_id = i.district_id AND y.student_id = i.student_id AND y.source_district_id = i.source_district_id
                   AND x.source_entry_id = it.source_entry_id AND x.source_revision = it.source_revision AND x.decision = 'accepted') THEN
    UPDATE history_import_items SET decision = 'rejected', decided_by = eduos_ctx_user(), decided_at = now(),
           decision_note = 'Already in this student''s history from an earlier transfer'
     WHERE import_id = i.id AND pos = p_pos;
    IF NOT EXISTS (SELECT 1 FROM history_import_items WHERE import_id = i.id AND decision = 'pending') THEN
      UPDATE history_imports SET status = 'completed', closed_by = eduos_ctx_user(), closed_at = now() WHERE id = i.id;
    END IF;
    RETURN 'duplicate';
  ELSE
    v := it.item;
    fam := v->>'kind' IN ('family_memory','student_portfolio');
    aud := v->>'audience';
    IF aud IS NULL OR aud NOT IN ('student','family','classroom','school') OR (fam AND aud NOT IN ('student','family')) THEN aud := 'family'; END IF;
    INSERT INTO student_history_entries(district_id, school_id, student_id, entry_type, classification, title, body, occurred_at, school_year,
        audience, status, source_type, source_reference, author_user_id)
      VALUES (i.district_id, i.school_id, i.student_id, v->>'type', v->>'kind', v->>'title', coalesce(v->>'body', ''), (v->>'occurredAt')::timestamptz,
        nullif(v->>'schoolYear', ''), aud, 'published', v->>'source',
        left('Transferred from ' || i.source_district_name || CASE WHEN i.source_school_name <> '' THEN ', ' || i.source_school_name ELSE '' END, 256), NULL)
      RETURNING id INTO eid;
    UPDATE history_import_items SET decision = 'accepted', decided_by = eduos_ctx_user(), decided_at = now(), decision_note = p_note, entry_id = eid
     WHERE import_id = i.id AND pos = p_pos;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM history_import_items WHERE import_id = i.id AND decision = 'pending') THEN
    UPDATE history_imports SET status = 'completed', closed_by = eduos_ctx_user(), closed_at = now() WHERE id = i.id;
  END IF;
  RETURN CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END;
END $$;

-- Finish: reject whatever is still waiting (or the whole package, before it's
-- confirmed), with a reason.
CREATE FUNCTION eduos_history_import_close(p_import uuid, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i history_imports%ROWTYPE; st text;
BEGIN
  SELECT * INTO i FROM history_imports WHERE id = p_import AND district_id = eduos_ctx_district() FOR UPDATE;
  IF NOT FOUND OR NOT eduos_history_import_office(i.school_id) THEN RETURN 'not_found'; END IF;
  IF i.status IN ('completed','rejected') THEN RETURN 'closed'; END IF;
  UPDATE history_import_items SET decision = 'rejected', decided_by = eduos_ctx_user(), decided_at = now(), decision_note = p_note
   WHERE import_id = i.id AND decision = 'pending';
  st := CASE WHEN EXISTS (SELECT 1 FROM history_import_items WHERE import_id = i.id AND decision = 'accepted') THEN 'completed' ELSE 'rejected' END;
  UPDATE history_imports SET status = st, closed_by = eduos_ctx_user(), closed_at = now(), close_note = p_note WHERE id = i.id;
  RETURN st;
END $$;

-- Where transferred items came from, for items the caller can already see.
CREATE FUNCTION eduos_history_entry_origins(p_entries uuid[]) RETURNS TABLE(entry_id uuid, district_name text, school_name text, author_name text, accepted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.entry_id, i.source_district_name, i.source_school_name, x.item->>'author', x.decided_at
    FROM history_import_items x JOIN history_imports i ON i.id = x.import_id
   WHERE x.entry_id = ANY(p_entries) AND x.district_id = eduos_ctx_district()
$$;

REVOKE ALL ON FUNCTION eduos_history_import_office(uuid), eduos_history_import_receive(text, text, jsonb, jsonb, jsonb), eduos_history_import_candidates(uuid),
  eduos_history_import_confirm(uuid, text, uuid), eduos_history_import_decide(uuid, integer, boolean, text), eduos_history_import_close(uuid, text),
  eduos_history_entry_origins(uuid[]) FROM PUBLIC;

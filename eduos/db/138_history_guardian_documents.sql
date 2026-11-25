-- TC-02: guardian plain-text document contributions.
-- This deliberately supports only inert UTF-8 text. PDF, DOCX, HTML, archives,
-- and video remain unsupported until their sanitizers are independently vetted.
ALTER TABLE private_media_objects DROP CONSTRAINT IF EXISTS private_media_objects_media_kind_check;
ALTER TABLE private_media_objects ADD CONSTRAINT private_media_objects_media_kind_check
  CHECK (media_kind IN ('image','video','document'));

ALTER TABLE district_history_media_policies
  ADD COLUMN documents_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN max_document_bytes integer NOT NULL DEFAULT 1048576
    CHECK (max_document_bytes BETWEEN 1024 AND 5242880),
  ADD COLUMN max_documents_per_contribution integer NOT NULL DEFAULT 5
    CHECK (max_documents_per_contribution BETWEEN 1 AND 10);

CREATE TABLE student_history_contribution_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  contribution_id uuid NOT NULL,
  asset_id uuid NOT NULL UNIQUE,
  file_name text NOT NULL CHECK (file_name ~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.txt$'),
  upload_key text CHECK (upload_key IS NULL OR upload_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, uploaded_by) REFERENCES district_users(district_id, user_id),
  FOREIGN KEY (district_id, school_id, asset_id) REFERENCES private_media_objects(district_id, school_id, asset_id) ON DELETE RESTRICT,
  FOREIGN KEY (district_id, school_id, student_id, contribution_id)
    REFERENCES student_history_contributions(district_id, school_id, student_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX student_history_contribution_documents_key
  ON student_history_contribution_documents(district_id, contribution_id, upload_key)
  WHERE upload_key IS NOT NULL;
CREATE INDEX student_history_contribution_documents_student
  ON student_history_contribution_documents(district_id, student_id);
ALTER TABLE student_history_contribution_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_history_contribution_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_functions ON student_history_contribution_documents
  USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- Extend the same per-student quota already used by photos; donations never
-- affect this district-set limit.
CREATE OR REPLACE FUNCTION eduos_history_student_media_bytes(p_district uuid, p_student uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(o.byte_size), 0)::bigint FROM private_media_objects o
   WHERE o.district_id = p_district AND o.purpose = 'history'
     AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed'
     AND o.asset_id IN (
       SELECT asset_id FROM student_history_entry_attachments WHERE district_id = p_district AND student_id = p_student
       UNION SELECT asset_id FROM student_history_contribution_photos WHERE district_id = p_district AND student_id = p_student
       UNION SELECT asset_id FROM student_history_contribution_documents WHERE district_id = p_district AND student_id = p_student
       UNION SELECT asset_id FROM student_time_capsule_photos WHERE district_id = p_district AND student_id = p_student
     )
$$;
REVOKE ALL ON FUNCTION eduos_history_student_media_bytes(uuid, uuid) FROM PUBLIC;


-- The family dashboard's usage must include documents and capsule photos too.
CREATE OR REPLACE FUNCTION eduos_history_family_storage(p_student uuid)
RETURNS TABLE(used_bytes bigint, photos bigint, archived_photos bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $family_storage$
DECLARE s record;
BEGIN
  SELECT st.id, st.district_id INTO s FROM students st
   WHERE st.id = p_student AND st.district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT (eduos_is_student_self(s.id) OR
      (eduos_is_linked_guardian(s.id) AND NOT eduos_student_holds_rights(s.id))) THEN
    RAISE EXCEPTION 'student_not_found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
  WITH links AS (
    SELECT asset_id FROM student_history_entry_attachments WHERE district_id=s.district_id AND student_id=s.id
    UNION SELECT asset_id FROM student_history_contribution_photos WHERE district_id=s.district_id AND student_id=s.id
    UNION SELECT asset_id FROM student_history_contribution_documents WHERE district_id=s.district_id AND student_id=s.id
    UNION SELECT asset_id FROM student_time_capsule_photos WHERE district_id=s.district_id AND student_id=s.id
  )
  SELECT coalesce(sum(o.byte_size),0)::bigint,
         count(*) FILTER (WHERE o.media_kind='image')::bigint,
         count(*) FILTER (WHERE o.media_kind='image' AND o.storage_tier='archive')::bigint
    FROM links l JOIN private_media_objects o ON o.asset_id=l.asset_id AND o.district_id=s.district_id
   WHERE o.purpose='history' AND o.scan_status<>'blocked' AND o.processing_status<>'failed';
END
$family_storage$;
REVOKE ALL ON FUNCTION eduos_history_family_storage(uuid) FROM PUBLIC;

CREATE FUNCTION eduos_history_contribution_document_begin(
  p_contribution uuid, p_asset uuid, p_storage_key text, p_bytes bigint,
  p_file_name text, p_upload_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c student_history_contributions%ROWTYPE; pol district_history_media_policies%ROWTYPE;
        used bigint; n int; existing record;
BEGIN
  SELECT * INTO c FROM student_history_contributions
   WHERE id = p_contribution AND district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT eduos_history_contribution_mine(p_contribution)
    THEN RETURN jsonb_build_object('error','contribution_not_found'); END IF;
  IF c.status <> 'submitted' THEN RETURN jsonb_build_object('error','contribution_not_editable'); END IF;
  IF p_upload_key IS NOT NULL THEN
    SELECT d.asset_id INTO existing FROM student_history_contribution_documents d
     WHERE d.district_id=c.district_id AND d.contribution_id=c.id AND d.upload_key=p_upload_key;
    IF FOUND THEN RETURN jsonb_build_object('assetId',existing.asset_id,'existing',true,
      'status',(SELECT processing_status FROM private_media_objects WHERE asset_id=existing.asset_id)); END IF;
  END IF;
  SELECT * INTO pol FROM district_history_media_policies WHERE district_id=c.district_id;
  IF NOT FOUND OR NOT pol.documents_enabled THEN RETURN jsonb_build_object('error','documents_not_enabled'); END IF;
  IF p_bytes < 1 OR p_bytes > pol.max_document_bytes
    THEN RETURN jsonb_build_object('error','document_too_large','maxBytes',pol.max_document_bytes); END IF;
  IF p_file_name !~ '^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.txt$'
    THEN RETURN jsonb_build_object('error','invalid_document_name'); END IF;
  -- Serialize per-student reservations before both count and byte checks so
  -- concurrent uploads cannot exceed either district-controlled limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('history-media:'||c.student_id::text,0));
  SELECT count(*) INTO n FROM student_history_contribution_documents d
    JOIN private_media_objects o ON o.asset_id=d.asset_id
   WHERE d.district_id=c.district_id AND d.contribution_id=c.id
     AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed';
  IF n >= pol.max_documents_per_contribution
    THEN RETURN jsonb_build_object('error','too_many_documents','max',pol.max_documents_per_contribution); END IF;
  used := eduos_history_student_media_bytes(c.district_id,c.student_id);
  IF used+p_bytes > pol.max_bytes_per_student
    THEN RETURN jsonb_build_object('error','student_storage_full','usedBytes',used,'maxBytes',pol.max_bytes_per_student); END IF;
  INSERT INTO private_media_objects(asset_id,district_id,school_id,storage_key,media_kind,mime_type,byte_size,purpose)
    VALUES(p_asset,c.district_id,c.school_id,p_storage_key,'document','text/plain; charset=utf-8',p_bytes,'history');
  INSERT INTO student_history_contribution_documents(district_id,school_id,student_id,contribution_id,asset_id,file_name,upload_key,uploaded_by)
    VALUES(c.district_id,c.school_id,c.student_id,c.id,p_asset,p_file_name,p_upload_key,eduos_ctx_user());
  RETURN jsonb_build_object('assetId',p_asset,'studentId',c.student_id);
END $$;

CREATE FUNCTION eduos_history_contribution_document_set(
  p_asset uuid,p_storage_key text,p_bytes bigint,p_scan text,p_processing text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d record;
BEGIN
  SELECT x.contribution_id,c.status INTO d
    FROM student_history_contribution_documents x
    JOIN student_history_contributions c ON c.id=x.contribution_id AND c.district_id=x.district_id
   WHERE x.asset_id=p_asset AND x.district_id=eduos_ctx_district()
   FOR UPDATE OF c;
  IF NOT FOUND OR d.status <> 'submitted' OR NOT eduos_history_contribution_mine(d.contribution_id) THEN RETURN false; END IF;
  UPDATE private_media_objects SET storage_key=coalesce(p_storage_key,storage_key),
    byte_size=coalesce(p_bytes,byte_size),scan_status=p_scan,processing_status=p_processing,updated_at=now()
   WHERE asset_id=p_asset AND district_id=eduos_ctx_district() AND processing_status='pending';
  RETURN FOUND;
END $;

-- Pending documents are visible only to the submitting guardian and assigned
-- school reviewer. Once approved, the ordinary history-entry audience check
-- governs access; rejected/withdrawn documents are never readable.
CREATE FUNCTION eduos_history_contribution_document_get(p_asset uuid)
RETURNS TABLE(asset_id uuid,contribution_id uuid,storage_key text,file_name text,mime_type text,
              byte_size bigint,scan_status text,processing_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.asset_id,d.contribution_id,o.storage_key,d.file_name,o.mime_type,o.byte_size,o.scan_status,o.processing_status
    FROM student_history_contribution_documents d
    JOIN private_media_objects o ON o.asset_id=d.asset_id AND o.district_id=d.district_id
    JOIN student_history_contributions c ON c.id=d.contribution_id AND c.district_id=d.district_id
   WHERE d.asset_id=p_asset AND d.district_id=eduos_ctx_district()
     AND c.status IN ('submitted','approved')
     AND ((c.status='submitted' AND (eduos_history_contribution_mine(c.id) OR eduos_history_contribution_reviewer(c.id)))
       OR (c.status='approved' AND c.history_entry_id IS NOT NULL
           AND eduos_history_entry_access(c.history_entry_id,'read')))
$$;

CREATE FUNCTION eduos_history_contribution_documents_release(p_contribution uuid)
RETURNS TABLE(storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c student_history_contributions%ROWTYPE;
BEGIN
  SELECT * INTO c FROM student_history_contributions
   WHERE id=p_contribution AND district_id=eduos_ctx_district();
  IF NOT FOUND OR c.status NOT IN ('rejected','withdrawn') THEN RETURN; END IF;
  IF NOT (eduos_history_contribution_reviewer(p_contribution)
      OR (c.guardian_user_id=eduos_ctx_user() AND eduos_ctx_role()='parent')) THEN RETURN; END IF;
  RETURN QUERY UPDATE private_media_objects o SET processing_status='failed',updated_at=now()
    FROM student_history_contribution_documents d
   WHERE d.asset_id=o.asset_id AND d.contribution_id=c.id AND o.district_id=c.district_id
     AND o.processing_status<>'failed'
  RETURNING o.storage_key;
END $$;


CREATE FUNCTION eduos_history_contribution_documents(p_contributions uuid[])
RETURNS TABLE(contribution_id uuid,asset_id uuid,file_name text,byte_size bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $doc$
  SELECT d.contribution_id,d.asset_id,d.file_name,o.byte_size
    FROM student_history_contribution_documents d
    JOIN private_media_objects o ON o.asset_id=d.asset_id AND o.district_id=d.district_id
    JOIN student_history_contributions c ON c.id=d.contribution_id AND c.district_id=d.district_id
   WHERE d.district_id=eduos_ctx_district() AND d.contribution_id=ANY(p_contributions)
     AND o.scan_status='clean' AND o.processing_status='processed'
     AND c.status IN ('submitted','approved')
     AND ((c.status='submitted' AND (eduos_history_contribution_mine(c.id) OR eduos_history_contribution_reviewer(c.id)))
       OR (c.status='approved' AND c.history_entry_id IS NOT NULL
           AND eduos_history_entry_access(c.history_entry_id,'read')))
   ORDER BY d.contribution_id,d.created_at
$doc$;


CREATE FUNCTION eduos_history_entry_documents(p_entries uuid[])
RETURNS TABLE(entry_id uuid,asset_id uuid,file_name text,byte_size bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $entry_docs$
  SELECT c.history_entry_id,d.asset_id,d.file_name,o.byte_size
    FROM student_history_contribution_documents d
    JOIN student_history_contributions c ON c.id=d.contribution_id AND c.district_id=d.district_id
    JOIN private_media_objects o ON o.asset_id=d.asset_id AND o.district_id=d.district_id
   WHERE d.district_id=eduos_ctx_district() AND c.status='approved'
     AND c.history_entry_id=ANY(p_entries)
     AND o.scan_status='clean' AND o.processing_status='processed'
     AND eduos_history_entry_access(c.history_entry_id,'read')
   ORDER BY c.history_entry_id,d.created_at
$entry_docs$;

REVOKE ALL ON FUNCTION eduos_history_entry_documents(uuid[]), eduos_history_contribution_documents(uuid[]),
  eduos_history_contribution_document_begin(uuid,uuid,text,bigint,text,text),
  eduos_history_contribution_document_set(uuid,text,bigint,text,text),
  eduos_history_contribution_document_get(uuid),
  eduos_history_contribution_documents_release(uuid) FROM PUBLIC;

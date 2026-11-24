-- MEDIA-01: photos on student history items, in private S3-compatible storage,
-- scanned by ClamAV and re-encoded before anyone sees them.
--
-- The district sets the limits (photos on or off, size per photo, photos per
-- item, total per student); they are independent of anything else. A photo
-- is added to an item its author can still change (a draft), uploaded by the
-- browser straight to the bucket with a short presigned link, then checked:
-- size and type match, ClamAV says clean, the image decodes as what it claims,
-- it is re-encoded (dropping EXIF/GPS and everything else that isn't the
-- picture), and the result is scanned again. Only the processed photo is ever
-- stored: the server receives the upload, checks it and writes the result to
-- the private bucket (no browser access to the bucket, no bucket CORS). It is
-- shown only to people who can see the item, through a 60-second link.

CREATE TABLE district_history_media_policies (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  images_enabled boolean NOT NULL DEFAULT false,
  max_image_bytes integer NOT NULL DEFAULT 10485760 CHECK (max_image_bytes BETWEEN 102400 AND 20971520),
  max_per_entry integer NOT NULL DEFAULT 6 CHECK (max_per_entry BETWEEN 1 AND 20),
  max_bytes_per_student bigint NOT NULL DEFAULT 262144000 CHECK (max_bytes_per_student BETWEEN 1048576 AND 5368709120),
  set_by uuid NOT NULL REFERENCES users(id),
  set_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE district_history_media_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_history_media_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON district_history_media_policies
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
CREATE POLICY scope_write ON district_history_media_policies AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND set_by = eduos_ctx_user()));
CREATE POLICY scope_update ON district_history_media_policies AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent') WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent');

ALTER TABLE student_history_entry_attachments
  ADD COLUMN alt_text text NOT NULL DEFAULT '' CHECK (length(alt_text) <= 300),
  ADD COLUMN upload_key text CHECK (upload_key IS NULL OR upload_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  ADD COLUMN uploaded_by uuid REFERENCES users(id),
  ADD COLUMN width integer,
  ADD COLUMN height integer;
CREATE UNIQUE INDEX student_history_attachments_upload_key ON student_history_entry_attachments(district_id, entry_id, upload_key) WHERE upload_key IS NOT NULL;

-- The media registry was built for club and team media: every object had to
-- be an activity asset (db/055). Objects now say what they belong to, and the
-- activity guarantee still holds for activity objects.
ALTER TABLE private_media_objects ADD COLUMN purpose text NOT NULL DEFAULT 'activity' CHECK (purpose IN ('activity','history'));
ALTER TABLE private_media_objects ADD COLUMN activity_asset_id uuid GENERATED ALWAYS AS (CASE WHEN purpose = 'activity' THEN asset_id END) STORED;
ALTER TABLE private_media_objects DROP CONSTRAINT private_media_object_asset_school_fk;
ALTER TABLE private_media_objects ADD CONSTRAINT private_media_object_asset_school_fk
  FOREIGN KEY (district_id, school_id, activity_asset_id) REFERENCES activity_media_assets(district_id, school_id, id);

-- The media registry's school-scope policy (db/056) has no owner path; the
-- functions below run as the owner on behalf of people whose session school
-- may differ (a guardian, the superintendent).
CREATE POLICY owner_functions ON private_media_objects USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- Reserve a photo on an item the caller can change, before it is published
-- (a draft, or submitted for review). Checks the
-- district's limits and the student's total (failed or blocked photos don't
-- count). Idempotent per upload key.
CREATE FUNCTION eduos_history_media_begin(p_entry uuid, p_asset uuid, p_storage_key text, p_mime text, p_bytes bigint,
  p_caption text, p_alt text, p_upload_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE e student_history_entries%ROWTYPE; pol district_history_media_policies%ROWTYPE; used bigint; n int; existing record; att uuid;
BEGIN
  SELECT * INTO e FROM student_history_entries WHERE id = p_entry AND district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT eduos_history_entry_access(p_entry, 'manage') THEN RETURN jsonb_build_object('error', 'entry_not_found'); END IF;
  IF e.status NOT IN ('draft','submitted') THEN RETURN jsonb_build_object('error', 'entry_not_editable'); END IF;
  IF p_upload_key IS NOT NULL THEN
    SELECT a.id, a.asset_id INTO existing FROM student_history_entry_attachments a WHERE a.district_id = e.district_id AND a.entry_id = e.id AND a.upload_key = p_upload_key;
    IF FOUND THEN RETURN jsonb_build_object('assetId', existing.asset_id, 'attachmentId', existing.id, 'existing', true,
      'status', (SELECT processing_status FROM private_media_objects WHERE asset_id = existing.asset_id)); END IF;
  END IF;
  SELECT * INTO pol FROM district_history_media_policies WHERE district_id = e.district_id;
  IF NOT FOUND OR NOT pol.images_enabled THEN RETURN jsonb_build_object('error', 'photos_not_enabled'); END IF;
  IF p_bytes > pol.max_image_bytes THEN RETURN jsonb_build_object('error', 'photo_too_large', 'maxBytes', pol.max_image_bytes); END IF;
  SELECT count(*) INTO n FROM student_history_entry_attachments a JOIN private_media_objects o ON o.asset_id = a.asset_id
   WHERE a.district_id = e.district_id AND a.entry_id = e.id AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed';
  IF n >= pol.max_per_entry THEN RETURN jsonb_build_object('error', 'too_many_photos', 'max', pol.max_per_entry); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('history-media:' || e.student_id::text, 0));
  SELECT coalesce(sum(o.byte_size), 0) INTO used FROM student_history_entry_attachments a JOIN private_media_objects o ON o.asset_id = a.asset_id
   WHERE a.district_id = e.district_id AND a.student_id = e.student_id AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed';
  IF used + p_bytes > pol.max_bytes_per_student THEN RETURN jsonb_build_object('error', 'student_storage_full', 'usedBytes', used, 'maxBytes', pol.max_bytes_per_student); END IF;
  INSERT INTO private_media_objects(asset_id, district_id, school_id, storage_key, media_kind, mime_type, byte_size, purpose)
    VALUES (p_asset, e.district_id, e.school_id, p_storage_key, 'image', p_mime, p_bytes, 'history');
  INSERT INTO student_history_entry_attachments(district_id, school_id, student_id, entry_id, asset_id, caption, alt_text, position, upload_key, uploaded_by)
    VALUES (e.district_id, e.school_id, e.student_id, e.id, p_asset, coalesce(p_caption, ''), coalesce(p_alt, ''),
            coalesce((SELECT max(position) + 1 FROM student_history_entry_attachments WHERE district_id = e.district_id AND entry_id = e.id), 0),
            p_upload_key, eduos_ctx_user())
    RETURNING id INTO att;
  RETURN jsonb_build_object('assetId', p_asset, 'attachmentId', att, 'studentId', e.student_id);
END $$;

-- A photo's storage record, for someone who may 'read' (see the item) or
-- 'manage' (change it). Storage keys go to the server only.
CREATE FUNCTION eduos_history_media_get(p_asset uuid, p_need text)
RETURNS TABLE(asset_id uuid, entry_id uuid, storage_key text, mime_type text, byte_size bigint, scan_status text, processing_status text, entry_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.asset_id, a.entry_id, o.storage_key, o.mime_type, o.byte_size, o.scan_status, o.processing_status, e.status
    FROM student_history_entry_attachments a JOIN private_media_objects o ON o.asset_id = a.asset_id AND o.district_id = a.district_id
    JOIN student_history_entries e ON e.id = a.entry_id
   WHERE o.asset_id = p_asset AND a.district_id = eduos_ctx_district() AND p_need IN ('read','manage')
     AND eduos_history_entry_access(a.entry_id, p_need)
$$;

-- Record the outcome of the checks (the caller must still manage the item).
CREATE FUNCTION eduos_history_media_set(p_asset uuid, p_storage_key text, p_bytes bigint, p_scan text, p_processing text, p_width int, p_height int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a record;
BEGIN
  SELECT x.entry_id INTO a FROM student_history_entry_attachments x WHERE x.asset_id = p_asset AND x.district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT eduos_history_entry_access(a.entry_id, 'manage') THEN RETURN false; END IF;
  UPDATE private_media_objects SET storage_key = coalesce(p_storage_key, storage_key), byte_size = coalesce(p_bytes, byte_size),
         scan_status = p_scan, processing_status = p_processing, updated_at = now()
   WHERE asset_id = p_asset AND district_id = eduos_ctx_district();
  UPDATE student_history_entry_attachments SET width = p_width, height = p_height WHERE asset_id = p_asset AND district_id = eduos_ctx_district();
  RETURN true;
END $$;

-- The attachments table is otherwise insert-only for the runtime role; the
-- dimensions are written by eduos_history_media_set as the owner.
REVOKE ALL ON FUNCTION eduos_history_media_begin(uuid, uuid, text, text, bigint, text, text, text), eduos_history_media_get(uuid, text),
  eduos_history_media_set(uuid, text, bigint, text, text, int, int) FROM PUBLIC;

-- The ready photos of the given items, for whoever can see each item.
CREATE FUNCTION eduos_history_entry_photos(p_entries uuid[])
RETURNS TABLE(entry_id uuid, asset_id uuid, caption text, alt_text text, width int, height int, pos int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.entry_id, a.asset_id, a.caption, a.alt_text, a.width, a.height, a.position
    FROM student_history_entry_attachments a JOIN private_media_objects o ON o.asset_id = a.asset_id AND o.district_id = a.district_id
   WHERE a.district_id = eduos_ctx_district() AND a.entry_id = ANY (p_entries)
     AND o.scan_status = 'clean' AND o.processing_status = 'processed'
     AND eduos_history_entry_access(a.entry_id, 'read')
   ORDER BY a.entry_id, a.position
$$;
REVOKE ALL ON FUNCTION eduos_history_entry_photos(uuid[]) FROM PUBLIC;

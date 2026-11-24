-- MEDIA-02 (TC-02): family photos on guardian contributions.
--
-- A guardian adds photos to a family memory they've sent for review, through
-- the same checks as MEDIA-01 (district limits, ClamAV, decode, re-encode
-- without EXIF/GPS, ClamAV again; only the processed copy stored). The
-- school's reviewer sees them while reviewing. Approval carries the photos
-- onto the published family memory, where exactly the people who can see that
-- memory see them. A rejected or withdrawn contribution's photos are released:
-- marked failed (they stop counting) and deleted from the bucket.

CREATE TABLE student_history_contribution_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  contribution_id uuid NOT NULL REFERENCES student_history_contributions(id),
  asset_id uuid NOT NULL UNIQUE,
  caption text NOT NULL DEFAULT '' CHECK (length(caption) <= 500),
  alt_text text NOT NULL CHECK (length(alt_text) BETWEEN 3 AND 300),
  position integer NOT NULL DEFAULT 0,
  upload_key text CHECK (upload_key IS NULL OR upload_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  width integer,
  height integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id)
);
CREATE UNIQUE INDEX student_history_contribution_photos_key ON student_history_contribution_photos(district_id, contribution_id, upload_key) WHERE upload_key IS NOT NULL;
CREATE INDEX student_history_contribution_photos_student ON student_history_contribution_photos(district_id, student_id);
-- Reached only through the functions below.
ALTER TABLE student_history_contribution_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_history_contribution_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_functions ON student_history_contribution_photos USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- Everything stored for a student (entry and contribution photos, each object
-- once), not counting failed or blocked ones.
CREATE FUNCTION eduos_history_student_media_bytes(p_district uuid, p_student uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(o.byte_size), 0)::bigint FROM private_media_objects o
   WHERE o.district_id = p_district AND o.purpose = 'history' AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed'
     AND o.asset_id IN (SELECT asset_id FROM student_history_entry_attachments WHERE district_id = p_district AND student_id = p_student
                        UNION SELECT asset_id FROM student_history_contribution_photos WHERE district_id = p_district AND student_id = p_student)
$$;
REVOKE ALL ON FUNCTION eduos_history_student_media_bytes(uuid, uuid) FROM PUBLIC;

-- Entry photos now count contribution photos in the student's total.
CREATE OR REPLACE FUNCTION eduos_history_media_begin(p_entry uuid, p_asset uuid, p_storage_key text, p_mime text, p_bytes bigint,
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
  used := eduos_history_student_media_bytes(e.district_id, e.student_id);
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

-- Is the caller the guardian who sent this (still pending) contribution?
CREATE FUNCTION eduos_history_contribution_mine(p_contribution uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM student_history_contributions c
    JOIN student_user_links l ON l.district_id = c.district_id AND l.student_id = c.student_id AND l.user_id = c.guardian_user_id
         AND l.status = 'active' AND l.relationship IN ('parent','guardian')
   WHERE c.id = p_contribution AND c.district_id = eduos_ctx_district() AND c.guardian_user_id = eduos_ctx_user()
     AND eduos_ctx_role() = 'parent' AND NOT eduos_custody_blocked(c.student_id, eduos_ctx_user()))
$$;
-- May the caller review it (the school's principal, a vice principal acting as one, or the superintendent)?
CREATE FUNCTION eduos_history_contribution_reviewer(p_contribution uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM student_history_contributions c WHERE c.id = p_contribution AND c.district_id = eduos_ctx_district()
     AND (eduos_ctx_role() = 'superintendent' OR (eduos_ctx_role() = 'principal' AND c.school_id = eduos_ctx_school())))
$$;

-- Reserve a photo on the caller's own pending contribution.
CREATE FUNCTION eduos_history_contribution_photo_begin(p_contribution uuid, p_asset uuid, p_storage_key text, p_mime text, p_bytes bigint,
  p_caption text, p_alt text, p_upload_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c student_history_contributions%ROWTYPE; pol district_history_media_policies%ROWTYPE; used bigint; n int; existing record;
BEGIN
  SELECT * INTO c FROM student_history_contributions WHERE id = p_contribution AND district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT eduos_history_contribution_mine(p_contribution) THEN RETURN jsonb_build_object('error', 'contribution_not_found'); END IF;
  IF c.status <> 'submitted' THEN RETURN jsonb_build_object('error', 'contribution_not_editable'); END IF;
  IF p_upload_key IS NOT NULL THEN
    SELECT p.asset_id INTO existing FROM student_history_contribution_photos p WHERE p.district_id = c.district_id AND p.contribution_id = c.id AND p.upload_key = p_upload_key;
    IF FOUND THEN RETURN jsonb_build_object('assetId', existing.asset_id, 'existing', true,
      'status', (SELECT processing_status FROM private_media_objects WHERE asset_id = existing.asset_id)); END IF;
  END IF;
  SELECT * INTO pol FROM district_history_media_policies WHERE district_id = c.district_id;
  IF NOT FOUND OR NOT pol.images_enabled THEN RETURN jsonb_build_object('error', 'photos_not_enabled'); END IF;
  IF p_bytes > pol.max_image_bytes THEN RETURN jsonb_build_object('error', 'photo_too_large', 'maxBytes', pol.max_image_bytes); END IF;
  SELECT count(*) INTO n FROM student_history_contribution_photos p JOIN private_media_objects o ON o.asset_id = p.asset_id
   WHERE p.district_id = c.district_id AND p.contribution_id = c.id AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed';
  IF n >= pol.max_per_entry THEN RETURN jsonb_build_object('error', 'too_many_photos', 'max', pol.max_per_entry); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('history-media:' || c.student_id::text, 0));
  used := eduos_history_student_media_bytes(c.district_id, c.student_id);
  IF used + p_bytes > pol.max_bytes_per_student THEN RETURN jsonb_build_object('error', 'student_storage_full', 'usedBytes', used, 'maxBytes', pol.max_bytes_per_student); END IF;
  INSERT INTO private_media_objects(asset_id, district_id, school_id, storage_key, media_kind, mime_type, byte_size, purpose)
    VALUES (p_asset, c.district_id, c.school_id, p_storage_key, 'image', p_mime, p_bytes, 'history');
  INSERT INTO student_history_contribution_photos(district_id, school_id, student_id, contribution_id, asset_id, caption, alt_text, position, upload_key, uploaded_by)
    VALUES (c.district_id, c.school_id, c.student_id, c.id, p_asset, coalesce(p_caption, ''), p_alt,
            coalesce((SELECT max(position) + 1 FROM student_history_contribution_photos WHERE district_id = c.district_id AND contribution_id = c.id), 0),
            p_upload_key, eduos_ctx_user());
  RETURN jsonb_build_object('assetId', p_asset, 'studentId', c.student_id);
END $$;

-- Record the checks' outcome (the guardian, while it's still pending).
CREATE FUNCTION eduos_history_contribution_photo_set(p_asset uuid, p_storage_key text, p_bytes bigint, p_scan text, p_processing text, p_width int, p_height int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record;
BEGIN
  SELECT x.contribution_id INTO p FROM student_history_contribution_photos x WHERE x.asset_id = p_asset AND x.district_id = eduos_ctx_district();
  IF NOT FOUND OR NOT eduos_history_contribution_mine(p.contribution_id) THEN RETURN false; END IF;
  UPDATE private_media_objects SET storage_key = coalesce(p_storage_key, storage_key), byte_size = coalesce(p_bytes, byte_size),
         scan_status = p_scan, processing_status = p_processing, updated_at = now()
   WHERE asset_id = p_asset AND district_id = eduos_ctx_district();
  UPDATE student_history_contribution_photos SET width = p_width, height = p_height WHERE asset_id = p_asset AND district_id = eduos_ctx_district();
  RETURN true;
END $$;

-- A contribution photo's storage record, for its guardian or the school's reviewer.
CREATE FUNCTION eduos_history_contribution_photo_get(p_asset uuid)
RETURNS TABLE(asset_id uuid, contribution_id uuid, storage_key text, scan_status text, processing_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.asset_id, p.contribution_id, o.storage_key, o.scan_status, o.processing_status
    FROM student_history_contribution_photos p JOIN private_media_objects o ON o.asset_id = p.asset_id AND o.district_id = p.district_id
   WHERE p.asset_id = p_asset AND p.district_id = eduos_ctx_district()
     AND (eduos_history_contribution_mine(p.contribution_id) OR eduos_history_contribution_reviewer(p.contribution_id))
$$;

-- The ready photos of contributions, for their guardian or the reviewer.
CREATE FUNCTION eduos_history_contribution_photos(p_contributions uuid[])
RETURNS TABLE(contribution_id uuid, asset_id uuid, caption text, alt_text text, width int, height int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.contribution_id, p.asset_id, p.caption, p.alt_text, p.width, p.height
    FROM student_history_contribution_photos p JOIN private_media_objects o ON o.asset_id = p.asset_id AND o.district_id = p.district_id
   WHERE p.district_id = eduos_ctx_district() AND p.contribution_id = ANY (p_contributions)
     AND o.scan_status = 'clean' AND o.processing_status = 'processed'
     AND (eduos_history_contribution_mine(p.contribution_id) OR eduos_history_contribution_reviewer(p.contribution_id))
   ORDER BY p.contribution_id, p.position
$$;

-- On approval: the ready photos go onto the published family memory.
CREATE FUNCTION eduos_history_contribution_photos_publish(p_contribution uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c student_history_contributions%ROWTYPE; n int;
BEGIN
  SELECT * INTO c FROM student_history_contributions WHERE id = p_contribution AND district_id = eduos_ctx_district();
  IF NOT FOUND OR c.status <> 'approved' OR c.history_entry_id IS NULL OR NOT eduos_history_contribution_reviewer(p_contribution) THEN RETURN 0; END IF;
  INSERT INTO student_history_entry_attachments(district_id, school_id, student_id, entry_id, asset_id, caption, alt_text, position, uploaded_by, width, height)
    SELECT p.district_id, p.school_id, p.student_id, c.history_entry_id, p.asset_id, p.caption, p.alt_text, p.position, p.uploaded_by, p.width, p.height
      FROM student_history_contribution_photos p JOIN private_media_objects o ON o.asset_id = p.asset_id AND o.district_id = p.district_id
     WHERE p.contribution_id = c.id AND p.district_id = c.district_id AND o.scan_status = 'clean' AND o.processing_status = 'processed'
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- On rejection or withdrawal: release the photos. Returns the keys to delete from the bucket.
CREATE FUNCTION eduos_history_contribution_photos_release(p_contribution uuid) RETURNS TABLE(storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c student_history_contributions%ROWTYPE;
BEGIN
  SELECT * INTO c FROM student_history_contributions WHERE id = p_contribution AND district_id = eduos_ctx_district();
  IF NOT FOUND OR c.status NOT IN ('rejected','withdrawn') THEN RETURN; END IF;
  IF NOT (eduos_history_contribution_reviewer(p_contribution) OR (c.guardian_user_id = eduos_ctx_user() AND eduos_ctx_role() = 'parent')) THEN RETURN; END IF;
  RETURN QUERY UPDATE private_media_objects o SET processing_status = 'failed', updated_at = now()
    FROM student_history_contribution_photos p
   WHERE p.asset_id = o.asset_id AND p.contribution_id = c.id AND o.district_id = c.district_id AND o.processing_status <> 'failed'
  RETURNING o.storage_key;
END $$;

REVOKE ALL ON FUNCTION eduos_history_contribution_mine(uuid), eduos_history_contribution_reviewer(uuid),
  eduos_history_contribution_photo_begin(uuid, uuid, text, text, bigint, text, text, text),
  eduos_history_contribution_photo_set(uuid, text, bigint, text, text, int, int), eduos_history_contribution_photo_get(uuid),
  eduos_history_contribution_photos(uuid[]), eduos_history_contribution_photos_publish(uuid), eduos_history_contribution_photos_release(uuid) FROM PUBLIC;

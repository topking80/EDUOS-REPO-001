-- MEDIA-03: photos in Time Capsules.
--
-- Two kinds, both through the MEDIA-01 checks:
--   * the owner's own photos, added to a draft capsule (beside its message);
--   * photos already on the history items placed in the capsule.
-- The owner sees them while drafting. Recipients see them only once the
-- capsule is released to them (eduos_capsule_access says 'recipient' only
-- then), exactly like the rest of the contents. Withheld items keep their
-- photos withheld. Cancelling a capsule releases the owner's own photos
-- (deleted from the bucket, no longer counted).

CREATE TABLE student_time_capsule_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  capsule_id uuid NOT NULL REFERENCES student_time_capsules(id),
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
CREATE UNIQUE INDEX student_time_capsule_photos_key ON student_time_capsule_photos(district_id, capsule_id, upload_key) WHERE upload_key IS NOT NULL;
CREATE INDEX student_time_capsule_photos_student ON student_time_capsule_photos(district_id, student_id);
ALTER TABLE student_time_capsule_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_time_capsule_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_functions ON student_time_capsule_photos USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- The student's total now counts capsule photos too.
CREATE OR REPLACE FUNCTION eduos_history_student_media_bytes(p_district uuid, p_student uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(sum(o.byte_size), 0)::bigint FROM private_media_objects o
   WHERE o.district_id = p_district AND o.purpose = 'history' AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed'
     AND o.asset_id IN (SELECT asset_id FROM student_history_entry_attachments WHERE district_id = p_district AND student_id = p_student
                        UNION SELECT asset_id FROM student_history_contribution_photos WHERE district_id = p_district AND student_id = p_student
                        UNION SELECT asset_id FROM student_time_capsule_photos WHERE district_id = p_district AND student_id = p_student)
$$;

-- Reserve a photo on the caller's own draft capsule.
CREATE FUNCTION eduos_capsule_photo_begin(p_capsule uuid, p_asset uuid, p_storage_key text, p_mime text, p_bytes bigint,
  p_caption text, p_alt text, p_upload_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c student_time_capsules%ROWTYPE; pol district_history_media_policies%ROWTYPE; used bigint; n int; existing record;
BEGIN
  SELECT * INTO c FROM student_time_capsules WHERE id = p_capsule AND district_id = eduos_ctx_district();
  IF NOT FOUND OR eduos_capsule_access(p_capsule) IS DISTINCT FROM 'owner' THEN RETURN jsonb_build_object('error', 'capsule_not_found'); END IF;
  IF c.status <> 'draft' THEN RETURN jsonb_build_object('error', 'capsule_not_a_draft'); END IF;
  IF p_upload_key IS NOT NULL THEN
    SELECT p.asset_id INTO existing FROM student_time_capsule_photos p WHERE p.district_id = c.district_id AND p.capsule_id = c.id AND p.upload_key = p_upload_key;
    IF FOUND THEN RETURN jsonb_build_object('assetId', existing.asset_id, 'existing', true,
      'status', (SELECT processing_status FROM private_media_objects WHERE asset_id = existing.asset_id)); END IF;
  END IF;
  SELECT * INTO pol FROM district_history_media_policies WHERE district_id = c.district_id;
  IF NOT FOUND OR NOT pol.images_enabled THEN RETURN jsonb_build_object('error', 'photos_not_enabled'); END IF;
  IF p_bytes > pol.max_image_bytes THEN RETURN jsonb_build_object('error', 'photo_too_large', 'maxBytes', pol.max_image_bytes); END IF;
  SELECT count(*) INTO n FROM student_time_capsule_photos p JOIN private_media_objects o ON o.asset_id = p.asset_id
   WHERE p.district_id = c.district_id AND p.capsule_id = c.id AND o.scan_status <> 'blocked' AND o.processing_status <> 'failed';
  IF n >= pol.max_per_entry THEN RETURN jsonb_build_object('error', 'too_many_photos', 'max', pol.max_per_entry); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('history-media:' || c.student_id::text, 0));
  used := eduos_history_student_media_bytes(c.district_id, c.student_id);
  IF used + p_bytes > pol.max_bytes_per_student THEN RETURN jsonb_build_object('error', 'student_storage_full', 'usedBytes', used, 'maxBytes', pol.max_bytes_per_student); END IF;
  INSERT INTO private_media_objects(asset_id, district_id, school_id, storage_key, media_kind, mime_type, byte_size, purpose)
    VALUES (p_asset, c.district_id, c.school_id, p_storage_key, 'image', p_mime, p_bytes, 'history');
  INSERT INTO student_time_capsule_photos(district_id, school_id, student_id, capsule_id, asset_id, caption, alt_text, position, upload_key, uploaded_by)
    VALUES (c.district_id, c.school_id, c.student_id, c.id, p_asset, coalesce(p_caption, ''), p_alt,
            coalesce((SELECT max(position) + 1 FROM student_time_capsule_photos WHERE district_id = c.district_id AND capsule_id = c.id), 0),
            p_upload_key, eduos_ctx_user());
  RETURN jsonb_build_object('assetId', p_asset, 'studentId', c.student_id);
END $$;

CREATE FUNCTION eduos_capsule_photo_set(p_asset uuid, p_storage_key text, p_bytes bigint, p_scan text, p_processing text, p_width int, p_height int)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record;
BEGIN
  SELECT x.capsule_id INTO p FROM student_time_capsule_photos x WHERE x.asset_id = p_asset AND x.district_id = eduos_ctx_district();
  IF NOT FOUND OR eduos_capsule_access(p.capsule_id) IS DISTINCT FROM 'owner' THEN RETURN false; END IF;
  UPDATE private_media_objects SET storage_key = coalesce(p_storage_key, storage_key), byte_size = coalesce(p_bytes, byte_size),
         scan_status = p_scan, processing_status = p_processing, updated_at = now()
   WHERE asset_id = p_asset AND district_id = eduos_ctx_district();
  UPDATE student_time_capsule_photos SET width = p_width, height = p_height WHERE asset_id = p_asset AND district_id = eduos_ctx_district();
  RETURN true;
END $$;

-- Every ready photo in a capsule, for its owner or (once released) a recipient:
-- the owner's own, then those on the items inside (not for withheld items).
CREATE FUNCTION eduos_capsule_photos(p_capsule uuid)
RETURNS TABLE(asset_id uuid, entry_id uuid, caption text, alt_text text, width int, height int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.asset_id, x.entry_id, x.caption, x.alt_text, x.width, x.height FROM (
    SELECT p.asset_id, NULL::uuid AS entry_id, p.caption, p.alt_text, p.width, p.height, 0 AS grp, p.position AS a, 0 AS b
      FROM student_time_capsule_photos p JOIN private_media_objects o ON o.asset_id = p.asset_id AND o.district_id = p.district_id
     WHERE p.capsule_id = p_capsule AND p.district_id = eduos_ctx_district() AND o.scan_status = 'clean' AND o.processing_status = 'processed'
    UNION ALL
    SELECT a.asset_id, a.entry_id, a.caption, a.alt_text, a.width, a.height, 1, i.position, a.position
      FROM student_time_capsule_items i
      JOIN student_history_entries e ON e.id = i.entry_id AND e.district_id = i.district_id AND e.status NOT IN ('restricted','pending_deletion','deleted')
      JOIN student_history_entry_attachments a ON a.entry_id = i.entry_id AND a.district_id = i.district_id
      JOIN private_media_objects o ON o.asset_id = a.asset_id AND o.district_id = a.district_id
     WHERE i.capsule_id = p_capsule AND i.district_id = eduos_ctx_district() AND o.scan_status = 'clean' AND o.processing_status = 'processed'
  ) x
  WHERE eduos_capsule_access(p_capsule) IN ('owner','recipient')
  ORDER BY x.grp, x.a, x.b
$$;

-- A photo's storage record through a capsule the caller may open.
CREATE FUNCTION eduos_capsule_photo_get(p_asset uuid)
RETURNS TABLE(asset_id uuid, storage_key text, scan_status text, processing_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT o.asset_id, o.storage_key, o.scan_status, o.processing_status FROM private_media_objects o
   WHERE o.asset_id = p_asset AND o.district_id = eduos_ctx_district() AND o.purpose = 'history'
     AND EXISTS (
       SELECT 1 FROM student_time_capsule_photos p WHERE p.asset_id = o.asset_id AND eduos_capsule_access(p.capsule_id) IN ('owner','recipient')
       UNION ALL
       SELECT 1 FROM student_history_entry_attachments a
         JOIN student_time_capsule_items i ON i.entry_id = a.entry_id AND i.district_id = a.district_id
         JOIN student_history_entries e ON e.id = a.entry_id AND e.status NOT IN ('restricted','pending_deletion','deleted')
        WHERE a.asset_id = o.asset_id AND eduos_capsule_access(i.capsule_id) IN ('owner','recipient'))
$$;

-- A cancelled capsule's own photos are released: keys to delete from the bucket.
CREATE FUNCTION eduos_capsule_photos_release(p_capsule uuid) RETURNS TABLE(storage_key text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c student_time_capsules%ROWTYPE;
BEGIN
  SELECT * INTO c FROM student_time_capsules WHERE id = p_capsule AND district_id = eduos_ctx_district();
  IF NOT FOUND OR c.status <> 'cancelled' OR c.owner_user_id IS DISTINCT FROM eduos_ctx_user() THEN RETURN; END IF;
  RETURN QUERY UPDATE private_media_objects o SET processing_status = 'failed', updated_at = now()
    FROM student_time_capsule_photos p
   WHERE p.asset_id = o.asset_id AND p.capsule_id = c.id AND o.district_id = c.district_id AND o.processing_status <> 'failed'
  RETURNING o.storage_key;
END $$;

REVOKE ALL ON FUNCTION eduos_capsule_photo_begin(uuid, uuid, text, text, bigint, text, text, text),
  eduos_capsule_photo_set(uuid, text, bigint, text, text, int, int), eduos_capsule_photos(uuid), eduos_capsule_photo_get(uuid),
  eduos_capsule_photos_release(uuid) FROM PUBLIC;

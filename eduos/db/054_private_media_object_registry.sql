-- 37.9.3: durable, tenant-scoped private media object registry.
-- Storage keys are server-only metadata and are never serialized by API routes.
CREATE TABLE IF NOT EXISTS private_media_objects (
 asset_id uuid PRIMARY KEY,
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 storage_key text NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 2048),
 media_kind text NOT NULL CHECK(media_kind IN ('image','video')),
 mime_type text NOT NULL CHECK(length(mime_type) BETWEEN 3 AND 100),
 byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 52428800),
 scan_status text NOT NULL DEFAULT 'pending' CHECK(scan_status IN ('pending','clean','blocked')),
 processing_status text NOT NULL DEFAULT 'pending' CHECK(processing_status IN ('pending','processed','failed')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(district_id,asset_id)
);
CREATE INDEX IF NOT EXISTS private_media_objects_scope_idx
 ON private_media_objects(district_id,school_id,asset_id);
ALTER TABLE private_media_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_media_objects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS private_media_objects_tenant_scope ON private_media_objects;
CREATE POLICY private_media_objects_tenant_scope ON private_media_objects
 USING (district_id=nullif(current_setting('app.district_id',true),'')::uuid)
 WITH CHECK (district_id=nullif(current_setting('app.district_id',true),'')::uuid);

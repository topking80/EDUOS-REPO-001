-- 32.3.0: school branding (mascot, colours, font, motto) and the icon display
-- designer (tile styles for home screens and the app launcher), with a
-- draft -> published -> archived lifecycle, plus per-user display preferences.
--
-- Isolation: every table carries district_id with the tenant_isolation policy
-- (FORCE ROW LEVEL SECURITY), as everywhere else. RESTRICTIVE policies add:
--  - write: district roles (superintendent, it_admin) for any school and the
--    district default (school_id NULL); a principal only for their own school.
--  - read of profiles: editors of that scope see drafts and history; everyone
--    else sees only PUBLISHED profiles of their own school or the district
--    default. The anonymous sign-in landing uses the same rule (the API sets
--    app.role='anonymous' and app.school_id to the requested school).
--  - preferences: only the user's own row.

CREATE TABLE branding_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid REFERENCES schools(id),
  source_type text NOT NULL CHECK(source_type IN ('png','jpeg','webp','svg')),
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  removed jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(removed)='array'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX branding_uploads_scope ON branding_uploads(district_id, school_id, created_at DESC);

-- Only processed output is stored: re-encoded PNG crops and the sanitized SVG.
CREATE TABLE branding_assets (
  upload_id uuid NOT NULL REFERENCES branding_uploads(id),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid REFERENCES schools(id),
  variant text NOT NULL CHECK(variant IN ('svg','png_512','png_192','png_180','png_96','png_48','png_32')),
  mime text NOT NULL CHECK(mime IN ('image/png','image/svg+xml')),
  width integer NOT NULL CHECK(width BETWEEN 1 AND 8192),
  height integer NOT NULL CHECK(height BETWEEN 1 AND 8192),
  bytes bytea NOT NULL CHECK(octet_length(bytes) BETWEEN 1 AND 1048576),
  PRIMARY KEY (upload_id, variant)
);

CREATE TABLE branding_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid REFERENCES schools(id),          -- NULL = the district default
  status text NOT NULL CHECK(status IN ('draft','published','archived')),
  version integer CHECK(version IS NULL OR version > 0), -- set when published
  mascot_name text CHECK(mascot_name IS NULL OR char_length(mascot_name) BETWEEN 1 AND 60),
  motto text CHECK(motto IS NULL OR char_length(motto) BETWEEN 1 AND 120),
  primary_color text CHECK(primary_color IS NULL OR primary_color ~ '^#[0-9a-f]{6}$'),
  secondary_color text CHECK(secondary_color IS NULL OR secondary_color ~ '^#[0-9a-f]{6}$'),
  accent_color text CHECK(accent_color IS NULL OR accent_color ~ '^#[0-9a-f]{6}$'),
  font text CHECK(font IS NULL OR font IN ('system','rounded','serif','slab','readable')),
  mascot_upload_id uuid REFERENCES branding_uploads(id),
  tiles jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(tiles)='object' AND pg_column_size(tiles) <= 65536),
  contrast_report jsonb,
  based_on_version integer,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  CHECK((status = 'draft') = (version IS NULL))
);
CREATE UNIQUE INDEX branding_one_draft ON branding_profiles(district_id, school_id) NULLS NOT DISTINCT WHERE status='draft';
CREATE UNIQUE INDEX branding_one_published ON branding_profiles(district_id, school_id) NULLS NOT DISTINCT WHERE status='published';
CREATE UNIQUE INDEX branding_versions ON branding_profiles(district_id, school_id, version) NULLS NOT DISTINCT WHERE version IS NOT NULL;

CREATE TABLE user_preferences (
  user_id uuid NOT NULL REFERENCES users(id),
  district_id uuid NOT NULL REFERENCES districts(id),
  theme text NOT NULL DEFAULT 'school' CHECK(theme IN ('school','high_contrast')),
  reduce_motion boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, district_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branding_uploads','branding_assets','branding_profiles','user_preferences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- May the current actor edit branding for this scope (school or district default)?
CREATE FUNCTION eduos_can_edit_branding(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT eduos_is_table_owner() OR eduos_is_district_role()
      OR (p_school IS NOT NULL AND current_setting('app.role', true) = 'principal'
          AND p_school = nullif(current_setting('app.school_id', true), '')::uuid)
$$;
CREATE FUNCTION eduos_in_branding_scope(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT p_school IS NULL OR p_school = nullif(current_setting('app.school_id', true), '')::uuid
$$;

CREATE POLICY scope_read ON branding_profiles AS RESTRICTIVE FOR SELECT
  USING (eduos_can_edit_branding(school_id) OR (status = 'published' AND eduos_in_branding_scope(school_id)));
CREATE POLICY scope_insert ON branding_profiles AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_can_edit_branding(school_id));
CREATE POLICY scope_update ON branding_profiles AS RESTRICTIVE FOR UPDATE
  USING (eduos_can_edit_branding(school_id)) WITH CHECK (eduos_can_edit_branding(school_id));
CREATE POLICY scope_delete ON branding_profiles AS RESTRICTIVE FOR DELETE USING (eduos_can_edit_branding(school_id) AND status = 'draft');

CREATE POLICY scope_read ON branding_uploads AS RESTRICTIVE FOR SELECT
  USING (eduos_can_edit_branding(school_id) OR eduos_in_branding_scope(school_id));
CREATE POLICY scope_insert ON branding_uploads AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_can_edit_branding(school_id));
CREATE POLICY scope_read ON branding_assets AS RESTRICTIVE FOR SELECT
  USING (eduos_can_edit_branding(school_id) OR eduos_in_branding_scope(school_id));
CREATE POLICY scope_insert ON branding_assets AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_can_edit_branding(school_id));

CREATE POLICY own_row ON user_preferences AS RESTRICTIVE
  USING (eduos_is_table_owner() OR user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- The public landing never writes. Publishing emits branding.published through
-- the existing flow_events table and webhooks.

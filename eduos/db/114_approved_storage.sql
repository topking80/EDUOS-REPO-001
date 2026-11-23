-- TEACH-06: offloading a teacher's work to approved storage.
--
-- Two kinds of approved storage:
--   * an approved storage device: a teacher asks for their own drive or
--     laptop to be approved; district IT approves it and EduOS makes the
--     device's key pair. The unlock code (private key) is shown once, to go
--     with the device; EduOS keeps only the public key. A package saved to the
--     device is encrypted to it (src/portfolio-file.js), so a copy anywhere
--     else can't be read.
--   * the district cloud: when the superintendent turns it on, the district
--     keeps a copy of the package for as long as it sets.
-- Every offload is logged (who, when, where, how many items). Packages never
-- hold student information (TEACH-05).
--
-- A package file can be opened on another EduOS with the device's unlock
-- code; it arrives as a package from outside this EduOS and goes through the
-- same review.

CREATE TABLE storage_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  kind text NOT NULL CHECK (kind IN ('usb_drive','external_drive','laptop','other')),
  serial text CHECK (serial IS NULL OR length(btrim(serial)) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','retired')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  public_key text CHECK (public_key IS NULL OR length(public_key) <= 200),
  key_fingerprint text CHECK (key_fingerprint IS NULL OR key_fingerprint ~ '^[a-f0-9]{16}$'),
  retired_at timestamptz,
  CHECK (status <> 'approved' OR (public_key IS NOT NULL AND decided_by IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by <> owner_user_id),
  UNIQUE (district_id, id)
);
CREATE INDEX storage_devices_owner ON storage_devices(district_id, owner_user_id);

CREATE TABLE district_storage_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  cloud_enabled boolean NOT NULL DEFAULT false,
  retention_days integer NOT NULL DEFAULT 365 CHECK (retention_days BETWEEN 30 AND 3650),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portfolio_cloud_copies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  package_id uuid NOT NULL REFERENCES portfolio_packages(id),
  manifest jsonb NOT NULL,
  manifest_sha256 text NOT NULL,
  signature text,
  signer_public_key text,
  item_count integer NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now(),
  keep_until date NOT NULL,
  UNIQUE (district_id, package_id),
  UNIQUE (district_id, id)
);

CREATE TABLE portfolio_offloads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  package_id uuid NOT NULL REFERENCES portfolio_packages(id),
  target text NOT NULL CHECK (target IN ('device','cloud')),
  device_id uuid,
  item_count integer NOT NULL,
  manifest_sha256 text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CHECK ((target = 'device') = (device_id IS NOT NULL)),
  FOREIGN KEY (district_id, device_id) REFERENCES storage_devices(district_id, id)
);
CREATE INDEX portfolio_offloads_district ON portfolio_offloads(district_id, at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['storage_devices','district_storage_settings','portfolio_cloud_copies','portfolio_offloads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Who oversees a teacher's storage: district IT and the superintendent; the
-- principal of the teacher's school reads.
CREATE FUNCTION eduos_storage_overseer(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') IN ('it_admin','superintendent')
      OR (coalesce(eduos_ctx_role(), '') = 'principal' AND p_school IS NOT NULL AND p_school = eduos_ctx_school())
$$;

CREATE POLICY scope_read ON storage_devices AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user() OR eduos_storage_overseer(school_id));
CREATE POLICY scope_insert ON storage_devices AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user() AND status = 'pending' AND public_key IS NULL));
-- IT decides; the owner retires their own.
CREATE POLICY scope_update ON storage_devices AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user() OR coalesce(eduos_ctx_role(), '') = 'it_admin')
  WITH CHECK (eduos_is_table_owner() OR (coalesce(eduos_ctx_role(), '') = 'it_admin' AND decided_by = eduos_ctx_user()) OR (owner_user_id = eduos_ctx_user() AND status = 'retired'));

CREATE POLICY scope_read ON district_storage_settings AS RESTRICTIVE FOR SELECT USING (true);
CREATE POLICY scope_write ON district_storage_settings AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') = 'superintendent');
CREATE POLICY scope_update ON district_storage_settings AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') = 'superintendent');

-- The district's copy: the owner reads it; the superintendent and IT see it in the log.
CREATE POLICY scope_read ON portfolio_cloud_copies AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user()
  OR coalesce(eduos_ctx_role(), '') IN ('it_admin','superintendent'));
CREATE POLICY scope_insert ON portfolio_cloud_copies AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user()
  AND EXISTS (SELECT 1 FROM district_storage_settings s WHERE s.district_id = portfolio_cloud_copies.district_id AND s.cloud_enabled)));

CREATE POLICY scope_read ON portfolio_offloads AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user() OR eduos_storage_overseer(school_id));
CREATE POLICY scope_insert ON portfolio_offloads AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user()
  AND (target = 'cloud' OR EXISTS (SELECT 1 FROM storage_devices d WHERE d.id = device_id AND d.owner_user_id = eduos_ctx_user() AND d.status = 'approved'))));

-- Packages from outside this EduOS (opened from a device file) carry the
-- issuing district's name instead of a district here.
ALTER TABLE portfolio_packages ALTER COLUMN issued_by_district_id DROP NOT NULL,
  ADD COLUMN external_issuer text CHECK (external_issuer IS NULL OR length(btrim(external_issuer)) BETWEEN 1 AND 200),
  ADD CONSTRAINT portfolio_packages_issuer_114 CHECK ((issued_by_district_id IS NULL) <> (external_issuer IS NULL));
DROP POLICY owner_only ON portfolio_packages;
CREATE POLICY owner_only ON portfolio_packages USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user())
  WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user()
    AND (issued_by_district_id = eduos_ctx_district() OR (issued_by_district_id IS NULL AND external_issuer IS NOT NULL))));

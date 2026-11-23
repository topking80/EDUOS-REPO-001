-- STATE-01: the state index and educators' licenses.
--
-- The index itself (every state and DC: licensing, athletics, the education
-- agency's data, student records rules) is curated in the code with a source
-- and a checked date for each link (src/state-index-data.js). A district adds
-- its own entries for any state (and corrects ours) here, also with a source.
--
-- An educator records their own licenses (state, number, type, expiry); the
-- district verifies them against the state's lookup. Records are retired,
-- never deleted.

CREATE TABLE district_state_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  state_code text NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE district_state_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  state_code text NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  category text NOT NULL CHECK (category IN ('licensing','athletics','agency','records')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  url text NOT NULL CHECK (url ~ '^https://\S+$' AND length(url) <= 500),
  description text CHECK (description IS NULL OR length(description) <= 1000),
  source_url text CHECK (source_url IS NULL OR (source_url ~ '^https://\S+$' AND length(source_url) <= 500)),
  verified_on date NOT NULL,
  added_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  retired_by uuid REFERENCES users(id),
  UNIQUE (district_id, id)
);
CREATE INDEX district_state_entries_state ON district_state_entries(district_id, state_code) WHERE retired_at IS NULL;

CREATE TABLE educator_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  state_code text NOT NULL CHECK (state_code ~ '^[A-Z]{2}$'),
  license_number text NOT NULL CHECK (length(btrim(license_number)) BETWEEN 1 AND 40),
  license_type text NOT NULL CHECK (length(btrim(license_type)) BETWEEN 1 AND 120),
  endorsements text CHECK (endorsements IS NULL OR length(endorsements) <= 300),
  issued_on date,
  expires_on date,
  status text NOT NULL DEFAULT 'self_reported' CHECK (status IN ('self_reported','verified','not_verified')),
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  verify_note text CHECK (verify_note IS NULL OR length(verify_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on),
  CHECK ((status = 'self_reported') = (verified_by IS NULL)),
  UNIQUE (district_id, id)
);
CREATE INDEX educator_licenses_user ON educator_licenses(district_id, user_id) WHERE retired_at IS NULL;
CREATE INDEX educator_licenses_expiry ON educator_licenses(district_id, expires_on) WHERE retired_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['district_state_settings','district_state_entries','educator_licenses'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The district's state and its own index entries: everyone in the district
-- reads; the superintendent sets and edits.
CREATE POLICY lead_write ON district_state_settings AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent');
CREATE POLICY lead_update ON district_state_settings AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent');
CREATE POLICY lead_write ON district_state_entries AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND added_by = eduos_ctx_user()));
CREATE POLICY lead_update ON district_state_entries AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent');

-- Licenses: the educator (their own), the superintendent (all, and verifies),
-- a principal (read: people who work at their school).
CREATE FUNCTION eduos_works_at_my_school(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() = 'principal' AND EXISTS(SELECT 1 FROM memberships m WHERE m.user_id = p_user AND m.district_id = eduos_ctx_district()
    AND m.school_id = eduos_ctx_school() AND m.status = 'active')
$$;
CREATE POLICY scope_read ON educator_licenses AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR eduos_ctx_role() = 'superintendent' OR eduos_works_at_my_school(user_id));
CREATE POLICY scope_insert ON educator_licenses AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (user_id = eduos_ctx_user() AND status = 'self_reported'));
-- The owner edits or retires their own; the trigger below keeps verification
-- for the superintendent.
CREATE POLICY scope_update ON educator_licenses AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR eduos_ctx_role() = 'superintendent')
  WITH CHECK (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR eduos_ctx_role() = 'superintendent');

-- Any change to the license itself needs verifying again; only the
-- superintendent records a verification.
CREATE FUNCTION eduos_license_reverify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.state_code, NEW.license_number, NEW.license_type, NEW.endorsements, NEW.issued_on, NEW.expires_on)
     IS DISTINCT FROM (OLD.state_code, OLD.license_number, OLD.license_type, OLD.endorsements, OLD.issued_on, OLD.expires_on) THEN
    NEW.status := 'self_reported'; NEW.verified_by := NULL; NEW.verified_at := NULL; NEW.verify_note := NULL;
  ELSIF (NEW.status, NEW.verified_by, NEW.verified_at, NEW.verify_note) IS DISTINCT FROM (OLD.status, OLD.verified_by, OLD.verified_at, OLD.verify_note)
        AND NOT eduos_is_table_owner() AND coalesce(eduos_ctx_role(), '') <> 'superintendent' THEN
    RAISE EXCEPTION 'only the district verifies a license' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER educator_licenses_reverify BEFORE UPDATE ON educator_licenses FOR EACH ROW EXECUTE FUNCTION eduos_license_reverify();

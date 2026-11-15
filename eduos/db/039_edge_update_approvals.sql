-- District-approved OS updates for EduOS edge devices, with a canary gate.
--
-- When a district turns approval on (edge_update_policy.require_approval),
-- devices whose update policy asks for district sign-off install only an OS
-- version approved here: canary devices get a version once it's approved
-- ('canary'); everyone else only after it's promoted. Promotion is blocked
-- until enough canary devices have run that version healthy for the soak time
-- and none has rolled back from it (checked from their health reports, db/038).
-- Approve and promote are district decisions (superintendent, IT admin);
-- every step is audited.

CREATE TABLE edge_update_policy (
  district_id uuid PRIMARY KEY REFERENCES districts(id) ON DELETE CASCADE,
  require_approval boolean NOT NULL DEFAULT false,
  min_canaries integer NOT NULL DEFAULT 2 CHECK (min_canaries BETWEEN 1 AND 100),
  soak_hours integer NOT NULL DEFAULT 24 CHECK (soak_hours BETWEEN 0 AND 720),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE edge_update_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  version text NOT NULL CHECK (version ~ '^[0-9]{2,3}\.[0-9]{8}\.[0-9]+\.[0-9]+$'),
  stage text NOT NULL DEFAULT 'canary' CHECK (stage IN ('canary','promoted','withdrawn')),
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  promoted_by uuid REFERENCES users(id),
  promoted_at timestamptz,
  withdrawn_by uuid REFERENCES users(id),
  withdrawn_at timestamptz,
  withdraw_reason text CHECK (withdraw_reason IS NULL OR length(withdraw_reason) BETWEEN 3 AND 300),
  UNIQUE (district_id, version),
  CHECK (stage <> 'promoted' OR promoted_at IS NOT NULL),
  CHECK ((stage = 'withdrawn') = (withdrawn_at IS NOT NULL))
);
CREATE INDEX edge_update_releases_scope ON edge_update_releases(district_id, stage, approved_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['edge_update_policy','edge_update_releases'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid) '
                   'WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid)', t || '_tenant_scope', t);
  END LOOP;
END $$;

-- Compares OS versions like 45.20261110.3.0 numerically, part by part.
CREATE FUNCTION eduos_os_version_key(v text) RETURNS int[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT string_to_array(v, '.')::int[] $$;

-- The OS version a device should run, checked against its token (as in db/038).
-- canary devices: the newest approved version that isn't withdrawn;
-- everyone else: the newest promoted one. NULL target = install nothing.
-- Returns NULL for a bad token.
CREATE FUNCTION eduos_edge_update_target(p_device uuid, p_token_hash text, p_cohort text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dev edge_devices%ROWTYPE; pol edge_update_policy%ROWTYPE; rel edge_update_releases%ROWTYPE;
BEGIN
  IF p_device IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  SELECT * INTO dev FROM edge_devices WHERE id = p_device AND token_hash = p_token_hash AND revoked_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO pol FROM edge_update_policy WHERE district_id = dev.district_id;
  IF NOT FOUND OR NOT pol.require_approval THEN
    RETURN jsonb_build_object('requireApproval', false, 'target', NULL, 'stage', NULL);
  END IF;
  SELECT * INTO rel FROM edge_update_releases
   WHERE district_id = dev.district_id
     AND (stage = 'promoted' OR (stage = 'canary' AND p_cohort = 'canary'))
   ORDER BY eduos_os_version_key(version) DESC LIMIT 1;
  RETURN jsonb_build_object('requireApproval', true, 'target', rel.version, 'stage', rel.stage);
END; $$;
REVOKE ALL ON FUNCTION eduos_edge_update_target(uuid, text, text) FROM PUBLIC;

-- Edge Phase 2: device health telemetry from EduOS edge devices.
--
-- Until now the edge health agent only wrote a local JSON file; the upload was
-- commented out and nothing on the district server received it. District IT
-- now registers each device here and gets a one-time device token (shown once,
-- stored only as a SHA-256 hash). The device sends its health report to
-- POST /api/edge/health with that token. The report carries device metrics,
-- compliance flags and OS update state only: never student data.
--
-- Reports arrive before any user session exists, so the runtime role can't
-- read edge_devices to check a token. eduos_edge_record_health() is the only
-- way in: it checks the token, stores the report and returns the device's
-- district, in one SECURITY DEFINER step. District staff read devices and
-- reports through normal tenant row-level security.

CREATE TABLE edge_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  device_role text NOT NULL CHECK (device_role IN ('teacher','student','admin','edge','district','state','school-node')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id),
  last_seen_at timestamptz,
  last_report jsonb,
  report_count integer NOT NULL DEFAULT 0,
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id) ON DELETE CASCADE
);
CREATE INDEX edge_devices_scope ON edge_devices(district_id, school_id);

CREATE TABLE edge_device_reports (
  id bigserial PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES edge_devices(id) ON DELETE CASCADE,
  received_at timestamptz NOT NULL DEFAULT now(),
  report jsonb NOT NULL CHECK (octet_length(report::text) <= 16384)
);
CREATE INDEX edge_device_reports_device ON edge_device_reports(device_id, received_at DESC);
CREATE INDEX edge_device_reports_age ON edge_device_reports(district_id, received_at);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['edge_devices','edge_device_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    -- The table owner (only reachable through the SECURITY DEFINER functions
    -- below) may cross districts to match a device token; everyone else sees
    -- their own district only.
    EXECUTE format('CREATE POLICY %I ON %I USING (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid) '
                   'WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid)', t || '_tenant_scope', t);
  END LOOP;
END $$;

-- Checks a device token and records one report. Returns NULL for an unknown,
-- revoked or wrong token (the API answers 401 without saying which).
CREATE FUNCTION eduos_edge_record_health(p_device uuid, p_token_hash text, p_report jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE dev edge_devices%ROWTYPE;
BEGIN
  IF p_device IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_report) <> 'object' THEN
    RETURN NULL;
  END IF;
  SELECT * INTO dev FROM edge_devices WHERE id = p_device AND token_hash = p_token_hash AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO edge_device_reports(district_id, device_id, report) VALUES (dev.district_id, dev.id, p_report);
  UPDATE edge_devices SET last_seen_at = now(), last_report = p_report, report_count = report_count + 1 WHERE id = dev.id;
  RETURN jsonb_build_object('deviceId', dev.id, 'districtId', dev.district_id, 'schoolId', dev.school_id);
END; $$;
REVOKE ALL ON FUNCTION eduos_edge_record_health(uuid, text, jsonb) FROM PUBLIC;

-- Retention: report history (the latest report stays on the device row).
-- Run by src/retention.js as the owner role, one district at a time.
CREATE FUNCTION eduos_retention_purge_edge_reports(p_days int) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF p_days IS NULL OR p_days < 1 THEN RAISE EXCEPTION 'edge report retention must be at least 1 day'; END IF;
  DELETE FROM edge_device_reports WHERE district_id = d AND received_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('edge_device_reports', n);
END; $$;
REVOKE ALL ON FUNCTION eduos_retention_purge_edge_reports(int) FROM PUBLIC;

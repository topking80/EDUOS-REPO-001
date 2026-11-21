-- 084: durable, cross-instance one-time consumption for LTI launch hints.
-- The runtime role cannot read or mutate the replay ledger directly. It can
-- call one SECURITY DEFINER function which verifies the active tenant context
-- and atomically claims a launch identifier until its signed expiry.
CREATE TABLE lti_launch_replays (
  district_id uuid NOT NULL REFERENCES districts(id),
  launch_id text NOT NULL CHECK(length(launch_id) BETWEEN 1 AND 200),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (district_id, launch_id),
  CHECK (expires_at > created_at)
);
CREATE INDEX lti_launch_replays_expiry_idx ON lti_launch_replays(expires_at);

-- Enforce district isolation even for accidental owner-level access. The
-- SECURITY DEFINER consumer runs as the migration owner, but remains limited
-- to the transaction's authenticated district context.
ALTER TABLE lti_launch_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE lti_launch_replays FORCE ROW LEVEL SECURITY;
CREATE POLICY lti_launch_replays_tenant ON lti_launch_replays
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

CREATE FUNCTION eduos_lti_consume_launch(p_district_id uuid, p_launch_id text, p_expires_at timestamptz)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE current_district uuid := nullif(current_setting('app.district_id', true), '')::uuid;
        claimed boolean := false;
BEGIN
  IF current_district IS NULL OR current_district <> p_district_id THEN
    RAISE EXCEPTION 'LTI tenant context mismatch' USING ERRCODE = '42501';
  END IF;
  IF p_launch_id IS NULL OR length(p_launch_id) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'invalid LTI launch identifier' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() OR p_expires_at > now() + interval '6 minutes' THEN
    RAISE EXCEPTION 'invalid LTI launch expiry' USING ERRCODE = '22023';
  END IF;

  -- Bound ledger growth opportunistically; expired entries cannot block reuse.
  DELETE FROM lti_launch_replays
   WHERE district_id = p_district_id AND expires_at <= now();

  INSERT INTO lti_launch_replays(district_id, launch_id, expires_at)
  VALUES (p_district_id, p_launch_id, p_expires_at)
  ON CONFLICT (district_id, launch_id) DO UPDATE
    SET expires_at = EXCLUDED.expires_at, created_at = now()
    WHERE lti_launch_replays.expires_at <= now()
  RETURNING true INTO claimed;

  RETURN coalesce(claimed, false);
END;
$$;
REVOKE ALL ON FUNCTION eduos_lti_consume_launch(uuid, text, timestamptz) FROM PUBLIC;
REVOKE ALL ON lti_launch_replays FROM PUBLIC;

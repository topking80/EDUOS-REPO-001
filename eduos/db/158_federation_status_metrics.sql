-- FED-09: federation status for /metrics, without naming any district.
-- For each district: whether it has a policy bundle in effect (signed with a
-- key that isn't revoked), that bundle's rules and jurisdiction, how old the
-- newest received bundle is, and whether the newest received bundle was
-- signed with a revoked key. /metrics turns these into counts.
CREATE OR REPLACE FUNCTION eduos_federation_status(p_on text, p_revoked text[])
RETURNS TABLE(has_bundle boolean, policies jsonb, jurisdiction_id text, newest_age_seconds double precision, newest_revoked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT f.bundle IS NOT NULL, f.bundle->'policies', f.bundle->'district'->>'jurisdiction_id',
         extract(epoch FROM now() - n.received_at), coalesce(n.key_fingerprint = ANY(p_revoked), false)
    FROM districts d
    LEFT JOIN LATERAL (SELECT b.bundle FROM district_policy_bundles b
       WHERE b.district_id = d.id AND (b.bundle->>'effective_from') <= p_on AND NOT (b.key_fingerprint = ANY(p_revoked))
       ORDER BY b.version DESC LIMIT 1) f ON true
    LEFT JOIN LATERAL (SELECT b.received_at, b.key_fingerprint FROM district_policy_bundles b
       WHERE b.district_id = d.id ORDER BY b.version DESC LIMIT 1) n ON true
$$;
REVOKE ALL ON FUNCTION eduos_federation_status(text, text[]) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT EXECUTE ON FUNCTION eduos_federation_status(text, text[]) TO eduos_app;
  END IF;
END
$$;

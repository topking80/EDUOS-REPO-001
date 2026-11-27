-- SPORT-05: signed athlete eligibility attestations for a state athletic
-- association.
--
-- athletic_association_agreements: the superintendent's agreement with an
--   association (purpose, legal basis, dates). The association reads with an
--   access token whose SHA-256 is kept here; only while the agreement is in
--   force.
-- athlete_association_consents: a parent's or guardian's agreement to share
--   one athlete's eligibility status with that association.
-- eligibility_attestations: what an athletic director certified for a team
--   (the signed file, kept as issued). Lists only consented athletes.
--   Revoking a consent withdraws every unexpired attestation listing them.
-- association_reads: every read by the association, allowed or denied.
--   Append-only.

CREATE TABLE athletic_association_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  association_ref text NOT NULL CHECK (association_ref ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  association_name text NOT NULL CHECK (length(btrim(association_name)) BETWEEN 2 AND 200),
  purpose text NOT NULL DEFAULT 'eligibility_verification' CHECK (purpose IN ('eligibility_verification')),
  legal_basis text NOT NULL CHECK (length(btrim(legal_basis)) BETWEEN 3 AND 500),
  effective_from date NOT NULL,
  effective_to date NOT NULL,
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  revoke_reason text CHECK (revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 3 AND 500),
  CHECK (effective_to >= effective_from),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoke_reason IS NOT NULL)),
  UNIQUE (district_id, id)
);

CREATE TABLE athlete_association_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  agreement_id uuid NOT NULL,
  granted_by uuid NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, agreement_id) REFERENCES athletic_association_agreements(district_id, id),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE UNIQUE INDEX athlete_association_consents_open ON athlete_association_consents(student_id, agreement_id) WHERE revoked_at IS NULL;

CREATE TABLE eligibility_attestations (
  id uuid PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  activity_id uuid NOT NULL REFERENCES school_activities(id),
  agreement_id uuid NOT NULL,
  as_of date NOT NULL,
  expires_on date NOT NULL,
  athletes integer NOT NULL CHECK (athletes >= 0),
  withheld integer NOT NULL CHECK (withheld >= 0),
  student_ids uuid[] NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  attested_by uuid NOT NULL REFERENCES users(id),
  attested_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_by uuid REFERENCES users(id),
  withdrawn_at timestamptz,
  withdraw_reason text CHECK (withdraw_reason IS NULL OR length(btrim(withdraw_reason)) BETWEEN 3 AND 500),
  FOREIGN KEY (district_id, agreement_id) REFERENCES athletic_association_agreements(district_id, id),
  CHECK (expires_on >= as_of),
  CHECK ((withdrawn_at IS NULL) = (withdraw_reason IS NULL))
);
CREATE INDEX eligibility_attestations_agreement ON eligibility_attestations(district_id, agreement_id, attested_at DESC);
CREATE INDEX eligibility_attestations_activity ON eligibility_attestations(district_id, activity_id, attested_at DESC);

CREATE TABLE association_reads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  agreement_id uuid NOT NULL,
  attestation_id uuid,
  action text NOT NULL CHECK (action IN ('list','read')),
  outcome text NOT NULL CHECK (outcome IN ('allowed','denied')),
  reason text CHECK (reason IS NULL OR length(reason) <= 80),
  read_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX association_reads_agreement ON association_reads(district_id, agreement_id, read_at DESC);
CREATE TRIGGER association_reads_append_only BEFORE UPDATE OR DELETE ON association_reads FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['athletic_association_agreements','athlete_association_consents','eligibility_attestations','association_reads'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The association's only way in: its agreement ID and access token (hashed
-- by the caller). Lists the agreement's current attestations, or returns one,
-- while the agreement is in force. Every call that names a real agreement is
-- logged, allowed or denied. A wrong token reveals nothing.
CREATE FUNCTION eduos_association_access(p_agreement uuid, p_token_hash text, p_attestation uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a athletic_association_agreements%ROWTYPE;
  x eligibility_attestations%ROWTYPE;
  act text := CASE WHEN p_attestation IS NULL THEN 'list' ELSE 'read' END;
  today date := (now() AT TIME ZONE 'UTC')::date; -- the day EduOS uses (UTC)
  out jsonb;
BEGIN
  SELECT * INTO a FROM athletic_association_agreements WHERE id = p_agreement;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'unauthorized'); END IF;
  IF a.token_hash <> p_token_hash THEN
    INSERT INTO association_reads(district_id, agreement_id, attestation_id, action, outcome, reason) VALUES (a.district_id, a.id, p_attestation, act, 'denied', 'bad_token');
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  IF a.status <> 'active' OR today < a.effective_from OR today > a.effective_to THEN
    INSERT INTO association_reads(district_id, agreement_id, attestation_id, action, outcome, reason)
      VALUES (a.district_id, a.id, p_attestation, act, 'denied', CASE WHEN a.status <> 'active' THEN 'agreement_revoked' WHEN today < a.effective_from THEN 'agreement_not_started' ELSE 'agreement_ended' END);
    RETURN jsonb_build_object('ok', false, 'error', 'agreement_not_in_force');
  END IF;
  IF p_attestation IS NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'school', e.envelope->'school'->>'name', 'activity', e.envelope->'activity'->>'title',
             'asOf', e.as_of, 'expiresOn', e.expires_on, 'athletes', e.athletes, 'sha256', e.sha256) ORDER BY e.attested_at DESC), '[]'::jsonb)
      INTO out FROM eligibility_attestations e
     WHERE e.district_id = a.district_id AND e.agreement_id = a.id AND e.withdrawn_at IS NULL AND e.expires_on >= today;
    INSERT INTO association_reads(district_id, agreement_id, action, outcome) VALUES (a.district_id, a.id, 'list', 'allowed');
    RETURN jsonb_build_object('ok', true, 'district', a.district_id, 'attestations', out);
  END IF;
  SELECT * INTO x FROM eligibility_attestations WHERE id = p_attestation AND district_id = a.district_id AND agreement_id = a.id;
  IF NOT FOUND OR x.withdrawn_at IS NOT NULL OR x.expires_on < today THEN
    INSERT INTO association_reads(district_id, agreement_id, attestation_id, action, outcome, reason)
      VALUES (a.district_id, a.id, p_attestation, 'read', 'denied', CASE WHEN NOT FOUND THEN 'not_found' WHEN x.withdrawn_at IS NOT NULL THEN 'withdrawn' ELSE 'expired' END);
    RETURN jsonb_build_object('ok', false, 'error', CASE WHEN NOT FOUND THEN 'not_found' WHEN x.withdrawn_at IS NOT NULL THEN 'withdrawn' ELSE 'expired' END);
  END IF;
  INSERT INTO association_reads(district_id, agreement_id, attestation_id, action, outcome) VALUES (a.district_id, a.id, x.id, 'read', 'allowed');
  RETURN jsonb_build_object('ok', true, 'district', a.district_id, 'envelope', x.envelope);
END $$;
REVOKE ALL ON FUNCTION eduos_association_access(uuid, text, uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT EXECUTE ON FUNCTION eduos_association_access(uuid, text, uuid) TO eduos_app;
  END IF;
END
$$;

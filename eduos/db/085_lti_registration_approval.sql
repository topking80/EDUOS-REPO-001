-- 085: district-controlled approval and emergency revocation for LTI registrations.
-- Every LTI registration starts pending. Any change to its trust-boundary
-- configuration invalidates approval inside PostgreSQL, not just in the API.
ALTER TABLE apps
  ADD COLUMN lti_registration_status text NOT NULL DEFAULT 'not_required'
    CHECK (lti_registration_status IN ('not_required','pending','approved','revoked')),
  ADD COLUMN lti_approved_config_hash text
    CHECK (lti_approved_config_hash IS NULL OR lti_approved_config_hash ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN lti_approved_by uuid REFERENCES users(id),
  ADD COLUMN lti_approved_at timestamptz,
  ADD COLUMN lti_revoked_by uuid REFERENCES users(id),
  ADD COLUMN lti_revoked_at timestamptz,
  ADD CONSTRAINT apps_lti_approval_consistency CHECK (
    (lti_registration_status = 'not_required'
      AND lti_approved_config_hash IS NULL AND lti_approved_by IS NULL AND lti_approved_at IS NULL
      AND lti_revoked_by IS NULL AND lti_revoked_at IS NULL)
    OR (lti_registration_status = 'pending'
      AND lti_approved_config_hash IS NULL AND lti_approved_by IS NULL AND lti_approved_at IS NULL
      AND lti_revoked_by IS NULL AND lti_revoked_at IS NULL)
    OR (lti_registration_status = 'approved'
      AND lti_approved_config_hash IS NOT NULL AND lti_approved_by IS NOT NULL AND lti_approved_at IS NOT NULL
      AND lti_revoked_by IS NULL AND lti_revoked_at IS NULL)
    OR (lti_registration_status = 'revoked'
      AND lti_approved_config_hash IS NULL AND lti_revoked_by IS NOT NULL AND lti_revoked_at IS NOT NULL)
  );

UPDATE apps SET lti_registration_status='pending'
 WHERE integration_type='lti13';

CREATE FUNCTION eduos_invalidate_lti_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.integration_type = 'lti13' THEN
      NEW.lti_registration_status := 'pending';
    ELSE
      NEW.lti_registration_status := 'not_required';
    END IF;
    NEW.lti_approved_config_hash := NULL;
    NEW.lti_approved_by := NULL;
    NEW.lti_approved_at := NULL;
    NEW.lti_revoked_by := NULL;
    NEW.lti_revoked_at := NULL;
  ELSIF NEW.integration_type <> 'lti13' THEN
    NEW.lti_registration_status := 'not_required';
    NEW.lti_approved_config_hash := NULL;
    NEW.lti_approved_by := NULL;
    NEW.lti_approved_at := NULL;
    NEW.lti_revoked_by := NULL;
    NEW.lti_revoked_at := NULL;
  ELSIF OLD.integration_type IS DISTINCT FROM NEW.integration_type
     OR OLD.integration_config IS DISTINCT FROM NEW.integration_config THEN
    NEW.lti_registration_status := 'pending';
    NEW.lti_approved_config_hash := NULL;
    NEW.lti_approved_by := NULL;
    NEW.lti_approved_at := NULL;
    NEW.lti_revoked_by := NULL;
    NEW.lti_revoked_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER apps_lti_approval_invalidate
  BEFORE INSERT OR UPDATE OF integration_type, integration_config ON apps
  FOR EACH ROW EXECUTE FUNCTION eduos_invalidate_lti_approval();

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

-- Approval metadata is changed only through these tenant- and role-checked
-- SECURITY DEFINER functions. The runtime role receives EXECUTE, not column
-- UPDATE privileges for the approval state.
CREATE FUNCTION eduos_lti_approve_registration(p_app_id uuid, p_config_hash text, p_actor uuid)
RETURNS TABLE(registration_status text, approved_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE tenant_id uuid := nullif(current_setting('app.district_id', true), '')::uuid;
        actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
        actor_role text := current_setting('app.role', true);
BEGIN
  IF tenant_id IS NULL OR actor_id IS NULL OR actor_id <> p_actor
     OR actor_role IS NULL OR actor_role NOT IN ('superintendent','it_admin')
     OR p_config_hash IS NULL OR p_config_hash !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'unauthorized LTI approval' USING ERRCODE = '42501';
  END IF;
  UPDATE apps SET lti_registration_status='approved',lti_approved_config_hash=p_config_hash,
      lti_approved_by=actor_id,lti_approved_at=now(),lti_revoked_by=NULL,lti_revoked_at=NULL,updated_at=now()
    WHERE id=p_app_id AND district_id=tenant_id AND integration_type='lti13' AND status='active'
    RETURNING apps.lti_registration_status,apps.lti_approved_at INTO registration_status,approved_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'LTI registration not approvable' USING ERRCODE = 'P0002'; END IF;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION eduos_lti_revoke_registration(p_app_id uuid, p_actor uuid)
RETURNS TABLE(registration_status text, revoked_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE tenant_id uuid := nullif(current_setting('app.district_id', true), '')::uuid;
        actor_id uuid := nullif(current_setting('app.user_id', true), '')::uuid;
        actor_role text := current_setting('app.role', true);
BEGIN
  IF tenant_id IS NULL OR actor_id IS NULL OR actor_id <> p_actor
     OR actor_role IS NULL OR actor_role NOT IN ('superintendent','it_admin') THEN
    RAISE EXCEPTION 'unauthorized LTI revocation' USING ERRCODE = '42501';
  END IF;
  UPDATE apps SET lti_registration_status='revoked',lti_approved_config_hash=NULL,
      lti_approved_by=NULL,lti_approved_at=NULL,lti_revoked_by=actor_id,lti_revoked_at=now(),updated_at=now()
    WHERE id=p_app_id AND district_id=tenant_id AND integration_type='lti13'
    RETURNING apps.lti_registration_status,apps.lti_revoked_at INTO registration_status,revoked_at;
  IF NOT FOUND THEN RAISE EXCEPTION 'LTI registration not found' USING ERRCODE = 'P0002'; END IF;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION eduos_lti_approve_registration(uuid,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_lti_revoke_registration(uuid,uuid) FROM PUBLIC;

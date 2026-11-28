-- Guardian relationship revocation (Phase 1 of the production roadmap).
-- Districts could create guardian links (invitations, SIS) but not end one.
-- A school leader can now disable a parent's or guardian's link with a reason
-- (src/guardian-link-routes.js); every family view of that child stops at once,
-- because every family path checks an active link.
ALTER TABLE student_user_links
  ADD COLUMN disabled_by uuid REFERENCES users(id),
  ADD COLUMN disabled_at timestamptz,
  ADD COLUMN disabled_reason text CHECK (disabled_reason IS NULL OR length(btrim(disabled_reason)) BETWEEN 3 AND 500);

-- A parent can't (re)activate a link for themselves except while accepting a
-- pending invitation for that student and relationship whose secret they hold
-- (the accept route sets app.invitation_token_hash, db/177). So a disabled
-- guardian can't switch their own link back on.
CREATE FUNCTION eduos_link_activation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF eduos_owner_session() OR coalesce(eduos_ctx_role(), '') NOT IN ('parent', 'pupil') THEN RETURN NEW; END IF;
  IF NEW.status = 'active' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'active') AND NOT EXISTS (
       SELECT 1 FROM guardian_invitations gi
        WHERE gi.district_id = NEW.district_id AND gi.student_id = NEW.student_id AND gi.relationship = NEW.relationship
          AND gi.status = 'pending' AND gi.expires_at > now()
          AND gi.token_hash = nullif(current_setting('app.invitation_token_hash', true), '')) THEN
    RAISE EXCEPTION 'a family link is activated only by accepting an invitation' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.disabled_by, NEW.disabled_at, NEW.disabled_reason) IS DISTINCT FROM (OLD.disabled_by, OLD.disabled_at, OLD.disabled_reason)
     AND NEW.status <> 'active' THEN
    RAISE EXCEPTION 'families cannot change a disabled link' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eduos_link_activation_guard() FROM PUBLIC;
CREATE TRIGGER student_user_links_activation_guard BEFORE INSERT OR UPDATE ON student_user_links
  FOR EACH ROW EXECUTE FUNCTION eduos_link_activation_guard();

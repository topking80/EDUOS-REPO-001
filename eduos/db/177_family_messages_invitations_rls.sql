-- SEC-01 part 2 (docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md §5.1): family
-- messages and guardian invitations get per-person row security. Both had
-- only district isolation (db/006, db/007); the routes filtered, the database
-- didn't. Matching src/server.js:
--
-- family_messages
--   read:   the sender or the recipient; the superintendent; the principal (or
--           vice principal) of the student's school, for records export.
--   send:   as yourself only, by a parent, teacher, principal or superintendent.
--   update: the recipient marks it read.
-- guardian_invitations
--   read and manage: the superintendent; the principal (or vice principal) of
--           the invitation's school.
--   accept: a parent sees and accepts only the invitation whose secret they
--           present: the accept route puts the token's hash in
--           app.invitation_token_hash for that transaction.

CREATE FUNCTION eduos_leads_student_school(p_student uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() = 'superintendent' OR (eduos_ctx_role() = 'principal' AND EXISTS (
    SELECT 1 FROM students s WHERE s.id = p_student AND s.district_id = eduos_ctx_district() AND s.school_id = eduos_ctx_school()))
$$;
DO $$ BEGIN
  REVOKE ALL ON FUNCTION eduos_leads_student_school(uuid) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN GRANT EXECUTE ON FUNCTION eduos_leads_student_school(uuid) TO eduos_app; END IF;
END $$;

CREATE POLICY message_read ON family_messages AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR sender_user_id = eduos_ctx_user() OR recipient_user_id = eduos_ctx_user() OR eduos_leads_student_school(student_id));
CREATE POLICY message_send ON family_messages AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (sender_user_id = eduos_ctx_user() AND eduos_ctx_role() IN ('parent', 'teacher', 'principal', 'superintendent')));
CREATE POLICY message_update ON family_messages AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR recipient_user_id = eduos_ctx_user())
  WITH CHECK (eduos_is_table_owner() OR recipient_user_id = eduos_ctx_user());

-- The message itself never changes after it's sent; only read_at does.
CREATE FUNCTION eduos_family_message_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF eduos_owner_session() THEN RETURN NEW; END IF;
  IF (NEW.student_id, NEW.sender_user_id, NEW.recipient_user_id, NEW.body, NEW.created_at) IS DISTINCT FROM
     (OLD.student_id, OLD.sender_user_id, OLD.recipient_user_id, OLD.body, OLD.created_at) THEN
    RAISE EXCEPTION 'a sent message cannot be changed' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION eduos_family_message_guard() FROM PUBLIC;
CREATE TRIGGER family_messages_guard BEFORE UPDATE ON family_messages FOR EACH ROW EXECUTE FUNCTION eduos_family_message_guard();

CREATE POLICY invitation_read ON guardian_invitations AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent' OR (eduos_ctx_role() = 'principal' AND school_id = eduos_ctx_school())
    OR (eduos_ctx_role() = 'parent' AND token_hash = nullif(current_setting('app.invitation_token_hash', true), '')));
CREATE POLICY invitation_create ON guardian_invitations AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (invited_by = eduos_ctx_user()
    AND (eduos_ctx_role() = 'superintendent' OR (eduos_ctx_role() = 'principal' AND school_id = eduos_ctx_school()))));
CREATE POLICY invitation_update ON guardian_invitations AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent' OR (eduos_ctx_role() = 'principal' AND school_id = eduos_ctx_school())
    OR (eduos_ctx_role() = 'parent' AND token_hash = nullif(current_setting('app.invitation_token_hash', true), '') AND status = 'pending'))
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent' OR (eduos_ctx_role() = 'principal' AND school_id = eduos_ctx_school())
    OR (eduos_ctx_role() = 'parent' AND token_hash = nullif(current_setting('app.invitation_token_hash', true), '')
        AND (status = 'expired' OR (status = 'accepted' AND accepted_by = eduos_ctx_user()))));

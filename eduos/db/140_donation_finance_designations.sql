-- TC-13: who reviews donation finance (district decision 2026-11-24: "the
-- district account and the school secretary").
--
--   * The district account: the district-level leadership account
--     (superintendent), which has always had finance access (db/136).
--   * The school secretary: a new school-scoped staff role, school_secretary.
--     The role alone grants nothing financial; a school secretary acts as a
--     donation finance reviewer once the superintendent designates them, and
--     only while signed in as school secretary.
--
-- Designations are now limited to school secretaries. Earlier designations of
-- other staff (TC-10 allowed any staff role) stop counting: the rows are kept
-- for the record, and history_donation_finance() no longer honours them.
--
-- Separation of duties is unchanged (db/136, db/138): nobody refunds their own
-- gift, nobody reconciles a period in which they recorded a refund, and fund
-- payments are requested by finance but approved by the school's principal
-- and two district administrators, never the requester.
--
-- Numbered 140: 138 TC-12 follow-up, 139 TC-13 recurring gifts, 150 clients/02-tv.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'memberships'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%lunch_staff%'
  LOOP EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', r.conname); END LOOP;
  ALTER TABLE memberships ADD CONSTRAINT memberships_role_139_check CHECK (role IN
   ('superintendent','it_admin','principal','vice_principal','teacher','parent','pupil','driver','sro','librarian','counselor','nurse','maintenance','lunch_staff','coach','school_secretary'));
END $$;

CREATE OR REPLACE FUNCTION eduos_history_donation_finance() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') = 'superintendent'
      OR (coalesce(eduos_ctx_role(), '') = 'school_secretary'
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = eduos_ctx_user() AND m.district_id = eduos_ctx_district()
                        AND m.role = 'school_secretary' AND m.status = 'active' AND m.school_id = eduos_ctx_school())
          AND EXISTS (SELECT 1 FROM history_donation_finance_reviewers r
                        WHERE r.district_id = eduos_ctx_district() AND r.user_id = eduos_ctx_user() AND r.removed_at IS NULL))
$$;

-- Designate or remove a reviewer (superintendent only). Only school secretaries
-- can be designated.
CREATE OR REPLACE FUNCTION eduos_history_donation_reviewer_set(p_user uuid, p_on boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); rid uuid;
BEGIN
  IF d IS NULL OR eduos_ctx_role() IS DISTINCT FROM 'superintendent' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_on THEN
    IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = p_user AND m.district_id = d AND m.status = 'active' AND m.role = 'school_secretary') THEN
      RAISE EXCEPTION 'reviewer_must_be_school_secretary' USING ERRCODE = '22023';
    END IF;
    SELECT id INTO rid FROM history_donation_finance_reviewers WHERE district_id = d AND user_id = p_user AND removed_at IS NULL;
    IF rid IS NOT NULL THEN RETURN rid; END IF;
    INSERT INTO history_donation_finance_reviewers(district_id, user_id, named_by) VALUES (d, p_user, eduos_ctx_user()) RETURNING id INTO rid;
  ELSE
    UPDATE history_donation_finance_reviewers SET removed_by = eduos_ctx_user(), removed_at = now()
      WHERE district_id = d AND user_id = p_user AND removed_at IS NULL RETURNING id INTO rid;
    IF rid IS NULL THEN RAISE EXCEPTION 'reviewer_not_found' USING ERRCODE = 'P0002'; END IF;
  END IF;
  RETURN rid;
END $$;

REVOKE ALL ON FUNCTION eduos_history_donation_finance(), eduos_history_donation_reviewer_set(uuid, boolean) FROM PUBLIC;

-- TC-12 follow-up: the district's payout and reporting decisions (2026-11-24).
-- Migration 137 shipped (PR #154) with a configurable 2-5 approvals; this
-- replaces that rule. 137 itself is never edited.
--
--   * A fund payment is for one school and needs exactly three approvals, all
--     required: the principal of that school plus two district administrators
--     (superintendent or IT administrator), none of them the requester, each
--     attesting no conflict of interest. A vice principal's session doesn't
--     fill the principal's seat. One rejection from the panel rejects it.
--     approvals_required is dropped.
--   * A restricted (school) source must be the same school the payment is for.
--   * The approval panel (district administrators, and the principal of the
--     school a payment is for) can read the requests and votes it decides.
--   * Fund totals are published as a footnote on student grade cards (the
--     "Final grades" card of Grades & progress; EduOS has no separate report
--     card): aggregate only, no donor names, only once report_min_donors people
--     have given, and only while the district publishes totals (public_report,
--     default off). The district can turn the footnote off
--     (grade_card_footnote, default on).
--
-- Requests still open under the old rule are closed by this migration
-- (pending: withdrawn; approved but unpaid: cancelled) with a reason, so they
-- are filed again under the new rule. Paid and closed records are kept as
-- they are; their votes keep no seat.
--
-- Numbered 138: 137 TC-12, 150 clients/02-tv.

-- Close open requests made under the old rule (the 137 guard allows these
-- moves). Row security applies to the owner too, so go district by district.
DO $$
DECLARE d uuid; why text := 'Approval rule changed to the school principal plus two district administrators (db/138). File again.';
BEGIN
  FOR d IN SELECT id FROM districts LOOP
    PERFORM set_config('app.district_id', d::text, true);
    UPDATE preservation_fund_disbursements SET status = 'withdrawn', decided_at = coalesce(decided_at, now()), close_reason = why
      WHERE district_id = d AND status = 'pending';
    UPDATE preservation_fund_disbursements SET status = 'cancelled', decided_at = coalesce(decided_at, now()), close_reason = why
      WHERE district_id = d AND status = 'approved';
  END LOOP;
  PERFORM set_config('app.district_id', '', true);
END $$;

ALTER TABLE preservation_fund_settings ADD COLUMN grade_card_footnote boolean NOT NULL DEFAULT true;

ALTER TABLE preservation_fund_disbursements ADD COLUMN school_id uuid;
DO $$
DECLARE d uuid;
BEGIN
  FOR d IN SELECT id FROM districts LOOP
    PERFORM set_config('app.district_id', d::text, true);
    UPDATE preservation_fund_disbursements SET school_id = source_school_id WHERE district_id = d AND school_id IS NULL AND source_school_id IS NOT NULL;
  END LOOP;
  PERFORM set_config('app.district_id', '', true);
END $$;
ALTER TABLE preservation_fund_disbursements
  ADD CONSTRAINT preservation_fund_disbursements_school_fk FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  ADD CONSTRAINT preservation_fund_disbursements_source_school CHECK (source_school_id IS NULL OR source_school_id = school_id),
  -- Every request from now on names its school; only records closed above may lack one.
  ADD CONSTRAINT preservation_fund_disbursements_school_required CHECK (school_id IS NOT NULL OR status IN ('rejected','withdrawn','cancelled','paid'));

ALTER TABLE preservation_fund_votes ADD COLUMN seat text CHECK (seat IS NULL OR seat IN ('school_principal','district_admin'));
-- New votes always carry their seat (votes are written only by the vote function).
ALTER TABLE preservation_fund_votes ADD CONSTRAINT preservation_fund_votes_seat_required CHECK (seat IS NOT NULL) NOT VALID;

CREATE OR REPLACE FUNCTION eduos_preservation_fund_disbursement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'disbursement records are kept' USING ERRCODE = '42501'; END IF;
  IF NEW.district_id <> OLD.district_id OR NEW.school_id IS DISTINCT FROM OLD.school_id OR NEW.source_school_id IS DISTINCT FROM OLD.source_school_id OR NEW.category <> OLD.category
     OR NEW.description <> OLD.description OR NEW.payee <> OLD.payee OR NEW.invoice_ref <> OLD.invoice_ref OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.requested_by <> OLD.requested_by OR NEW.requested_at <> OLD.requested_at THEN
    RAISE EXCEPTION 'disbursement terms are fixed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('approved','rejected','withdrawn'))
                                      OR (OLD.status = 'approved' AND NEW.status IN ('paid','cancelled'))) THEN
    RAISE EXCEPTION 'disbursement cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Disbursements and votes: finance, the district administrators and the
-- principal of the school a payment is for (the approval panel). The fund
-- ledger stays finance only. All written by functions.
DROP POLICY scope_read ON preservation_fund_disbursements;
CREATE POLICY scope_read ON preservation_fund_disbursements AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance() OR coalesce(eduos_ctx_role(), '') IN ('superintendent','it_admin')
         OR (coalesce(eduos_ctx_role(), '') = 'principal' AND school_id = eduos_ctx_school()));
DROP POLICY scope_read ON preservation_fund_votes;
CREATE POLICY scope_read ON preservation_fund_votes AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance() OR coalesce(eduos_ctx_role(), '') IN ('superintendent','it_admin')
         OR (coalesce(eduos_ctx_role(), '') = 'principal'
             AND EXISTS (SELECT 1 FROM preservation_fund_disbursements x WHERE x.id = disbursement_id AND x.school_id = eduos_ctx_school())));

DROP FUNCTION eduos_preservation_fund_request(uuid, text, text, text, text, integer);
CREATE FUNCTION eduos_preservation_fund_request(p_for uuid, p_school uuid, p_category text, p_description text, p_payee text, p_invoice text, p_amount integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); s preservation_fund_settings; rid uuid;
BEGIN
  IF d IS NULL OR NOT eduos_history_donation_finance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_for IS NULL OR NOT EXISTS (SELECT 1 FROM schools sc WHERE sc.id = p_for AND sc.district_id = d) THEN RAISE EXCEPTION 'school_required' USING ERRCODE = '22023'; END IF;
  IF p_school IS NOT NULL AND p_school <> p_for THEN RAISE EXCEPTION 'source_must_match_school' USING ERRCODE = '22023'; END IF;
  SELECT * INTO s FROM preservation_fund_settings WHERE district_id = d FOR SHARE;
  IF NOT FOUND OR NOT s.enabled THEN RAISE EXCEPTION 'fund_not_enabled' USING ERRCODE = '55000'; END IF;
  IF s.disbursement_paused THEN RAISE EXCEPTION 'disbursement_paused' USING ERRCODE = '55000'; END IF;
  IF NOT (p_category = ANY (s.eligible_categories)) THEN RAISE EXCEPTION 'category_not_eligible' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('preservation_fund:' || d::text, 0));
  IF p_amount IS NULL OR p_amount > eduos_preservation_fund_available(d, p_school) THEN RAISE EXCEPTION 'insufficient_funds' USING ERRCODE = '55000'; END IF;
  INSERT INTO preservation_fund_disbursements(district_id, school_id, source_school_id, category, description, payee, invoice_ref, amount_cents, requested_by)
    VALUES (d, p_for, p_school, p_category, btrim(p_description), btrim(p_payee), btrim(p_invoice), p_amount, eduos_ctx_user()) RETURNING id INTO rid;
  RETURN rid;
END $$;

CREATE FUNCTION eduos_preservation_fund_seat(p_school uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN coalesce(eduos_ctx_role(), '') = 'principal' AND NOT coalesce(eduos_ctx_is_vice_principal(), false) AND eduos_ctx_school() = p_school
         AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = eduos_ctx_user() AND m.district_id = eduos_ctx_district()
                       AND m.school_id = p_school AND m.role = 'principal' AND m.status = 'active') THEN 'school_principal'
    WHEN coalesce(eduos_ctx_role(), '') IN ('superintendent','it_admin')
         AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = eduos_ctx_user() AND m.district_id = eduos_ctx_district()
                       AND m.school_id IS NULL AND m.role = eduos_ctx_role() AND m.status = 'active') THEN 'district_admin'
  END
$$;

CREATE OR REPLACE FUNCTION eduos_preservation_fund_vote(p_id uuid, p_decision text, p_no_conflict boolean, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); s preservation_fund_settings; x preservation_fund_disbursements; seat text; np int; na int;
BEGIN
  IF d IS NULL OR eduos_ctx_user() IS NULL THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_decision NOT IN ('approve','reject') THEN RAISE EXCEPTION 'invalid_vote' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('preservation_fund:' || d::text, 0));
  SELECT * INTO x FROM preservation_fund_disbursements WHERE id = p_id AND district_id = d FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  seat := eduos_preservation_fund_seat(x.school_id);
  IF seat IS NULL THEN RAISE EXCEPTION 'not_on_approval_panel' USING ERRCODE = '42501'; END IF;
  IF p_no_conflict IS NOT TRUE THEN RAISE EXCEPTION 'conflict_declared' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM preservation_fund_settings WHERE district_id = d;
  IF s.disbursement_paused THEN RAISE EXCEPTION 'disbursement_paused' USING ERRCODE = '55000'; END IF;
  IF x.requested_by = eduos_ctx_user() THEN RAISE EXCEPTION 'requester_cannot_approve' USING ERRCODE = '42501'; END IF;
  IF x.status <> 'pending' THEN RAISE EXCEPTION 'not_pending' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM preservation_fund_votes WHERE disbursement_id = x.id AND voter = eduos_ctx_user()) THEN
    RAISE EXCEPTION 'already_decided' USING ERRCODE = '55000';
  END IF;
  SELECT count(*) FILTER (WHERE v.seat = 'school_principal'), count(*) FILTER (WHERE v.seat = 'district_admin') INTO np, na
    FROM preservation_fund_votes v WHERE v.disbursement_id = x.id AND v.decision = 'approve';
  IF p_decision = 'approve' AND ((seat = 'school_principal' AND np >= 1) OR (seat = 'district_admin' AND na >= 2)) THEN
    RAISE EXCEPTION 'seat_filled' USING ERRCODE = '55000';
  END IF;
  INSERT INTO preservation_fund_votes(district_id, disbursement_id, voter, seat, decision, no_conflict, note)
    VALUES (d, x.id, eduos_ctx_user(), seat, p_decision, true, nullif(btrim(coalesce(p_note, '')), ''));
  IF p_decision = 'reject' THEN
    UPDATE preservation_fund_disbursements SET status = 'rejected', decided_at = now() WHERE id = x.id;
    RETURN 'rejected';
  END IF;
  IF seat = 'school_principal' THEN np := np + 1; ELSE na := na + 1; END IF;
  IF np >= 1 AND na >= 2 THEN
    IF x.amount_cents > eduos_preservation_fund_available(d, x.source_school_id) THEN RAISE EXCEPTION 'insufficient_funds' USING ERRCODE = '55000'; END IF;
    UPDATE preservation_fund_disbursements SET status = 'approved', decided_at = now() WHERE id = x.id;
    RETURN 'approved';
  END IF;
  RETURN 'pending';
END $$;

-- approvals_required is no longer read by anything.
ALTER TABLE preservation_fund_settings DROP COLUMN approvals_required;

CREATE FUNCTION eduos_preservation_fund_grade_card_footnote() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); s preservation_fund_settings; r jsonb;
BEGIN
  IF d IS NULL OR eduos_ctx_user() IS NULL THEN RAISE EXCEPTION 'session context required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM preservation_fund_settings WHERE district_id = d;
  IF NOT FOUND OR NOT s.grade_card_footnote THEN RETURN jsonb_build_object('shown', false, 'reason', 'footnote_off'); END IF;
  r := eduos_preservation_fund_summary();
  IF (r->>'shown')::boolean THEN r := r || jsonb_build_object('fundName', s.fund_name); END IF;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION eduos_preservation_fund_request(uuid, uuid, text, text, text, text, integer), eduos_preservation_fund_vote(uuid, text, boolean, text),
  eduos_preservation_fund_seat(uuid), eduos_preservation_fund_grade_card_footnote(), eduos_preservation_fund_disbursement_guard() FROM PUBLIC;

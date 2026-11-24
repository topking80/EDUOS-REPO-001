-- TC-12: the district community preservation fund. SANDBOX / LEDGER ONLY.
--
-- Gifts (TC-09) pool into one district fund, restricted to a school when the
-- donor chose one. The district writes down what the fund is for, what it can
-- pay for, how money is allocated, its refund policy and who decides. Nothing
-- in the fund names a student, and spending is limited to district-wide
-- preservation categories: no student quota, no preferential access.
--
-- Everything starts off:
--   * the fund is disabled;
--   * collection stays closed until legal, finance and governance approvals
--     are documented (one record each), the fund is enabled and collection
--     isn't paused. A trigger on history_donations enforces this, so no gift
--     can start while it's closed, whatever the API does;
--   * disbursement can be paused separately.
--
-- A disbursement is requested by finance (TC-10: the superintendent or a named
-- reviewer), against one source (unrestricted, or one school's restricted
-- gifts), for no more than that source has. It needs approvals_required
-- approvals (default 2) from finance people other than the requester, each
-- attesting no conflict of interest; one rejection rejects it. Payment is
-- recorded (sandbox: no money moves) by someone other than the requester and
-- posts an append-only fund ledger line.
--
-- Numbered 137: 132 TC-08, 133 weather fix, 134 TC-11, 135 TC-09, 136 TC-10.

CREATE TABLE preservation_fund_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  enabled boolean NOT NULL DEFAULT false,
  collection_paused boolean NOT NULL DEFAULT false,
  disbursement_paused boolean NOT NULL DEFAULT false,
  pause_reason text CHECK (pause_reason IS NULL OR length(btrim(pause_reason)) BETWEEN 5 AND 500),
  fund_name text NOT NULL DEFAULT 'Student history preservation fund' CHECK (length(btrim(fund_name)) BETWEEN 3 AND 120),
  purpose text NOT NULL DEFAULT 'Keeping student histories safe and readable for the long term, for every student in the district.'
    CHECK (length(btrim(purpose)) BETWEEN 20 AND 1000),
  eligible_categories text[] NOT NULL DEFAULT '{storage,archival_media,format_migration,backup,archive_accessibility}'
    CHECK (cardinality(eligible_categories) BETWEEN 1 AND 6
           AND eligible_categories <@ '{storage,archival_media,format_migration,backup,archive_accessibility,other_preservation}'::text[]),
  allocation_rules text CHECK (allocation_rules IS NULL OR length(btrim(allocation_rules)) BETWEEN 10 AND 2000),
  governance_text text CHECK (governance_text IS NULL OR length(btrim(governance_text)) BETWEEN 10 AND 2000),
  refund_policy text CHECK (refund_policy IS NULL OR length(btrim(refund_policy)) BETWEEN 10 AND 1000),
  approvals_required integer NOT NULL DEFAULT 2 CHECK (approvals_required BETWEEN 2 AND 5),
  public_report boolean NOT NULL DEFAULT false,
  report_min_donors integer NOT NULL DEFAULT 5 CHECK (report_min_donors BETWEEN 3 AND 100),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT (collection_paused OR disbursement_paused) OR pause_reason IS NOT NULL)
);

-- The documented approvals that open collection. Kept, never edited.
CREATE TABLE preservation_fund_governance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  kind text NOT NULL CHECK (kind IN ('legal','finance','governance')),
  reference text NOT NULL CHECK (length(btrim(reference)) BETWEEN 5 AND 300),
  approved_on date NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX preservation_fund_governance_records_district ON preservation_fund_governance_records(district_id, kind);

CREATE TABLE preservation_fund_disbursements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  source_school_id uuid,
  category text NOT NULL CHECK (category IN ('storage','archival_media','format_migration','backup','archive_accessibility','other_preservation')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 10 AND 1000),
  payee text NOT NULL CHECK (length(btrim(payee)) BETWEEN 2 AND 200),
  invoice_ref text NOT NULL CHECK (length(btrim(invoice_ref)) BETWEEN 2 AND 120),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 100 AND 100000000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn','cancelled','paid')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  closed_by uuid REFERENCES users(id),
  close_reason text CHECK (close_reason IS NULL OR length(btrim(close_reason)) BETWEEN 5 AND 500),
  paid_by uuid REFERENCES users(id),
  paid_at timestamptz,
  payment_ref text CHECK (payment_ref IS NULL OR length(btrim(payment_ref)) BETWEEN 2 AND 120),
  test_mode boolean NOT NULL DEFAULT true CHECK (test_mode),
  UNIQUE (district_id, id),
  FOREIGN KEY (district_id, source_school_id) REFERENCES schools(district_id, id),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CHECK (paid_by IS NULL OR paid_by <> requested_by)
);
CREATE INDEX preservation_fund_disbursements_district ON preservation_fund_disbursements(district_id, requested_at DESC);

CREATE TABLE preservation_fund_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  disbursement_id uuid NOT NULL,
  voter uuid NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approve','reject')),
  no_conflict boolean NOT NULL CHECK (no_conflict),
  note text CHECK (note IS NULL OR length(note) <= 500),
  decided_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (disbursement_id, voter),
  FOREIGN KEY (district_id, disbursement_id) REFERENCES preservation_fund_disbursements(district_id, id)
);

CREATE TABLE preservation_fund_ledger (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  disbursement_id uuid NOT NULL UNIQUE,
  source_school_id uuid,
  kind text NOT NULL CHECK (kind = 'disbursement'),
  amount_cents integer NOT NULL CHECK (amount_cents < 0),
  category text NOT NULL,
  test_mode boolean NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, disbursement_id) REFERENCES preservation_fund_disbursements(district_id, id)
);

CREATE TRIGGER preservation_fund_governance_records_append_only BEFORE UPDATE OR DELETE ON preservation_fund_governance_records
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_append_only();
CREATE TRIGGER preservation_fund_votes_append_only BEFORE UPDATE OR DELETE ON preservation_fund_votes
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_append_only();
CREATE TRIGGER preservation_fund_ledger_append_only BEFORE UPDATE OR DELETE ON preservation_fund_ledger
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_append_only();
CREATE FUNCTION eduos_preservation_fund_disbursement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'disbursement records are kept' USING ERRCODE = '42501'; END IF;
  IF NEW.district_id <> OLD.district_id OR NEW.source_school_id IS DISTINCT FROM OLD.source_school_id OR NEW.category <> OLD.category
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
CREATE TRIGGER preservation_fund_disbursements_guard BEFORE UPDATE OR DELETE ON preservation_fund_disbursements
  FOR EACH ROW EXECUTE FUNCTION eduos_preservation_fund_disbursement_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['preservation_fund_settings','preservation_fund_governance_records','preservation_fund_disbursements','preservation_fund_votes','preservation_fund_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- Settings and governance records: everyone in the district reads them (they
-- are the fund's public disclosures); only the superintendent writes, signed.
CREATE POLICY scope_insert ON preservation_fund_settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND updated_by = eduos_ctx_user()));
CREATE POLICY scope_update ON preservation_fund_settings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent')
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND updated_by = eduos_ctx_user()));
CREATE POLICY scope_insert ON preservation_fund_governance_records AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND recorded_by = eduos_ctx_user()));
-- Disbursements, votes and the fund ledger: finance only; written by functions.
CREATE POLICY scope_read ON preservation_fund_disbursements AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance());
CREATE POLICY scope_insert ON preservation_fund_disbursements AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_update ON preservation_fund_disbursements AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_delete ON preservation_fund_disbursements AS RESTRICTIVE FOR DELETE USING (eduos_is_table_owner());
CREATE POLICY scope_read ON preservation_fund_votes AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance());
CREATE POLICY scope_write ON preservation_fund_votes AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_read ON preservation_fund_ledger AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance());
CREATE POLICY scope_write ON preservation_fund_ledger AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());

-- Is collection open? Fund enabled, not paused, all three approvals documented.
CREATE FUNCTION eduos_preservation_fund_collection_open(p_district uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT s.enabled AND NOT s.collection_paused FROM preservation_fund_settings s WHERE s.district_id = p_district), false)
     AND (SELECT count(DISTINCT kind) FROM preservation_fund_governance_records g WHERE g.district_id = p_district) = 3
$$;
CREATE FUNCTION eduos_preservation_fund_gift_gate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT eduos_preservation_fund_collection_open(NEW.district_id) THEN
    RAISE EXCEPTION 'fund_collection_closed' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_donations_fund_gate BEFORE INSERT ON history_donations FOR EACH ROW EXECUTE FUNCTION eduos_preservation_fund_gift_gate();

-- What a source (NULL = unrestricted) has to spend: its gifts' ledger lines,
-- less what was paid out and what is approved but not yet paid.
CREATE FUNCTION eduos_preservation_fund_available(p_district uuid, p_school uuid) RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT sum(l.amount_cents) FROM history_donation_ledger l JOIN history_donations g ON g.id = l.donation_id
                    WHERE l.district_id = p_district AND g.school_id IS NOT DISTINCT FROM p_school), 0)
       + coalesce((SELECT sum(f.amount_cents) FROM preservation_fund_ledger f
                    WHERE f.district_id = p_district AND f.source_school_id IS NOT DISTINCT FROM p_school), 0)
       - coalesce((SELECT sum(d.amount_cents) FROM preservation_fund_disbursements d
                    WHERE d.district_id = p_district AND d.status = 'approved' AND d.source_school_id IS NOT DISTINCT FROM p_school), 0)
$$;

CREATE FUNCTION eduos_preservation_fund_request(p_school uuid, p_category text, p_description text, p_payee text, p_invoice text, p_amount integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); s preservation_fund_settings; rid uuid;
BEGIN
  IF d IS NULL OR NOT eduos_history_donation_finance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM preservation_fund_settings WHERE district_id = d FOR SHARE;
  IF NOT FOUND OR NOT s.enabled THEN RAISE EXCEPTION 'fund_not_enabled' USING ERRCODE = '55000'; END IF;
  IF s.disbursement_paused THEN RAISE EXCEPTION 'disbursement_paused' USING ERRCODE = '55000'; END IF;
  IF NOT (p_category = ANY (s.eligible_categories)) THEN RAISE EXCEPTION 'category_not_eligible' USING ERRCODE = '22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('preservation_fund:' || d::text, 0));
  IF p_amount IS NULL OR p_amount > eduos_preservation_fund_available(d, p_school) THEN RAISE EXCEPTION 'insufficient_funds' USING ERRCODE = '55000'; END IF;
  INSERT INTO preservation_fund_disbursements(district_id, source_school_id, category, description, payee, invoice_ref, amount_cents, requested_by)
    VALUES (d, p_school, p_category, btrim(p_description), btrim(p_payee), btrim(p_invoice), p_amount, eduos_ctx_user()) RETURNING id INTO rid;
  RETURN rid;
END $$;

CREATE FUNCTION eduos_preservation_fund_vote(p_id uuid, p_decision text, p_no_conflict boolean, p_note text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); s preservation_fund_settings; x preservation_fund_disbursements; n int;
BEGIN
  IF d IS NULL OR NOT eduos_history_donation_finance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_no_conflict IS NOT TRUE THEN RAISE EXCEPTION 'conflict_declared' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM preservation_fund_settings WHERE district_id = d;
  IF s.disbursement_paused THEN RAISE EXCEPTION 'disbursement_paused' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('preservation_fund:' || d::text, 0));
  SELECT * INTO x FROM preservation_fund_disbursements WHERE id = p_id AND district_id = d FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF x.requested_by = eduos_ctx_user() THEN RAISE EXCEPTION 'requester_cannot_approve' USING ERRCODE = '42501'; END IF;
  IF x.status <> 'pending' THEN RAISE EXCEPTION 'not_pending' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM preservation_fund_votes WHERE disbursement_id = x.id AND voter = eduos_ctx_user()) THEN
    RAISE EXCEPTION 'already_decided' USING ERRCODE = '55000';
  END IF;
  INSERT INTO preservation_fund_votes(district_id, disbursement_id, voter, decision, no_conflict, note)
    VALUES (d, x.id, eduos_ctx_user(), p_decision, true, nullif(btrim(coalesce(p_note, '')), ''));
  IF p_decision = 'reject' THEN
    UPDATE preservation_fund_disbursements SET status = 'rejected', decided_at = now() WHERE id = x.id;
    RETURN 'rejected';
  END IF;
  SELECT count(*) INTO n FROM preservation_fund_votes WHERE disbursement_id = x.id AND decision = 'approve';
  IF n >= s.approvals_required THEN
    IF x.amount_cents > eduos_preservation_fund_available(d, x.source_school_id) THEN RAISE EXCEPTION 'insufficient_funds' USING ERRCODE = '55000'; END IF;
    UPDATE preservation_fund_disbursements SET status = 'approved', decided_at = now() WHERE id = x.id;
    RETURN 'approved';
  END IF;
  RETURN 'pending';
END $$;

CREATE FUNCTION eduos_preservation_fund_pay(p_id uuid, p_payment_ref text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); s preservation_fund_settings; x preservation_fund_disbursements; lid uuid;
BEGIN
  IF d IS NULL OR NOT eduos_history_donation_finance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM preservation_fund_settings WHERE district_id = d;
  IF s.disbursement_paused THEN RAISE EXCEPTION 'disbursement_paused' USING ERRCODE = '55000'; END IF;
  SELECT * INTO x FROM preservation_fund_disbursements WHERE id = p_id AND district_id = d FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF x.requested_by = eduos_ctx_user() THEN RAISE EXCEPTION 'requester_cannot_pay' USING ERRCODE = '42501'; END IF;
  IF x.status <> 'approved' THEN RAISE EXCEPTION 'not_approved' USING ERRCODE = '55000'; END IF;
  UPDATE preservation_fund_disbursements SET status = 'paid', paid_by = eduos_ctx_user(), paid_at = now(), payment_ref = btrim(p_payment_ref) WHERE id = x.id;
  INSERT INTO preservation_fund_ledger(district_id, disbursement_id, source_school_id, kind, amount_cents, category, test_mode, recorded_by)
    VALUES (d, x.id, x.source_school_id, 'disbursement', -x.amount_cents, x.category, x.test_mode, eduos_ctx_user()) RETURNING id INTO lid;
  RETURN lid;
END $$;

-- The requester withdraws a pending request; finance cancels an approved one.
CREATE FUNCTION eduos_preservation_fund_close(p_id uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); x preservation_fund_disbursements; st text;
BEGIN
  IF d IS NULL OR NOT eduos_history_donation_finance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO x FROM preservation_fund_disbursements WHERE id = p_id AND district_id = d FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF x.status = 'pending' AND x.requested_by = eduos_ctx_user() THEN st := 'withdrawn';
  ELSIF x.status = 'approved' THEN st := 'cancelled';
  ELSE RAISE EXCEPTION 'cannot_close' USING ERRCODE = '55000'; END IF;
  UPDATE preservation_fund_disbursements SET status = st, closed_by = eduos_ctx_user(), close_reason = btrim(p_reason), decided_at = coalesce(decided_at, now()) WHERE id = x.id;
  RETURN st;
END $$;

-- The district-level summary anyone in the district may see: no names, no
-- per-gift amounts, and totals only once enough people have given.
CREATE FUNCTION eduos_preservation_fund_summary() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); s preservation_fund_settings; donors int; r jsonb;
BEGIN
  IF d IS NULL OR eduos_ctx_user() IS NULL THEN RAISE EXCEPTION 'session context required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO s FROM preservation_fund_settings WHERE district_id = d;
  IF NOT FOUND OR NOT s.public_report THEN RETURN jsonb_build_object('shown', false, 'reason', 'not_published'); END IF;
  SELECT count(DISTINCT g.donor_user_id) INTO donors FROM history_donations g WHERE g.district_id = d AND g.status = 'succeeded';
  IF donors < s.report_min_donors THEN RETURN jsonb_build_object('shown', false, 'reason', 'too_few_donors', 'minDonors', s.report_min_donors); END IF;
  SELECT jsonb_build_object('shown', true,
    'givenCents', coalesce((SELECT sum(amount_cents) FROM history_donation_ledger WHERE district_id = d AND kind IN ('gift','refund')), 0),
    'feesCents', -coalesce((SELECT sum(amount_cents) FROM history_donation_ledger WHERE district_id = d AND kind = 'processing_fee'), 0),
    'spentCents', -coalesce((SELECT sum(amount_cents) FROM preservation_fund_ledger WHERE district_id = d), 0),
    'spentByCategory', coalesce((SELECT jsonb_object_agg(category, -total) FROM (SELECT category, sum(amount_cents) AS total FROM preservation_fund_ledger
                                  WHERE district_id = d GROUP BY category) c), '{}'::jsonb))
    INTO r;
  RETURN r;
END $$;

REVOKE ALL ON FUNCTION eduos_preservation_fund_collection_open(uuid), eduos_preservation_fund_gift_gate(), eduos_preservation_fund_available(uuid, uuid),
  eduos_preservation_fund_request(uuid, text, text, text, text, integer), eduos_preservation_fund_vote(uuid, text, boolean, text),
  eduos_preservation_fund_pay(uuid, text), eduos_preservation_fund_close(uuid, text), eduos_preservation_fund_summary(),
  eduos_preservation_fund_disbursement_guard() FROM PUBLIC;

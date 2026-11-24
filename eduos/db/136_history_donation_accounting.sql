-- TC-10: donation accounting, refunds, reconciliation and receipts. SANDBOX ONLY.
--
-- Builds on TC-09 (db/135). Every completed gift writes ledger lines (the gift
-- and the processor's fee); a refund writes a refund line. The ledger is
-- append-only and only definer functions write it.
--
-- Separation of duties. There is no finance role, so the superintendent names
-- district staff as donation finance reviewers. The superintendent and the
-- reviewers can refund and reconcile, with two rules enforced here:
--   * nobody refunds their own gift;
--   * nobody reconciles a period in which they recorded a refund.
--
-- Receipts: a refund gets its own plain notice (the gift's number plus "-R"),
-- like the acknowledgement it makes no tax claim. Refunds keep the processor's
-- fee (as card processors do), so a refunded gift nets to minus the fee.
--
-- Numbered 136: 132 TC-08, 133 weather fix, 134 TC-11, 135 TC-09.

CREATE TABLE history_donation_finance_reviewers (
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  named_by uuid NOT NULL REFERENCES users(id),
  named_at timestamptz NOT NULL DEFAULT now(),
  removed_by uuid REFERENCES users(id),
  removed_at timestamptz,
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX history_donation_finance_reviewers_active ON history_donation_finance_reviewers(district_id, user_id) WHERE removed_at IS NULL;

CREATE TABLE history_donation_ledger (
  seq bigserial PRIMARY KEY,
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  donation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('gift','processing_fee','refund')),
  amount_cents integer NOT NULL CHECK ((kind = 'gift' AND amount_cents > 0) OR (kind <> 'gift' AND amount_cents < 0)),
  currency char(3) NOT NULL CHECK (currency = 'USD'),
  provider_ref text NOT NULL,
  test_mode boolean NOT NULL,
  recorded_by uuid REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (donation_id, kind),
  FOREIGN KEY (district_id, donation_id) REFERENCES history_donations(district_id, id)
);
CREATE INDEX history_donation_ledger_district ON history_donation_ledger(district_id, recorded_at);

CREATE TABLE history_donation_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  donation_id uuid NOT NULL UNIQUE,
  number text NOT NULL CHECK (number ~ '^GIFT-[0-9]{4}-[0-9]{6}-R$'),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
  refund_ref text NOT NULL CHECK (refund_ref ~ '^re_sandbox_[0-9a-f]{24}$'),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  fee_kept_cents integer NOT NULL CHECK (fee_kept_cents >= 0),
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  test_mode boolean NOT NULL,
  UNIQUE (district_id, number),
  FOREIGN KEY (district_id, donation_id) REFERENCES history_donations(district_id, id)
);

CREATE TABLE history_donation_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  gifts integer NOT NULL,
  gross_cents bigint NOT NULL,
  fees_cents bigint NOT NULL,
  refunds integer NOT NULL,
  refunded_cents bigint NOT NULL,
  net_cents bigint NOT NULL,
  ledger_net_cents bigint NOT NULL,
  ledger_lines integer NOT NULL,
  matched boolean NOT NULL,
  discrepancies jsonb NOT NULL DEFAULT '[]',
  note text CHECK (note IS NULL OR length(note) <= 1000),
  reconciled_by uuid NOT NULL REFERENCES users(id),
  reconciled_at timestamptz NOT NULL DEFAULT now(),
  test_mode boolean NOT NULL DEFAULT true,
  CHECK (period_start <= period_end AND period_end - period_start <= 366)
);
CREATE INDEX history_donation_reconciliations_district ON history_donation_reconciliations(district_id, reconciled_at DESC);

CREATE TRIGGER history_donation_ledger_append_only BEFORE UPDATE OR DELETE ON history_donation_ledger
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_append_only();
CREATE TRIGGER history_donation_refunds_append_only BEFORE UPDATE OR DELETE ON history_donation_refunds
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_append_only();
CREATE TRIGGER history_donation_reconciliations_append_only BEFORE UPDATE OR DELETE ON history_donation_reconciliations
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_append_only();
CREATE FUNCTION eduos_history_donation_reviewer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'reviewer history is kept' USING ERRCODE = '42501'; END IF;
  IF NEW.district_id <> OLD.district_id OR NEW.user_id <> OLD.user_id OR NEW.named_by <> OLD.named_by OR NEW.named_at <> OLD.named_at
     OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'reviewer records only change by being removed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_donation_finance_reviewers_guard BEFORE UPDATE OR DELETE ON history_donation_finance_reviewers
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_reviewer_guard();

-- Is the session user allowed to see and act on the district's gift accounts?
CREATE FUNCTION eduos_history_donation_finance() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() = 'superintendent'
      OR (coalesce(eduos_ctx_role(), 'pupil') NOT IN ('parent','pupil') AND EXISTS (SELECT 1 FROM history_donation_finance_reviewers r
           WHERE r.district_id = eduos_ctx_district() AND r.user_id = eduos_ctx_user() AND r.removed_at IS NULL))
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['history_donation_finance_reviewers','history_donation_ledger','history_donation_refunds','history_donation_reconciliations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- Reviewers: the superintendent names and removes them; a reviewer can see
-- their own appointment. Writes only through the functions below.
CREATE POLICY scope_read ON history_donation_finance_reviewers AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent' OR user_id = eduos_ctx_user());
CREATE POLICY scope_write ON history_donation_finance_reviewers AS RESTRICTIVE FOR ALL
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent') WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_read ON history_donation_ledger AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance());
CREATE POLICY scope_write ON history_donation_ledger AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_read ON history_donation_refunds AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance()
         OR EXISTS (SELECT 1 FROM history_donations g WHERE g.id = donation_id AND g.donor_user_id = eduos_ctx_user()));
CREATE POLICY scope_write ON history_donation_refunds AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_read ON history_donation_reconciliations AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance());
CREATE POLICY scope_write ON history_donation_reconciliations AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());

-- Reviewers also read the district's gifts and acknowledgements (TC-09 let only
-- the superintendent and the donor).
DROP POLICY scope_read ON history_donations;
CREATE POLICY scope_read ON history_donations AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR donor_user_id = eduos_ctx_user() OR eduos_history_donation_finance());
DROP POLICY scope_read ON history_donation_acknowledgements;
CREATE POLICY scope_read ON history_donation_acknowledgements AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_history_donation_finance()
         OR EXISTS (SELECT 1 FROM history_donations g WHERE g.id = donation_id AND g.donor_user_id = eduos_ctx_user()));

-- Ledger lines for a completed gift. Idempotent.
CREATE FUNCTION eduos_history_donation_post_gift(p_donation uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g history_donations;
BEGIN
  SELECT * INTO g FROM history_donations WHERE id = p_donation;
  IF NOT FOUND OR g.status NOT IN ('succeeded','refunded') THEN RETURN; END IF;
  INSERT INTO history_donation_ledger(district_id, donation_id, kind, amount_cents, currency, provider_ref, test_mode, recorded_by, recorded_at)
    VALUES (g.district_id, g.id, 'gift', g.amount_cents, g.currency, g.provider_ref, g.mode = 'test', g.donor_user_id, coalesce(g.confirmed_at, now()))
    ON CONFLICT (donation_id, kind) DO NOTHING;
  IF g.processing_fee_cents > 0 THEN
    INSERT INTO history_donation_ledger(district_id, donation_id, kind, amount_cents, currency, provider_ref, test_mode, recorded_by, recorded_at)
      VALUES (g.district_id, g.id, 'processing_fee', -g.processing_fee_cents, g.currency, g.provider_ref, g.mode = 'test', NULL, coalesce(g.confirmed_at, now()))
      ON CONFLICT (donation_id, kind) DO NOTHING;
  END IF;
END $$;

-- TC-09's outcome function now also posts the ledger lines.
CREATE OR REPLACE FUNCTION eduos_history_donation_record(p_donation uuid, p_outcome text, p_decline_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); g history_donations; s district_donation_settings; ack uuid; yr int; n int; dname text; desig text;
BEGIN
  IF d IS NULL OR eduos_ctx_user() IS NULL THEN RAISE EXCEPTION 'session context required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO g FROM history_donations WHERE id = p_donation AND district_id = d FOR UPDATE;
  IF NOT FOUND OR g.donor_user_id <> eduos_ctx_user() THEN RAISE EXCEPTION 'donation_not_found' USING ERRCODE = 'P0002'; END IF;
  IF g.status <> 'pending' THEN
    SELECT id INTO ack FROM history_donation_acknowledgements WHERE donation_id = g.id;
    IF g.status = 'succeeded' AND p_outcome = 'succeeded' THEN RETURN ack; END IF;
    RAISE EXCEPTION 'donation_not_pending' USING ERRCODE = '55000';
  END IF;
  IF p_outcome IN ('declined','expired') THEN
    UPDATE history_donations SET status = p_outcome, decline_code = p_decline_code, confirmed_at = now() WHERE id = g.id;
    RETURN NULL;
  ELSIF p_outcome <> 'succeeded' THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;
  UPDATE history_donations SET status = 'succeeded', confirmed_at = now() WHERE id = g.id;
  PERFORM eduos_history_donation_post_gift(g.id);
  SELECT * INTO s FROM district_donation_settings WHERE district_id = d;
  yr := extract(year FROM now() AT TIME ZONE 'UTC')::int;
  INSERT INTO history_donation_counters(district_id, year, last_number) VALUES (d, yr, 1)
    ON CONFLICT (district_id, year) DO UPDATE SET last_number = history_donation_counters.last_number + 1
    RETURNING last_number INTO n;
  SELECT name INTO dname FROM districts WHERE id = d;
  IF g.school_id IS NULL THEN desig := 'Student history preservation, ' || dname;
  ELSE SELECT 'Student history preservation, ' || name INTO desig FROM schools WHERE id = g.school_id AND district_id = d; END IF;
  INSERT INTO history_donation_acknowledgements(district_id, donation_id, number, district_name, designation, donor_name, amount_cents, currency, body, tax_wording, test_mode)
    VALUES (d, g.id, format('GIFT-%s-%s', yr, lpad(n::text, 6, '0')), dname, desig, g.donor_name, g.amount_cents, g.currency,
            coalesce(s.acknowledgement_text, 'Thank you for your voluntary gift to help keep student histories safe. This is a record of your gift.'),
            CASE WHEN coalesce(s.tax_wording_enabled, false) THEN s.tax_wording END, g.mode = 'test')
    RETURNING id INTO ack;
  RETURN ack;
END $$;

-- Backfill: gifts completed before this migration.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM history_donations WHERE status IN ('succeeded','refunded') LOOP
    PERFORM eduos_history_donation_post_gift(r.id);
  END LOOP;
END $$;

-- Name or remove a finance reviewer (superintendent only). A reviewer is staff in
-- the district (any role but parent or pupil) and acts as reviewer only while
-- signed in under a staff role.
CREATE FUNCTION eduos_history_donation_reviewer_set(p_user uuid, p_on boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); rid uuid;
BEGIN
  IF d IS NULL OR eduos_ctx_role() IS DISTINCT FROM 'superintendent' THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_on THEN
    IF NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = p_user AND m.district_id = d AND m.status = 'active' AND m.role NOT IN ('parent','pupil','superintendent')) THEN
      RAISE EXCEPTION 'reviewer_must_be_staff' USING ERRCODE = '22023';
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

-- Record a sandbox refund of a completed gift.
CREATE FUNCTION eduos_history_donation_refund(p_donation uuid, p_refund_ref text, p_reason text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); g history_donations; num text; rid uuid;
BEGIN
  IF d IS NULL OR NOT eduos_history_donation_finance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  SELECT * INTO g FROM history_donations WHERE id = p_donation AND district_id = d FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'donation_not_found' USING ERRCODE = 'P0002'; END IF;
  IF g.donor_user_id = eduos_ctx_user() THEN RAISE EXCEPTION 'own_gift' USING ERRCODE = '42501'; END IF;
  IF g.status <> 'succeeded' THEN RAISE EXCEPTION 'donation_not_refundable' USING ERRCODE = '55000'; END IF;
  SELECT number || '-R' INTO num FROM history_donation_acknowledgements WHERE donation_id = g.id;
  IF num IS NULL THEN RAISE EXCEPTION 'donation_not_refundable' USING ERRCODE = '55000'; END IF;
  UPDATE history_donations SET status = 'refunded', refund_ref = p_refund_ref, refunded_at = now() WHERE id = g.id;
  PERFORM eduos_history_donation_post_gift(g.id);
  INSERT INTO history_donation_ledger(district_id, donation_id, kind, amount_cents, currency, provider_ref, test_mode, recorded_by)
    VALUES (d, g.id, 'refund', -g.amount_cents, g.currency, p_refund_ref, g.mode = 'test', eduos_ctx_user());
  INSERT INTO history_donation_refunds(district_id, donation_id, number, reason, refund_ref, amount_cents, fee_kept_cents, recorded_by, test_mode)
    VALUES (d, g.id, num, btrim(p_reason), p_refund_ref, g.amount_cents, g.processing_fee_cents, eduos_ctx_user(), g.mode = 'test')
    RETURNING id INTO rid;
  RETURN rid;
END $$;

-- The reconciliation report for a period (UTC dates, inclusive): gifts and
-- refunds from the gift records against the ledger, line by line.
CREATE FUNCTION eduos_history_donation_reconciliation(p_from date, p_to date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); lo timestamptz; hi timestamptz; r jsonb; issues jsonb;
BEGIN
  IF d IS NULL OR NOT eduos_history_donation_finance() THEN RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to OR p_to - p_from > 366 THEN RAISE EXCEPTION 'invalid_period' USING ERRCODE = '22023'; END IF;
  lo := p_from::timestamp AT TIME ZONE 'UTC'; hi := (p_to + 1)::timestamp AT TIME ZONE 'UTC';
  WITH gifts AS (
    SELECT g.id, g.amount_cents, g.processing_fee_cents FROM history_donations g
     WHERE g.district_id = d AND g.status IN ('succeeded','refunded') AND g.confirmed_at >= lo AND g.confirmed_at < hi),
  refunds AS (
    SELECT g.id, g.amount_cents FROM history_donations g
     WHERE g.district_id = d AND g.status = 'refunded' AND g.refunded_at >= lo AND g.refunded_at < hi),
  expected AS (
    SELECT id, 'gift'::text AS kind, amount_cents::bigint AS cents FROM gifts
    UNION ALL SELECT id, 'processing_fee', -processing_fee_cents FROM gifts WHERE processing_fee_cents > 0
    UNION ALL SELECT id, 'refund', -amount_cents FROM refunds),
  ledger AS (
    SELECT l.donation_id AS id, l.kind, l.amount_cents::bigint AS cents FROM history_donation_ledger l
     WHERE l.district_id = d AND l.recorded_at >= lo AND l.recorded_at < hi),
  diff AS (
    SELECT coalesce(e.id, l.id) AS donation, coalesce(e.kind, l.kind) AS kind, e.cents AS expected, l.cents AS ledger
      FROM expected e FULL JOIN ledger l ON l.id = e.id AND l.kind = e.kind
     WHERE e.cents IS DISTINCT FROM l.cents)
  SELECT jsonb_build_object(
    'gifts', (SELECT count(*) FROM gifts), 'grossCents', (SELECT coalesce(sum(amount_cents),0) FROM gifts),
    'feesCents', (SELECT coalesce(sum(processing_fee_cents),0) FROM gifts),
    'refunds', (SELECT count(*) FROM refunds), 'refundedCents', (SELECT coalesce(sum(amount_cents),0) FROM refunds),
    'netCents', (SELECT coalesce(sum(cents),0) FROM expected),
    'ledgerNetCents', (SELECT coalesce(sum(cents),0) FROM ledger), 'ledgerLines', (SELECT count(*) FROM ledger),
    'discrepancies', coalesce((SELECT jsonb_agg(jsonb_build_object('donationId', donation, 'kind', kind, 'expectedCents', expected, 'ledgerCents', ledger)
                                ORDER BY donation, kind) FROM diff), '[]'::jsonb))
    INTO r;
  RETURN r || jsonb_build_object('matched', jsonb_array_length(r->'discrepancies') = 0, 'periodStart', p_from, 'periodEnd', p_to);
END $$;

-- Sign off a period. The person who recorded a refund in it can't.
CREATE FUNCTION eduos_history_donation_reconcile(p_from date, p_to date, p_note text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); r jsonb; rid uuid;
BEGIN
  r := eduos_history_donation_reconciliation(p_from, p_to);
  IF EXISTS (SELECT 1 FROM history_donation_refunds f WHERE f.district_id = d AND f.recorded_by = eduos_ctx_user()
              AND f.recorded_at >= p_from::timestamp AT TIME ZONE 'UTC' AND f.recorded_at < (p_to + 1)::timestamp AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'separation_of_duties' USING ERRCODE = '42501';
  END IF;
  INSERT INTO history_donation_reconciliations(district_id, period_start, period_end, gifts, gross_cents, fees_cents, refunds, refunded_cents, net_cents,
      ledger_net_cents, ledger_lines, matched, discrepancies, note, reconciled_by)
    VALUES (d, p_from, p_to, (r->>'gifts')::int, (r->>'grossCents')::bigint, (r->>'feesCents')::bigint, (r->>'refunds')::int, (r->>'refundedCents')::bigint,
      (r->>'netCents')::bigint, (r->>'ledgerNetCents')::bigint, (r->>'ledgerLines')::int, (r->>'matched')::boolean, r->'discrepancies',
      nullif(btrim(coalesce(p_note, '')), ''), eduos_ctx_user())
    RETURNING id INTO rid;
  RETURN rid;
END $$;

REVOKE ALL ON FUNCTION eduos_history_donation_finance(), eduos_history_donation_post_gift(uuid), eduos_history_donation_reviewer_set(uuid, boolean),
  eduos_history_donation_refund(uuid, text, text), eduos_history_donation_reconciliation(date, date), eduos_history_donation_reconcile(date, date, text),
  eduos_history_donation_reviewer_guard() FROM PUBLIC;

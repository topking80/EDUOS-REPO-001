-- TC-13: recurring gifts (district decision 2026-11-24: donors choose a
-- one-time or a recurring gift). SANDBOX ONLY, like every gift (db/135).
--
-- A donor starts a monthly or yearly schedule from the same give screen. The
-- first charge is an ordinary pending gift (installment 1) that the donor
-- confirms; when it succeeds the schedule becomes active, anchored on that
-- day. Later charges are made by the schedule job (src/donation-schedules.js)
-- through the sandbox processor: each one is its own history_donations row with
-- its own acknowledgement, and each posts the same gift and fee lines to the
-- append-only ledger (TC-10), so refunds and reconciliation work per charge.
--
-- Nothing moves real money: provider and mode only accept 'sandbox'/'test',
-- whatever processor or live switch is configured.
--
--   * The donor (or district finance, on the donor's request) can cancel at
--     any time; cancelling stops future charges and keeps past ones.
--   * A charge waits (the schedule is not advanced) while donations, recurring
--     gifts or fund collection are off, so nobody is charged into a closed fund.
--   * Three declines in a row stop the schedule.
--   * Missed dates (the job didn't run, or charges were held) are not made up:
--     the next run makes one charge and moves on to the next date after today.
--   * Recurring gifts are on by default once a district turns donations on
--     (recurring_enabled); the district can turn them off.
--
-- Numbered 139: 135 TC-09, 136 TC-10, 137 TC-12, 138 TC-12 follow-up, 150 clients/02-tv.

ALTER TABLE district_donation_settings ADD COLUMN recurring_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE history_donation_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  donor_user_id uuid NOT NULL REFERENCES users(id),
  donor_name text NOT NULL CHECK (length(btrim(donor_name)) BETWEEN 1 AND 200),
  anonymous boolean NOT NULL DEFAULT false,
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 100 AND 10000000),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  frequency text NOT NULL CHECK (frequency IN ('monthly','yearly')),
  payment_method text NOT NULL CHECK (payment_method IN ('sandbox','paypal','card','venmo','cash_app','bitcoin')),
  provider text NOT NULL DEFAULT 'sandbox' CHECK (provider = 'sandbox'),
  mode text NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','failed','cancelled','stopped')),
  anchor_on date,
  next_charge_on date,
  periods integer NOT NULL DEFAULT 0 CHECK (periods >= 0),
  consecutive_declines integer NOT NULL DEFAULT 0 CHECK (consecutive_declines >= 0),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  last_charge_at timestamptz,
  ended_at timestamptz,
  ended_by uuid REFERENCES users(id),
  end_reason text CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 3 AND 500),
  UNIQUE (district_id, donor_user_id, idempotency_key),
  UNIQUE (district_id, id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  CHECK ((status = 'active') = (next_charge_on IS NOT NULL)),
  CHECK (status NOT IN ('cancelled','stopped','failed') OR ended_at IS NOT NULL)
);
CREATE INDEX history_donation_schedules_due ON history_donation_schedules(district_id, next_charge_on) WHERE status = 'active';
CREATE INDEX history_donation_schedules_donor ON history_donation_schedules(district_id, donor_user_id, created_at DESC);

ALTER TABLE history_donations ADD COLUMN schedule_id uuid, ADD COLUMN installment integer CHECK (installment >= 1),
  ADD CONSTRAINT history_donations_schedule_fk FOREIGN KEY (district_id, schedule_id) REFERENCES history_donation_schedules(district_id, id),
  ADD CONSTRAINT history_donations_schedule_installment CHECK ((schedule_id IS NULL) = (installment IS NULL)),
  ADD CONSTRAINT history_donations_schedule_installment_key UNIQUE (schedule_id, installment);

-- A gift's schedule and installment are part of its fixed terms.
CREATE OR REPLACE FUNCTION eduos_history_donation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'donation records are kept' USING ERRCODE = '42501'; END IF;
  IF NEW.district_id <> OLD.district_id OR NEW.school_id IS DISTINCT FROM OLD.school_id OR NEW.donor_user_id <> OLD.donor_user_id
     OR NEW.donor_name <> OLD.donor_name OR NEW.anonymous <> OLD.anonymous OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.currency <> OLD.currency OR NEW.processing_fee_cents <> OLD.processing_fee_cents OR NEW.payment_method <> OLD.payment_method
     OR NEW.provider <> OLD.provider OR NEW.mode <> OLD.mode OR NEW.provider_ref <> OLD.provider_ref
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at
     OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id OR NEW.installment IS DISTINCT FROM OLD.installment THEN
    RAISE EXCEPTION 'donation terms are fixed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('succeeded','declined','expired'))
                                      OR (OLD.status = 'succeeded' AND NEW.status = 'refunded')) THEN
    RAISE EXCEPTION 'donation cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION eduos_history_donation_schedule_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'schedule records are kept' USING ERRCODE = '42501'; END IF;
  IF NEW.district_id <> OLD.district_id OR NEW.school_id IS DISTINCT FROM OLD.school_id OR NEW.donor_user_id <> OLD.donor_user_id
     OR NEW.donor_name <> OLD.donor_name OR NEW.anonymous <> OLD.anonymous OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.currency <> OLD.currency OR NEW.frequency <> OLD.frequency OR NEW.payment_method <> OLD.payment_method
     OR NEW.provider <> OLD.provider OR NEW.mode <> OLD.mode OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at
     OR (OLD.anchor_on IS NOT NULL AND NEW.anchor_on IS DISTINCT FROM OLD.anchor_on) OR NEW.periods < OLD.periods THEN
    RAISE EXCEPTION 'schedule terms are fixed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('active','failed','cancelled'))
                                      OR (OLD.status = 'active' AND NEW.status IN ('cancelled','stopped'))) THEN
    RAISE EXCEPTION 'schedule cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_donation_schedules_guard BEFORE UPDATE OR DELETE ON history_donation_schedules
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_schedule_guard();

ALTER TABLE history_donation_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE history_donation_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON history_donation_schedules
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
-- The donor sees their own schedules; finance (TC-10) sees the district's.
CREATE POLICY scope_read ON history_donation_schedules AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR donor_user_id = eduos_ctx_user() OR eduos_history_donation_finance());
-- Only an adult starts one, for themself, as pending; everything after that
-- goes through the functions below.
CREATE POLICY scope_insert ON history_donation_schedules AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (donor_user_id = eduos_ctx_user() AND coalesce(eduos_ctx_role(), '') NOT IN ('', 'pupil')
              AND status = 'pending' AND provider = 'sandbox' AND mode = 'test' AND periods = 0 AND anchor_on IS NULL
              AND next_charge_on IS NULL AND activated_at IS NULL AND ended_at IS NULL));
CREATE POLICY scope_update ON history_donation_schedules AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_delete ON history_donation_schedules AS RESTRICTIVE FOR DELETE USING (eduos_is_table_owner());

-- A donor's first installment can only belong to their own pending schedule.
DROP POLICY scope_insert ON history_donations;
CREATE POLICY scope_insert ON history_donations AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (donor_user_id = eduos_ctx_user() AND coalesce(eduos_ctx_role(), '') NOT IN ('', 'pupil')
              AND status = 'pending' AND provider = 'sandbox' AND confirmed_at IS NULL AND refunded_at IS NULL
              AND (schedule_id IS NULL OR (installment = 1 AND EXISTS (SELECT 1 FROM history_donation_schedules s
                     WHERE s.id = schedule_id AND s.donor_user_id = eduos_ctx_user() AND s.status = 'pending'
                       AND s.amount_cents = history_donations.amount_cents AND s.school_id IS NOT DISTINCT FROM history_donations.school_id)))));

CREATE FUNCTION eduos_history_donation_period(p_frequency text) RETURNS interval LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_frequency WHEN 'monthly' THEN interval '1 month' WHEN 'yearly' THEN interval '1 year' END
$$;

-- The success path for a pending gift (internal: callers check who may do it).
-- Posts the ledger lines, issues the acknowledgement, and moves its schedule
-- on: the first installment activates it, anchored today (UTC); a later one
-- clears the decline count. Assumes app.district_id is the gift's district.
CREATE FUNCTION eduos_history_donation_complete(p_donation uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE g history_donations; s district_donation_settings; sch history_donation_schedules; ack uuid; yr int; n int; dname text; desig text; today date;
BEGIN
  SELECT * INTO g FROM history_donations WHERE id = p_donation FOR UPDATE;
  IF NOT FOUND OR g.status <> 'pending' THEN RAISE EXCEPTION 'donation_not_pending' USING ERRCODE = '55000'; END IF;
  UPDATE history_donations SET status = 'succeeded', confirmed_at = now() WHERE id = g.id;
  PERFORM eduos_history_donation_post_gift(g.id);
  SELECT * INTO s FROM district_donation_settings WHERE district_id = g.district_id;
  yr := extract(year FROM now() AT TIME ZONE 'UTC')::int;
  INSERT INTO history_donation_counters(district_id, year, last_number) VALUES (g.district_id, yr, 1)
    ON CONFLICT (district_id, year) DO UPDATE SET last_number = history_donation_counters.last_number + 1
    RETURNING last_number INTO n;
  SELECT name INTO dname FROM districts WHERE id = g.district_id;
  IF g.school_id IS NULL THEN desig := 'Student history preservation, ' || dname;
  ELSE SELECT 'Student history preservation, ' || name INTO desig FROM schools WHERE id = g.school_id AND district_id = g.district_id; END IF;
  IF g.schedule_id IS NOT NULL THEN
    SELECT * INTO sch FROM history_donation_schedules WHERE id = g.schedule_id FOR UPDATE;
    desig := desig || CASE sch.frequency WHEN 'monthly' THEN ' (monthly gift, installment ' ELSE ' (yearly gift, installment ' END || g.installment || ')';
    today := (now() AT TIME ZONE 'UTC')::date;
    IF sch.status = 'pending' AND g.installment = 1 THEN
      UPDATE history_donation_schedules SET status = 'active', activated_at = now(), anchor_on = today, periods = 1,
        next_charge_on = (today + eduos_history_donation_period(sch.frequency))::date, last_charge_at = now(), consecutive_declines = 0
        WHERE id = sch.id;
    ELSIF sch.status = 'active' THEN
      UPDATE history_donation_schedules SET last_charge_at = now(), consecutive_declines = 0 WHERE id = sch.id;
    END IF;
  END IF;
  INSERT INTO history_donation_acknowledgements(district_id, donation_id, number, district_name, designation, donor_name, amount_cents, currency, body, tax_wording, test_mode)
    VALUES (g.district_id, g.id, format('GIFT-%s-%s', yr, lpad(n::text, 6, '0')), dname, desig, g.donor_name, g.amount_cents, g.currency,
            coalesce(s.acknowledgement_text, 'Thank you for your voluntary gift to help keep student histories safe. This is a record of your gift.'),
            CASE WHEN coalesce(s.tax_wording_enabled, false) THEN s.tax_wording END, g.mode = 'test')
    RETURNING id INTO ack;
  RETURN ack;
END $$;

-- The donor records the sandbox's answer for their pending gift (TC-09/TC-10),
-- now through the shared success path. A declined first installment fails its
-- schedule.
CREATE OR REPLACE FUNCTION eduos_history_donation_record(p_donation uuid, p_outcome text, p_decline_code text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); g history_donations; ack uuid;
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
    IF g.schedule_id IS NOT NULL THEN
      UPDATE history_donation_schedules SET status = 'failed', ended_at = now(), end_reason = 'first payment ' || p_outcome
        WHERE id = g.schedule_id AND status = 'pending';
    END IF;
    RETURN NULL;
  ELSIF p_outcome <> 'succeeded' THEN
    RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023';
  END IF;
  RETURN eduos_history_donation_complete(g.id);
END $$;

-- Cancel a schedule: its donor, or district finance on the donor's request.
CREATE FUNCTION eduos_history_donation_schedule_cancel(p_schedule uuid, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); sch history_donation_schedules;
BEGIN
  IF d IS NULL OR eduos_ctx_user() IS NULL THEN RAISE EXCEPTION 'session context required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO sch FROM history_donation_schedules WHERE id = p_schedule AND district_id = d FOR UPDATE;
  IF NOT FOUND OR NOT (sch.donor_user_id = eduos_ctx_user() OR eduos_history_donation_finance()) THEN RAISE EXCEPTION 'not_found' USING ERRCODE = 'P0002'; END IF;
  IF sch.status NOT IN ('pending','active') THEN RAISE EXCEPTION 'schedule_not_active' USING ERRCODE = '55000'; END IF;
  UPDATE history_donation_schedules SET status = 'cancelled', next_charge_on = NULL, ended_at = now(), ended_by = eduos_ctx_user(),
    end_reason = coalesce(nullif(btrim(coalesce(p_reason, '')), ''), CASE WHEN sch.donor_user_id = eduos_ctx_user() THEN 'cancelled by the donor' ELSE 'cancelled by district finance' END)
    WHERE id = sch.id;
  RETURN 'cancelled';
END $$;

-- Schedules due on or before p_as_of, across districts, for the schedule job.
CREATE FUNCTION eduos_history_donation_schedules_due(p_as_of date, p_limit integer DEFAULT 200)
RETURNS TABLE(district_id uuid, schedule_id uuid, installment integer, amount_cents integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid; r record; prior text := current_setting('app.district_id', true); n integer := 0;
BEGIN
  FOR d IN SELECT id FROM public.districts ORDER BY id LOOP
    PERFORM set_config('app.district_id', d::text, true);
    FOR r IN SELECT s.id, s.periods, s.amount_cents FROM public.history_donation_schedules s
              WHERE s.district_id = d AND s.status = 'active' AND s.next_charge_on <= p_as_of
              ORDER BY s.next_charge_on, s.id LIMIT greatest(1, least(p_limit, 1000)) - n LOOP
      district_id := d; schedule_id := r.id; installment := r.periods + 1; amount_cents := r.amount_cents;
      n := n + 1;
      RETURN NEXT;
    END LOOP;
    EXIT WHEN n >= p_limit;
  END LOOP;
  PERFORM set_config('app.district_id', coalesce(prior, ''), true);
END $$;

-- Record one scheduled charge the job made through the sandbox processor.
-- Returns 'succeeded', 'declined', 'stopped' (third decline in a row), 'held'
-- (donations, recurring gifts or fund collection are off: try again later) or
-- 'skipped' (no longer due, or already charged).
CREATE FUNCTION eduos_history_donation_schedule_charge(p_district uuid, p_schedule uuid, p_installment integer, p_as_of date,
  p_provider_ref text, p_fee integer, p_outcome text, p_decline_code text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE prior text := current_setting('app.district_id', true); sch history_donation_schedules; s district_donation_settings; gid uuid; out text; k integer; nxt date;
BEGIN
  IF p_outcome NOT IN ('succeeded','declined') THEN RAISE EXCEPTION 'invalid_outcome' USING ERRCODE = '22023'; END IF;
  PERFORM set_config('app.district_id', p_district::text, true);
  SELECT * INTO sch FROM history_donation_schedules WHERE id = p_schedule AND district_id = p_district FOR UPDATE;
  IF NOT FOUND OR sch.status <> 'active' OR sch.next_charge_on > p_as_of OR p_installment <> sch.periods + 1 THEN
    out := 'skipped';
  ELSE
    SELECT * INTO s FROM district_donation_settings WHERE district_id = p_district;
    IF NOT coalesce(s.enabled AND s.recurring_enabled, false) OR NOT eduos_preservation_fund_collection_open(p_district) THEN
      out := 'held';
    ELSE
      INSERT INTO history_donations(district_id, school_id, donor_user_id, donor_name, anonymous, amount_cents, processing_fee_cents, payment_method,
          provider, mode, provider_ref, idempotency_key, schedule_id, installment)
        VALUES (p_district, sch.school_id, sch.donor_user_id, sch.donor_name, sch.anonymous, sch.amount_cents, p_fee, sch.payment_method,
          'sandbox', 'test', p_provider_ref, format('schedule:%s:%s', sch.id, p_installment), sch.id, p_installment)
        RETURNING id INTO gid;
      -- The next date after today on the schedule's calendar. Missed dates (the
      -- job didn't run, or charges were held) are never made up in a burst.
      k := p_installment;
      LOOP
        nxt := (sch.anchor_on + eduos_history_donation_period(sch.frequency) * k)::date;
        EXIT WHEN nxt > p_as_of;
        k := k + 1;
      END LOOP;
      UPDATE history_donation_schedules SET periods = p_installment, next_charge_on = nxt WHERE id = sch.id;
      IF p_outcome = 'succeeded' THEN
        PERFORM eduos_history_donation_complete(gid);
        out := 'succeeded';
      ELSE
        UPDATE history_donations SET status = 'declined', decline_code = coalesce(p_decline_code, 'declined'), confirmed_at = now() WHERE id = gid;
        UPDATE history_donation_schedules SET consecutive_declines = consecutive_declines + 1, last_charge_at = now() WHERE id = sch.id;
        IF sch.consecutive_declines + 1 >= 3 THEN
          UPDATE history_donation_schedules SET status = 'stopped', next_charge_on = NULL, ended_at = now(), end_reason = 'three declined charges in a row'
            WHERE id = sch.id;
          out := 'stopped';
        ELSE
          out := 'declined';
        END IF;
      END IF;
    END IF;
  END IF;
  PERFORM set_config('app.district_id', coalesce(prior, ''), true);
  RETURN out;
END $$;

REVOKE ALL ON FUNCTION eduos_history_donation_complete(uuid), eduos_history_donation_schedule_cancel(uuid, text),
  eduos_history_donation_schedules_due(date, integer), eduos_history_donation_schedule_charge(uuid, uuid, integer, date, text, integer, text, text),
  eduos_history_donation_schedule_guard(), eduos_history_donation_period(text) FROM PUBLIC;

-- TC-09: voluntary donations toward preserving student history. SANDBOX ONLY.
--
-- A family member or staff member (never a student) can give a voluntary
-- gift toward keeping student histories safe, for the whole district or one
-- school. Nothing about a gift touches a student: no student id, no storage
-- limit, no feature. Limits stay the district's settings (TC-08, TC-11).
--
-- Checkout goes through the district's payment setup (db/066: the methods it
-- enabled, no extra allowlist), but this phase only completes gifts through
-- the built-in sandbox: the provider and mode columns only accept
-- 'sandbox'/'test', so no money can move even if a live processor is
-- connected and COMMERCE_LIVE_PAYMENTS_ENABLED is on. Donations are also off
-- until the superintendent turns them on.
--
-- Each completed gift gets a plain acknowledgement (a numbered record of the
-- gift). It makes no claim about tax deductibility. A district can add its
-- own tax-receipt wording, off by default, after its own advice.
--
-- Numbered 135: 132 TC-08, 133 weather fix, 134 TC-11.

CREATE TABLE district_donation_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  enabled boolean NOT NULL DEFAULT false,
  min_cents integer NOT NULL DEFAULT 100 CHECK (min_cents BETWEEN 100 AND 100000),
  max_cents integer NOT NULL DEFAULT 50000 CHECK (max_cents BETWEEN 100 AND 10000000),
  suggested_cents integer[] NOT NULL DEFAULT '{1000,2500,5000}' CHECK (cardinality(suggested_cents) <= 6 AND 0 < ALL(suggested_cents)),
  acknowledgement_text text NOT NULL DEFAULT 'Thank you for your voluntary gift to help keep student histories safe. This is a record of your gift.'
    CHECK (length(btrim(acknowledgement_text)) BETWEEN 20 AND 1000),
  tax_wording_enabled boolean NOT NULL DEFAULT false,
  tax_wording text CHECK (tax_wording IS NULL OR length(btrim(tax_wording)) BETWEEN 10 AND 1000),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_cents <= max_cents),
  CHECK (NOT tax_wording_enabled OR tax_wording IS NOT NULL)
);

CREATE TABLE history_donations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  donor_user_id uuid NOT NULL REFERENCES users(id),
  donor_name text NOT NULL CHECK (length(btrim(donor_name)) BETWEEN 1 AND 200),
  anonymous boolean NOT NULL DEFAULT false,
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 100 AND 10000000),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  processing_fee_cents integer NOT NULL CHECK (processing_fee_cents >= 0 AND processing_fee_cents <= amount_cents),
  payment_method text NOT NULL CHECK (payment_method IN ('sandbox','paypal','card','venmo','cash_app','bitcoin')),
  provider text NOT NULL CHECK (provider = 'sandbox'),
  mode text NOT NULL DEFAULT 'test' CHECK (mode = 'test'),
  provider_ref text NOT NULL UNIQUE CHECK (provider_ref ~ '^pay_sandbox_[0-9a-f]{24}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','succeeded','declined','expired','refunded')),
  decline_code text CHECK (decline_code IS NULL OR decline_code ~ '^[a-z_]{1,60}$'),
  refund_ref text CHECK (refund_ref IS NULL OR refund_ref ~ '^re_sandbox_[0-9a-f]{24}$'),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 16 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  refunded_at timestamptz,
  UNIQUE (district_id, donor_user_id, idempotency_key),
  UNIQUE (district_id, id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  CHECK (status <> 'refunded' OR refund_ref IS NOT NULL)
);
CREATE INDEX history_donations_district ON history_donations(district_id, created_at DESC);
CREATE INDEX history_donations_donor ON history_donations(district_id, donor_user_id, created_at DESC);

CREATE FUNCTION eduos_history_donation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'donation records are kept' USING ERRCODE = '42501'; END IF;
  IF NEW.district_id <> OLD.district_id OR NEW.school_id IS DISTINCT FROM OLD.school_id OR NEW.donor_user_id <> OLD.donor_user_id
     OR NEW.donor_name <> OLD.donor_name OR NEW.anonymous <> OLD.anonymous OR NEW.amount_cents <> OLD.amount_cents
     OR NEW.currency <> OLD.currency OR NEW.processing_fee_cents <> OLD.processing_fee_cents OR NEW.payment_method <> OLD.payment_method
     OR NEW.provider <> OLD.provider OR NEW.mode <> OLD.mode OR NEW.provider_ref <> OLD.provider_ref
     OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'donation terms are fixed' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('succeeded','declined','expired'))
                                      OR (OLD.status = 'succeeded' AND NEW.status = 'refunded')) THEN
    RAISE EXCEPTION 'donation cannot go from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER history_donations_guard BEFORE UPDATE OR DELETE ON history_donations FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_guard();

-- Acknowledgements: a fixed copy of what the donor was told, never changed.
CREATE TABLE history_donation_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  donation_id uuid NOT NULL UNIQUE,
  number text NOT NULL CHECK (number ~ '^GIFT-[0-9]{4}-[0-9]{6}$'),
  issued_at timestamptz NOT NULL DEFAULT now(),
  district_name text NOT NULL,
  designation text NOT NULL,
  donor_name text NOT NULL,
  amount_cents integer NOT NULL,
  currency char(3) NOT NULL,
  body text NOT NULL,
  tax_wording text,
  test_mode boolean NOT NULL,
  UNIQUE (district_id, number),
  FOREIGN KEY (district_id, donation_id) REFERENCES history_donations(district_id, id)
);
CREATE TABLE history_donation_counters (
  district_id uuid NOT NULL REFERENCES districts(id),
  year integer NOT NULL,
  last_number integer NOT NULL DEFAULT 0,
  PRIMARY KEY (district_id, year)
);
CREATE FUNCTION eduos_history_donation_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% records are append-only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;
CREATE TRIGGER history_donation_acknowledgements_append_only BEFORE UPDATE OR DELETE ON history_donation_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION eduos_history_donation_append_only();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['district_donation_settings','history_donations','history_donation_acknowledgements','history_donation_counters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- Settings: everyone in the district reads them (the donate screen shows the
-- amounts); only the superintendent changes them, signing the change.
CREATE POLICY scope_insert ON district_donation_settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND updated_by = eduos_ctx_user()));
CREATE POLICY scope_update ON district_donation_settings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent')
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() = 'superintendent' AND updated_by = eduos_ctx_user()));
-- Gifts: the donor sees their own; the superintendent sees the district's.
-- Only an adult starts one, for themself, as pending. Outcomes go through
-- eduos_history_donation_record() below.
CREATE POLICY scope_read ON history_donations AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR donor_user_id = eduos_ctx_user() OR eduos_ctx_role() = 'superintendent');
CREATE POLICY scope_insert ON history_donations AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (donor_user_id = eduos_ctx_user() AND coalesce(eduos_ctx_role(), '') NOT IN ('', 'pupil')
              AND status = 'pending' AND provider = 'sandbox' AND confirmed_at IS NULL AND refunded_at IS NULL));
CREATE POLICY scope_change ON history_donations AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_read ON history_donation_acknowledgements AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role() = 'superintendent'
         OR EXISTS (SELECT 1 FROM history_donations g WHERE g.id = donation_id AND g.donor_user_id = eduos_ctx_user()));
CREATE POLICY scope_write ON history_donation_acknowledgements AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_owner ON history_donation_counters AS RESTRICTIVE FOR ALL
  USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- The sandbox's answer for a pending gift, recorded by its donor. A success
-- issues the acknowledgement in the same transaction. Repeating it returns
-- the same acknowledgement.
CREATE FUNCTION eduos_history_donation_record(p_donation uuid, p_outcome text, p_decline_code text)
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

REVOKE ALL ON FUNCTION eduos_history_donation_record(uuid, text, text), eduos_history_donation_guard(), eduos_history_donation_append_only() FROM PUBLIC;

-- EduOS 37.7.1: each district chooses its own payment processors.
-- Replaces the server-wide COMMERCE_PAYMENT_PROVIDER switch. A district can
-- connect PayPal, Square and/or BTCPay Server, offer families one or more
-- checkout methods (PayPal, Visa/Mastercard, Venmo, Cash App, Bitcoin, or the
-- built-in sandbox) and pick a default. Live payments additionally need the
-- server-wide COMMERCE_LIVE_PAYMENTS_ENABLED=true and the district's
-- credentials (checked by the API).
--
-- Credentials are sealed by the API (AES-256-GCM, COMMERCE_SECRETS_KEY) and
-- stored only in sealed form; the plain config holds no secret field.

-- 1. Processor accounts (credentials). District administrators only.
CREATE TABLE commerce_provider_accounts (
  district_id uuid NOT NULL REFERENCES districts(id),
  processor text NOT NULL CHECK(processor IN ('paypal','square','btcpay')),
  enabled boolean NOT NULL DEFAULT false,
  mode text NOT NULL DEFAULT 'test' CHECK(mode IN ('test','live')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(config)='object' AND octet_length(config::text) <= 4000
    AND NOT (config ?| ARRAY['clientSecret','accessToken','apiKey','webhookSecret','webhookSignatureKey'])),
  secrets_enc text CHECK(secrets_enc IS NULL OR (secrets_enc ~ '^c1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$' AND length(secrets_enc) <= 8000)),
  secret_fields text[] NOT NULL DEFAULT '{}' CHECK(secret_fields <@ ARRAY['clientSecret','accessToken','apiKey','webhookSecret','webhookSignatureKey']::text[]),
  fee_bps integer NOT NULL DEFAULT 290 CHECK(fee_bps BETWEEN 0 AND 1500),
  fee_fixed_cents integer NOT NULL DEFAULT 30 CHECK(fee_fixed_cents BETWEEN 0 AND 1000),
  last_test_at timestamptz,
  last_test_ok boolean,
  last_test_detail text CHECK(last_test_detail IS NULL OR last_test_detail ~ '^[a-z_]{1,60}$'),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(district_id, processor),
  CHECK((secrets_enc IS NULL) = (cardinality(secret_fields) = 0))
);

-- 2. What families are offered. Everyone in the district may read it
--    (checkout shows the choices); district administrators change it.
CREATE TABLE commerce_payment_setup (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  enabled_methods text[] NOT NULL DEFAULT '{}' CHECK(enabled_methods <@ ARRAY['sandbox','paypal','card','venmo','cash_app','bitcoin']::text[]),
  default_method text CHECK(default_method IS NULL OR default_method = ANY(enabled_methods)),
  card_processor text CHECK(card_processor IS NULL OR card_processor IN ('square','paypal')),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commerce_provider_accounts','commerce_payment_setup'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
CREATE POLICY scope_admin ON commerce_provider_accounts AS RESTRICTIVE FOR ALL
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','it_admin'))
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent','it_admin') AND updated_by = eduos_ctx_user()));
CREATE POLICY scope_insert ON commerce_payment_setup AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent','it_admin') AND updated_by = eduos_ctx_user()));
CREATE POLICY scope_update ON commerce_payment_setup AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','it_admin'))
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent','it_admin') AND updated_by = eduos_ctx_user()));

-- 3. Checkout and refunds run as the payer or a school leader, who can't
--    read the accounts table. This returns the one account the API needs,
--    for the caller's own district only, still sealed.
CREATE FUNCTION eduos_commerce_checkout_account(p_processor text)
RETURNS TABLE(processor text, enabled boolean, mode text, config jsonb, secrets_enc text, fee_bps integer, fee_fixed_cents integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district();
BEGIN
  IF d IS NULL OR eduos_ctx_user() IS NULL THEN RAISE EXCEPTION 'session context required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT a.processor, a.enabled, a.mode, a.config, a.secrets_enc, a.fee_bps, a.fee_fixed_cents
    FROM commerce_provider_accounts a WHERE a.district_id = d AND a.processor = p_processor;
END; $$;

-- 4. Payments record which method and processor carried them, in which
--    mode, the hosted checkout page, and the processor's capture reference
--    (needed to refund).
ALTER TABLE commerce_payments DROP CONSTRAINT commerce_payments_provider_check,
  DROP CONSTRAINT commerce_payments_provider_ref_check, DROP CONSTRAINT commerce_payments_refund_ref_check;
ALTER TABLE commerce_payments
  ADD COLUMN payment_method text NOT NULL DEFAULT 'sandbox' CHECK(payment_method IN ('sandbox','paypal','card','venmo','cash_app','bitcoin')),
  ADD COLUMN mode text NOT NULL DEFAULT 'test' CHECK(mode IN ('test','live')),
  ADD COLUMN checkout_url text CHECK(checkout_url IS NULL OR (checkout_url ~ '^https?://' AND length(checkout_url) <= 2000)),
  ADD COLUMN provider_capture_ref text CHECK(provider_capture_ref IS NULL OR provider_capture_ref ~ '^[A-Za-z0-9_-]{4,128}$'),
  ADD CONSTRAINT commerce_payments_provider_check CHECK(provider IN ('sandbox','paypal','square','btcpay')),
  ADD CONSTRAINT commerce_payments_provider_ref_check CHECK((provider='sandbox' AND provider_ref ~ '^pay_sandbox_[0-9a-f]{24}$')
    OR (provider<>'sandbox' AND provider_ref ~ '^[A-Za-z0-9_-]{6,128}$')),
  ADD CONSTRAINT commerce_payments_refund_ref_check CHECK(refund_ref IS NULL OR refund_ref ~ '^(re_sandbox_[0-9a-f]{24}|manual_fiat_[0-9a-f]{24}|[A-Za-z0-9_-]{6,128})$'),
  ADD CONSTRAINT commerce_payments_sandbox_is_test CHECK(provider<>'sandbox' OR (mode='test' AND payment_method='sandbox'));
CREATE OR REPLACE FUNCTION eduos_commerce_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.district_id<>OLD.district_id OR NEW.school_id IS DISTINCT FROM OLD.school_id OR NEW.purpose<>OLD.purpose
     OR NEW.ticket_order_id IS DISTINCT FROM OLD.ticket_order_id OR NEW.marketplace_purchase_id IS DISTINCT FROM OLD.marketplace_purchase_id
     OR NEW.payer_user_id<>OLD.payer_user_id OR NEW.amount_cents<>OLD.amount_cents OR NEW.currency<>OLD.currency
     OR NEW.processing_fee_cents<>OLD.processing_fee_cents OR NEW.provider<>OLD.provider OR NEW.provider_ref<>OLD.provider_ref
     OR NEW.payment_method<>OLD.payment_method OR NEW.mode<>OLD.mode OR NEW.checkout_url IS DISTINCT FROM OLD.checkout_url THEN
    RAISE EXCEPTION 'payment terms are fixed' USING ERRCODE='23514';
  END IF;
  IF OLD.provider_capture_ref IS NOT NULL AND NEW.provider_capture_ref IS DISTINCT FROM OLD.provider_capture_ref THEN
    RAISE EXCEPTION 'the capture reference is fixed once set' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT ((OLD.status='requires_confirmation' AND NEW.status IN ('succeeded','declined','expired'))
                                    OR (OLD.status='succeeded' AND NEW.status='refunded')) THEN
    RAISE EXCEPTION 'payment cannot go from % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  IF NEW.status='refunded' AND NEW.refund_ref IS NULL THEN RAISE EXCEPTION 'a refund needs its reference' USING ERRCODE='23514'; END IF;
  IF NEW.status='succeeded' AND OLD.status<>'succeeded' AND NEW.provider<>'sandbox' AND NEW.provider_capture_ref IS NULL THEN
    RAISE EXCEPTION 'a processor payment needs its capture reference' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

REVOKE ALL ON FUNCTION eduos_commerce_checkout_account(text) FROM PUBLIC;

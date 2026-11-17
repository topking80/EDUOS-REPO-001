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
  -- Section 5: what the processor is told (fixed, so a retried create sends
  -- the same request under the same idempotency key), and who started the
  -- processor call in flight and when (the reconcile sweep finishes it).
  ADD COLUMN description text CHECK(description IS NULL OR length(description) BETWEEN 1 AND 255),
  ADD COLUMN pending_since timestamptz,
  ADD COLUMN pending_actor jsonb CHECK(pending_actor IS NULL OR (jsonb_typeof(pending_actor)='object' AND octet_length(pending_actor::text) <= 300)),
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
     OR NEW.processing_fee_cents<>OLD.processing_fee_cents OR NEW.provider<>OLD.provider
     OR (OLD.provider_ref IS NOT NULL AND NEW.provider_ref IS DISTINCT FROM OLD.provider_ref)
     OR (OLD.checkout_url IS NOT NULL AND NEW.checkout_url IS DISTINCT FROM OLD.checkout_url)
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.payment_method<>OLD.payment_method OR NEW.mode<>OLD.mode THEN
    RAISE EXCEPTION 'payment terms are fixed' USING ERRCODE='23514';
  END IF;
  IF OLD.provider_capture_ref IS NOT NULL AND NEW.provider_capture_ref IS DISTINCT FROM OLD.provider_capture_ref THEN
    RAISE EXCEPTION 'the capture reference is fixed once set' USING ERRCODE='23514';
  END IF;
  -- Two-phase provider calls (section 5): creating -> requires_confirmation once
  -- the processor answered; succeeded -> refund_pending -> refunded, or back to
  -- succeeded when the processor refused the refund.
  IF NEW.status<>OLD.status AND NOT ((OLD.status='creating' AND NEW.status IN ('requires_confirmation','declined','expired'))
                                    OR (OLD.status='requires_confirmation' AND NEW.status IN ('succeeded','declined','expired'))
                                    OR (OLD.status='succeeded' AND NEW.status IN ('refunded','refund_pending'))
                                    OR (OLD.status='refund_pending' AND NEW.status IN ('refunded','succeeded'))) THEN
    RAISE EXCEPTION 'payment cannot go from % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  IF NEW.status='requires_confirmation' AND NEW.provider_ref IS NULL THEN
    RAISE EXCEPTION 'a payment awaiting confirmation needs its processor reference' USING ERRCODE='23514';
  END IF;
  IF NEW.status='refunded' AND NEW.refund_ref IS NULL THEN RAISE EXCEPTION 'a refund needs its reference' USING ERRCODE='23514'; END IF;
  IF NEW.status='succeeded' AND OLD.status<>'succeeded' AND OLD.status<>'refund_pending' AND NEW.provider<>'sandbox' AND NEW.provider_capture_ref IS NULL THEN
    RAISE EXCEPTION 'a processor payment needs its capture reference' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;

REVOKE ALL ON FUNCTION eduos_commerce_checkout_account(text) FROM PUBLIC;

-- 5. Processor calls never run inside a database transaction (they can take
--    seconds and would hold row locks and a pooled connection meanwhile).
--    Each one is: reserve and commit (status 'creating', 'refund_pending', or
--    a confirm marked with pending_since), call the processor outside any
--    transaction under an idempotency key derived from the payment id, then
--    record the answer in a new transaction. If the API dies in between, the
--    reconcile sweep repeats the same idempotent call and records it.
ALTER TABLE commerce_payments ALTER COLUMN provider_ref DROP NOT NULL,
  DROP CONSTRAINT commerce_payments_status_check,
  ADD CONSTRAINT commerce_payments_status_check CHECK(status IN ('creating','requires_confirmation','succeeded','declined','expired','refund_pending','refunded')),
  ADD CONSTRAINT commerce_payments_ref_when_live CHECK(provider_ref IS NOT NULL OR status IN ('creating','declined','expired')),
  ADD CONSTRAINT commerce_payments_pending_actor CHECK((pending_since IS NULL) = (pending_actor IS NULL));
DROP INDEX commerce_payments_one_live_order, commerce_payments_one_live_purchase;
CREATE UNIQUE INDEX commerce_payments_one_live_order ON commerce_payments(ticket_order_id)
  WHERE status IN ('creating','requires_confirmation','succeeded','refund_pending','refunded');
CREATE UNIQUE INDEX commerce_payments_one_live_purchase ON commerce_payments(marketplace_purchase_id)
  WHERE status IN ('creating','requires_confirmation','succeeded','refund_pending','refunded');
CREATE INDEX commerce_payments_in_flight ON commerce_payments(district_id, pending_since) WHERE pending_since IS NOT NULL;

-- A refund in flight blocks gate check-in for that order (the check-in reads
-- the order FOR SHARE; the refund sets this under FOR UPDATE).
ALTER TABLE event_ticket_orders ADD COLUMN refund_pending boolean NOT NULL DEFAULT false;

-- Expired holds also release payments still being created.
CREATE OR REPLACE FUNCTION eduos_commerce_expire_holds() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); o record; n int := 0;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  FOR o IN SELECT id, ticket_type_id, quantity FROM event_ticket_orders
            WHERE district_id=d AND status='payment_pending' AND hold_expires_at < now() ORDER BY id FOR UPDATE SKIP LOCKED LOOP
    UPDATE event_ticket_orders SET status='cancelled' WHERE id=o.id;
    UPDATE event_ticket_types SET sold_count=greatest(sold_count-o.quantity, 0) WHERE id=o.ticket_type_id AND district_id=d;
    UPDATE commerce_payments SET status='expired', pending_since=NULL, pending_actor=NULL
     WHERE ticket_order_id=o.id AND status IN ('creating','requires_confirmation');
    n := n + 1;
  END LOOP;
  UPDATE marketplace_purchases m SET status='cancelled' FROM commerce_payments p
   WHERE m.district_id=d AND m.status='payment_pending' AND p.marketplace_purchase_id=m.id AND p.status IN ('declined','expired')
     AND NOT EXISTS(SELECT 1 FROM commerce_payments q WHERE q.marketplace_purchase_id=m.id AND q.status IN ('creating','requires_confirmation','succeeded'));
  RETURN n;
END; $$;

-- The reconcile sweep runs with only the district in context (no user), so
-- it can't read payments under RLS. This lists the district's processor calls
-- that have been in flight longer than p_stale_seconds: the payment id and
-- the session (user, role, school) that started the call, which the sweep
-- uses to finish it exactly as that user would have.
CREATE FUNCTION eduos_commerce_stale_payments(p_stale_seconds integer)
RETURNS TABLE(payment_id uuid, status text, pending_actor jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district();
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required' USING ERRCODE='42501'; END IF;
  IF p_stale_seconds IS NULL OR p_stale_seconds < 10 OR p_stale_seconds > 86400 THEN RAISE EXCEPTION 'invalid staleness' USING ERRCODE='22023'; END IF;
  RETURN QUERY SELECT p.id, p.status, p.pending_actor FROM commerce_payments p
    WHERE p.district_id=d AND p.pending_since IS NOT NULL AND p.pending_since < now() - make_interval(secs => p_stale_seconds)
    ORDER BY p.pending_since LIMIT 100;
END; $$;
REVOKE ALL ON FUNCTION eduos_commerce_stale_payments(integer) FROM PUBLIC;

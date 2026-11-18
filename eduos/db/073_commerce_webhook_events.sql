-- EduOS 37.8.0: durable, tenant-scoped payment-provider webhook inbox.
-- This is the persistence boundary for verified provider notifications.
-- HTTP intake must verify the provider signature before inserting a row;
-- untrusted request bodies and credentials are never stored here.
--
-- Settlement is deliberately NOT performed by this migration. The API layer
-- must validate the event against the matched commerce_payments row and call
-- the existing settlement recorder only after amount/currency/reference checks.

CREATE TABLE commerce_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  payment_id uuid NOT NULL,
  processor text NOT NULL CHECK(processor IN ('paypal','square','btcpay')),
  provider_event_id text NOT NULL CHECK(length(provider_event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK(length(event_type) BETWEEN 1 AND 120),
  payload_sha256 text NOT NULL CHECK(payload_sha256 ~ '^[a-f0-9]{64}$'),
  provider_capture_ref text CHECK(provider_capture_ref IS NULL OR provider_capture_ref ~ '^[A-Za-z0-9_-]{4,128}$'),
  amount_cents integer CHECK(amount_cents IS NULL OR amount_cents BETWEEN 1 AND 100000000),
  currency char(3) CHECK(currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  state text NOT NULL DEFAULT 'received'
    CHECK(state IN ('received','processing','applied','ignored','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 1000),
  last_error_code text CHECK(last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,80}$'),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  FOREIGN KEY(district_id, payment_id) REFERENCES commerce_payments(district_id, id),
  UNIQUE(processor, provider_event_id),
  UNIQUE(district_id, id)
);
CREATE INDEX commerce_webhook_events_pending
  ON commerce_webhook_events(received_at, id)
  WHERE state IN ('received','failed');
CREATE INDEX commerce_webhook_events_payment
  ON commerce_webhook_events(district_id, payment_id, received_at DESC);

ALTER TABLE commerce_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commerce_webhook_events
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
-- Provider event identifiers are immutable; only the processing lease/result
-- fields may change. Payload hashes make duplicate-ID/body mismatches visible.
CREATE FUNCTION eduos_commerce_webhook_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.district_id<>OLD.district_id OR NEW.payment_id<>OLD.payment_id
     OR NEW.processor<>OLD.processor OR NEW.provider_event_id<>OLD.provider_event_id
     OR NEW.event_type<>OLD.event_type OR NEW.payload_sha256<>OLD.payload_sha256
     OR NEW.provider_capture_ref IS DISTINCT FROM OLD.provider_capture_ref
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.received_at<>OLD.received_at THEN
    RAISE EXCEPTION 'webhook event identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>OLD.state AND NOT (
       (OLD.state IN ('received','failed') AND NEW.state IN ('processing','ignored'))
    OR (OLD.state='processing' AND NEW.state IN ('applied','ignored','failed'))
    OR (OLD.state='failed' AND NEW.state='processing')
  ) THEN
    RAISE EXCEPTION 'webhook event cannot go from % to %', OLD.state, NEW.state USING ERRCODE='23514';
  END IF;
  IF NEW.attempts<OLD.attempts OR NEW.attempts>OLD.attempts+1 THEN
    RAISE EXCEPTION 'webhook attempts must advance by one' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER commerce_webhook_event_guard
  BEFORE UPDATE ON commerce_webhook_events
  FOR EACH ROW EXECUTE FUNCTION eduos_commerce_webhook_event_guard();

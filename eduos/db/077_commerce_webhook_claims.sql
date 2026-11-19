-- EduOS 37.8.0: leased webhook claims and a narrow global worker claim.
-- A crashed worker's claim becomes eligible again after five minutes.
ALTER TABLE commerce_webhook_events
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN provider_ref text;
ALTER TABLE commerce_webhook_events
  ADD CONSTRAINT commerce_webhook_events_provider_ref_check
  CHECK (provider_ref IS NULL OR provider_ref ~ '^[A-Za-z0-9_-]{4,128}$');

CREATE OR REPLACE FUNCTION eduos_commerce_webhook_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.district_id<>OLD.district_id OR NEW.payment_id<>OLD.payment_id
     OR NEW.processor<>OLD.processor OR NEW.provider_event_id<>OLD.provider_event_id
     OR NEW.event_type<>OLD.event_type OR NEW.payload_sha256<>OLD.payload_sha256
     OR NEW.provider_ref IS DISTINCT FROM OLD.provider_ref
     OR NEW.provider_capture_ref IS DISTINCT FROM OLD.provider_capture_ref
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.received_at<>OLD.received_at THEN
    RAISE EXCEPTION 'webhook event identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>OLD.state AND NOT (
       (OLD.state IN ('received','failed') AND NEW.state IN ('processing','ignored'))
    OR (OLD.state='processing' AND NEW.state IN ('applied','ignored','failed'))
  ) THEN
    RAISE EXCEPTION 'webhook event cannot go from % to %', OLD.state, NEW.state USING ERRCODE='23514';
  END IF;
  IF NEW.state='processing' AND (
       OLD.state<>'processing' OR OLD.claimed_at IS NULL
       OR OLD.claimed_at < now() - interval '5 minutes'
  ) THEN
    IF NEW.attempts<>OLD.attempts+1 THEN
      RAISE EXCEPTION 'claiming a webhook event must increment attempts' USING ERRCODE='23514';
    END IF;
    NEW.processed_at := NULL;
    NEW.claimed_at := now();
  ELSIF NEW.state IN ('applied','ignored','failed') THEN
    IF NEW.attempts<>OLD.attempts THEN
      RAISE EXCEPTION 'webhook attempts change only when claimed' USING ERRCODE='23514';
    END IF;
    NEW.processed_at := coalesce(NEW.processed_at, now());
    NEW.claimed_at := NULL;
  ELSE
    IF NEW.attempts<>OLD.attempts OR NEW.processed_at IS DISTINCT FROM OLD.processed_at
       OR NEW.claimed_at IS DISTINCT FROM OLD.claimed_at THEN
      RAISE EXCEPTION 'webhook processing metadata changed outside a state transition' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX commerce_webhook_events_claim_lease
  ON commerce_webhook_events(claimed_at, id) WHERE state='processing';

-- Earlier inbox rows created before provider_ref was retained cannot be
-- safely settled; close them as legacy records instead of guessing a ref.
UPDATE commerce_webhook_events
   SET state='ignored', last_error_code='legacy_event_missing_reference'
 WHERE provider_ref IS NULL AND state IN ('received','failed','processing');

CREATE OR REPLACE FUNCTION eduos_commerce_receive_webhook(
  p_token_sha256 text, p_processor text, p_provider_event_id text, p_event_type text,
  p_payload_sha256 text, p_provider_ref text, p_capture_ref text,
  p_amount_cents integer, p_currency text
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE d uuid; payment uuid; prior_hash text;
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[a-f0-9]{64}$'
     OR p_processor NOT IN ('paypal','square','btcpay')
     OR p_provider_event_id IS NULL OR length(p_provider_event_id) NOT BETWEEN 1 AND 128
     OR p_event_type IS NULL OR length(p_event_type) NOT BETWEEN 1 AND 120
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[a-f0-9]{64}$'
     OR p_provider_ref IS NULL OR p_provider_ref !~ '^[A-Za-z0-9_-]{4,128}$'
     OR p_capture_ref IS NULL OR p_capture_ref !~ '^[A-Za-z0-9_-]{4,128}$'
     OR p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 1 AND 100000000
     OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'invalid webhook event' USING ERRCODE='22023';
  END IF;
  SELECT e.district_id INTO d
    FROM public.commerce_webhook_endpoints e
    JOIN public.commerce_provider_accounts a
      ON a.district_id=e.district_id AND a.processor=e.processor
   WHERE e.token_sha256=p_token_sha256 AND e.processor=p_processor
     AND e.active AND a.enabled
   LIMIT 1;
  IF d IS NULL THEN RETURN 'endpoint_not_found'; END IF;
  SELECT p.id INTO payment
    FROM public.commerce_payments p
   WHERE p.district_id=d AND p.provider=p_processor AND p.provider_ref=p_provider_ref
     AND p.status IN ('requires_confirmation','expired','succeeded') AND p.amount_cents=p_amount_cents
     AND p.currency=p_currency
     AND (p.provider_capture_ref IS NULL OR p.provider_capture_ref=p_capture_ref)
   LIMIT 1 FOR UPDATE;
  IF payment IS NULL THEN RETURN 'unmatched'; END IF;
  INSERT INTO public.commerce_webhook_events
    (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
     provider_ref,provider_capture_ref,amount_cents,currency,state)
  VALUES(d,payment,p_processor,p_provider_event_id,p_event_type,p_payload_sha256,
         p_provider_ref,p_capture_ref,p_amount_cents,p_currency,'received')
  ON CONFLICT(processor,provider_event_id) DO NOTHING;
  IF FOUND THEN RETURN 'received'; END IF;
  SELECT e.payload_sha256 INTO prior_hash
    FROM public.commerce_webhook_events e
   WHERE e.processor=p_processor AND e.provider_event_id=p_provider_event_id;
  IF prior_hash=p_payload_sha256 THEN RETURN 'duplicate'; END IF;
  RETURN 'event_id_conflict';
END;
$$;
REVOKE ALL ON FUNCTION eduos_commerce_receive_webhook(text,text,text,text,text,text,text,integer,text) FROM PUBLIC;

CREATE FUNCTION eduos_commerce_claim_webhook()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE claimed record;
BEGIN
  WITH candidate AS (
    SELECT e.id
      FROM public.commerce_webhook_events e
      JOIN public.commerce_payments p
        ON p.district_id=e.district_id AND p.id=e.payment_id
     WHERE p.payer_actor IS NOT NULL AND e.provider_ref IS NOT NULL
       AND e.attempts < 20
       AND (
         e.state IN ('received','failed')
         OR (e.state='processing' AND e.claimed_at < now() - interval '5 minutes')
       )
     ORDER BY e.received_at, e.id
     LIMIT 1
     FOR UPDATE OF e SKIP LOCKED
  )
  UPDATE public.commerce_webhook_events e
     SET state='processing', attempts=e.attempts+1, claimed_at=now(),
         processed_at=NULL, last_error_code=NULL
    FROM candidate c
   WHERE e.id=c.id
  RETURNING e.id,e.district_id,e.payment_id,e.processor,e.provider_event_id,
            e.provider_ref,e.provider_capture_ref,e.amount_cents,e.currency,e.attempts,
            (SELECT p.payer_actor FROM public.commerce_payments p
              WHERE p.district_id=e.district_id AND p.id=e.payment_id) AS payer_actor
       INTO claimed;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'id',claimed.id,'districtId',claimed.district_id,'paymentId',claimed.payment_id,
    'processor',claimed.processor,'providerEventId',claimed.provider_event_id,
    'providerRef',claimed.provider_ref,'captureRef',claimed.provider_capture_ref,
    'amountCents',claimed.amount_cents,'currency',claimed.currency,
    'attempts',claimed.attempts,'payerActor',claimed.payer_actor
  );
END;
$$;
REVOKE ALL ON FUNCTION eduos_commerce_claim_webhook() FROM PUBLIC;

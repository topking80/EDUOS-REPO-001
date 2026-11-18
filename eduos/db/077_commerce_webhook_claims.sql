-- EduOS 37.8.0: leased webhook claims and a narrow global worker claim.
-- A crashed worker's claim becomes eligible again after five minutes.
ALTER TABLE commerce_webhook_events ADD COLUMN claimed_at timestamptz;

CREATE OR REPLACE FUNCTION eduos_commerce_webhook_event_guard() RETURNS trigger
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
  ) THEN
    RAISE EXCEPTION 'webhook event cannot go from % to %', OLD.state, NEW.state USING ERRCODE='23514';
  END IF;
  IF NEW.state='processing' AND (
       OLD.state<>'processing'
       OR OLD.claimed_at IS NULL
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

-- The runtime can claim one event without broad SELECT access to every
-- district's payments. The function returns only the event and its saved payer
-- actor, which is required by the existing payer-only EDAL settlement path.
CREATE FUNCTION eduos_commerce_claim_webhook()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE claimed record;
BEGIN
  WITH candidate AS (
    SELECT e.id
      FROM public.commerce_webhook_events e
      JOIN public.commerce_payments p
        ON p.district_id=e.district_id AND p.id=e.payment_id
     WHERE p.payer_actor IS NOT NULL
       AND e.attempts < 20
       AND (
         e.state IN ('received','failed')
         OR (e.state='processing' AND e.claimed_at < now() - interval '5 minutes')
       )
     ORDER BY e.received_at, e.id
     FOR UPDATE OF e SKIP LOCKED
     LIMIT 1
  )
  UPDATE public.commerce_webhook_events e
     SET state='processing', attempts=e.attempts+1, claimed_at=now(),
         processed_at=NULL, last_error_code=NULL
    FROM candidate c
   WHERE e.id=c.id
  RETURNING e.id,e.district_id,e.payment_id,e.processor,e.provider_event_id,
            e.provider_ref,e.provider_capture_ref,e.amount_cents,e.currency,
            e.attempts,
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

-- EduOS 37.8.0: close webhook inbox rows that cannot be safely settled.
-- A provider callback has no authenticated user session. If the payment has no
-- persisted payer actor, it must never be claimed and settled as an invented
-- identity; leave an explicit terminal audit state instead of a stuck queue row.
CREATE OR REPLACE FUNCTION eduos_commerce_claim_webhook()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE claimed record;
BEGIN
  UPDATE public.commerce_webhook_events e
     SET state='ignored', last_error_code='missing_payer_actor'
    FROM public.commerce_payments p
   WHERE p.district_id=e.district_id AND p.id=e.payment_id
     AND p.payer_actor IS NULL
     AND (
       e.state IN ('received','failed')
       OR (e.state='processing' AND
           (e.claimed_at IS NULL OR e.claimed_at < now() - interval '5 minutes'))
     );

  WITH candidate AS (
    SELECT e.id
      FROM public.commerce_webhook_events e
      JOIN public.commerce_payments p
        ON p.district_id=e.district_id AND p.id=e.payment_id
     WHERE p.payer_actor IS NOT NULL AND e.provider_ref IS NOT NULL
       AND e.attempts < 20
       AND (
         e.state IN ('received','failed')
         OR (e.state='processing' AND
             (e.claimed_at IS NULL OR e.claimed_at < now() - interval '5 minutes'))
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

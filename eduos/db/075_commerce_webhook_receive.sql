-- EduOS 37.8.0: narrow, token-authenticated persistence boundary for
-- signature-verified webhook events. Public intake has no user session, and
-- ordinary payment RLS intentionally restricts reads to a payer/superintendent.
-- This SECURITY DEFINER function performs only an exact provider/reference/
-- amount/currency match and inserts one immutable inbox record. It never
-- changes payment status, tickets, receipts, or ledger rows.
CREATE FUNCTION eduos_commerce_receive_webhook(
  p_token_sha256 text,
  p_processor text,
  p_provider_event_id text,
  p_event_type text,
  p_payload_sha256 text,
  p_provider_ref text,
  p_capture_ref text,
  p_amount_cents integer,
  p_currency text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  d uuid;
  payment uuid;
  prior_hash text;
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
     AND p.status='requires_confirmation' AND p.amount_cents=p_amount_cents
     AND p.currency=p_currency
     AND (p.provider_capture_ref IS NULL OR p.provider_capture_ref=p_capture_ref)
   LIMIT 1 FOR UPDATE;
  IF payment IS NULL THEN RETURN 'unmatched'; END IF;

  INSERT INTO public.commerce_webhook_events
    (district_id,payment_id,processor,provider_event_id,event_type,payload_sha256,
     provider_capture_ref,amount_cents,currency,state)
  VALUES(d,payment,p_processor,p_provider_event_id,p_event_type,p_payload_sha256,
         p_capture_ref,p_amount_cents,p_currency,'received')
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

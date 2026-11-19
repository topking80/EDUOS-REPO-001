-- EduOS 37.8.0: make webhook retry exhaustion explicit and terminal.
-- Previously the claim function stopped at 20 attempts but left the event in
-- state=failed, which looked retryable to operators while never being claimed.
ALTER TABLE commerce_webhook_events
  DROP CONSTRAINT commerce_webhook_events_state_check,
  ADD CONSTRAINT commerce_webhook_events_state_check
    CHECK (state IN ('received','processing','applied','ignored','failed','dead_letter'));

DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
     WHERE conrelid='public.commerce_webhook_events'::regclass
       AND contype='c'
       AND pg_get_constraintdef(oid) LIKE '%processed_at%'
  LOOP
    EXECUTE format('ALTER TABLE public.commerce_webhook_events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE commerce_webhook_events
  ADD CONSTRAINT commerce_webhook_events_terminal_timestamp_check
  CHECK ((state IN ('applied','ignored','failed','dead_letter')) = (processed_at IS NOT NULL));

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
    OR (OLD.state='processing' AND NEW.state IN ('applied','ignored','failed','dead_letter'))
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
  ELSIF NEW.state IN ('applied','ignored','failed','dead_letter') THEN
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

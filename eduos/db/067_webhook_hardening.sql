-- 37.7.0 audit hardening: webhooks (2026-11-17 third-party audit of main 546d2da).
-- Numbered 067: 066 is taken by the open district payment providers branch
-- (feat/37.7-commerce-sandbox, 066_commerce_district_providers.sql). The
-- migrator applies files by name, so either can merge first.
--
-- 1. Subscription registration (audit finding 3). The API checked "same URL
--    already active" and the district cap after SELECT ... FOR UPDATE, which
--    locks existing rows but not the absence of one: two concurrent requests
--    could both pass. Now PostgreSQL enforces both:
--      - one active subscription per (district, url): partial unique index;
--      - max_active_webhooks: a trigger that serialises per district with a
--        transaction-scoped advisory lock and counts committed rows.
-- 2. A deployment-wide ceiling on webhook deliveries in flight (finding 5):
--    slot rows with a lease, taken and released only through SECURITY
--    DEFINER functions, shared by every API replica and the dispatcher.

-- Existing duplicates (if any) would block the unique index: keep the oldest
-- active row per (district, url) and disable the rest. The table forces RLS,
-- so the owner lifts it for this one statement.
ALTER TABLE webhook_subscriptions NO FORCE ROW LEVEL SECURITY;
UPDATE webhook_subscriptions w SET status='disabled', disabled_at=now()
 WHERE w.status='active' AND EXISTS (
   SELECT 1 FROM webhook_subscriptions o
    WHERE o.district_id=w.district_id AND o.url=w.url AND o.status='active'
      AND (o.created_at, o.id) < (w.created_at, w.id));
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX webhook_subscriptions_active_url ON webhook_subscriptions(district_id, url) WHERE status='active';

-- Runs as the caller (the runtime role, inside its district's RLS context).
CREATE FUNCTION eduos_webhook_subscription_cap() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap integer; active integer;
BEGIN
  IF NEW.status <> 'active' OR (TG_OP = 'UPDATE' AND OLD.status = 'active') THEN RETURN NEW; END IF;
  -- Same key the API takes first, so registrations in one district queue up.
  PERFORM pg_advisory_xact_lock(hashtextextended('eduos:webhook_subscriptions:' || NEW.district_id::text, 0));
  SELECT max_active_webhooks INTO cap FROM district_settings WHERE district_id = NEW.district_id;
  IF cap IS NULL THEN RETURN NEW; END IF;
  -- A new statement after the lock: under READ COMMITTED this sees rows the
  -- previous lock holder committed.
  SELECT count(*) INTO active FROM webhook_subscriptions
   WHERE district_id = NEW.district_id AND status = 'active' AND id <> NEW.id;
  IF active >= cap THEN
    RAISE EXCEPTION 'webhook_limit_reached' USING ERRCODE = 'check_violation', CONSTRAINT = 'webhook_subscriptions_district_cap';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER webhook_subscriptions_cap BEFORE INSERT OR UPDATE OF status ON webhook_subscriptions
  FOR EACH ROW EXECUTE FUNCTION eduos_webhook_subscription_cap();

-- Delivery slots. Not tenant data: no district column, no direct access for
-- the runtime role (RLS on, no policies; grants only on the functions).
CREATE TABLE webhook_delivery_slots (
  holder uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acquired_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NOT NULL
);
ALTER TABLE webhook_delivery_slots ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION eduos_webhook_slot_acquire(p_max integer, p_lease_seconds integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE h uuid;
BEGIN
  IF p_max IS NULL OR p_max < 1 OR p_lease_seconds IS NULL OR p_lease_seconds < 1 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'invalid_slot_request' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('eduos:webhook_delivery_slots', 0));
  DELETE FROM webhook_delivery_slots WHERE lease_until < now();
  IF (SELECT count(*) FROM webhook_delivery_slots) >= p_max THEN RETURN NULL; END IF;
  INSERT INTO webhook_delivery_slots(lease_until) VALUES (now() + make_interval(secs => p_lease_seconds)) RETURNING holder INTO h;
  RETURN h;
END $$;

CREATE FUNCTION eduos_webhook_slot_release(p_holder uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM webhook_delivery_slots WHERE holder = p_holder;
$$;

CREATE FUNCTION eduos_webhook_slots_free(p_max integer) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT greatest(0, p_max - (SELECT count(*) FROM webhook_delivery_slots WHERE lease_until >= now())::integer);
$$;

REVOKE ALL ON webhook_delivery_slots FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION eduos_webhook_slot_acquire(integer, integer), eduos_webhook_slot_release(uuid), eduos_webhook_slots_free(integer) FROM PUBLIC;

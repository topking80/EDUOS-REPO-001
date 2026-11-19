-- 37.8.2: refund-case resolution is a one-way, auditable state transition.
-- API checks are not enough: direct SQL must not reopen a resolved obligation,
-- rewrite its evidence, or resolve it without the matching audit event.
CREATE OR REPLACE FUNCTION eduos_commerce_refund_case_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund_case_delete_forbidden' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'resolved' THEN
    RAISE EXCEPTION 'refund_case_resolution_immutable' USING ERRCODE = '23514';
  END IF;

  IF ROW(NEW.id, NEW.district_id, NEW.payment_id, NEW.webhook_event_id,
         NEW.processor, NEW.provider_capture_ref, NEW.amount_cents, NEW.currency,
         NEW.reason_code, NEW.opened_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.district_id, OLD.payment_id, OLD.webhook_event_id,
         OLD.processor, OLD.provider_capture_ref, OLD.amount_cents, OLD.currency,
         OLD.reason_code, OLD.opened_at) THEN
    RAISE EXCEPTION 'refund_case_identity_immutable' USING ERRCODE = '23514';
  END IF;

  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'refund_case_last_seen_cannot_move_backwards' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'resolved'
     AND NEW.resolved_by IS DISTINCT FROM nullif(current_setting('app.user_id', true), '')::uuid THEN
    RAISE EXCEPTION 'refund_case_resolver_must_match_session' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER commerce_webhook_refund_case_guard
BEFORE UPDATE OR DELETE ON commerce_webhook_refund_cases
FOR EACH ROW EXECUTE FUNCTION eduos_commerce_refund_case_guard();

-- A resolution and its audit evidence commit or roll back together. This
-- deferred check runs at transaction end, after the route has inserted audit.
CREATE OR REPLACE FUNCTION eduos_commerce_refund_case_audit_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.audit_events a
     WHERE a.district_id = NEW.district_id
       AND a.actor_user_id = NEW.resolved_by
       AND a.action = 'late_capture_refund_resolved'
       AND a.resource_type = 'commerce_webhook_refund_case'
       AND a.resource_id = NEW.id::text
       AND a.detail LIKE ('%payment=' || NEW.payment_id::text || ';resolution=%')
  ) THEN
    RAISE EXCEPTION 'refund_case_resolution_audit_required' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER commerce_webhook_refund_case_audit_guard
AFTER UPDATE ON commerce_webhook_refund_cases
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'resolved')
EXECUTE FUNCTION eduos_commerce_refund_case_audit_guard();

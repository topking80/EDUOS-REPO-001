-- EduOS 37.8.0: durable operator queue for provider captures received after
-- the ticket hold expired. These payments must never issue tickets or enter
-- the normal settlement ledger; an operator records the external refund.
CREATE TABLE commerce_webhook_refund_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  payment_id uuid NOT NULL,
  webhook_event_id uuid NOT NULL,
  processor text NOT NULL CHECK (processor IN ('paypal','square','btcpay')),
  provider_capture_ref text NOT NULL CHECK (provider_capture_ref ~ '^[A-Za-z0-9_-]{4,128}$'),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 100000000),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  reason_code text NOT NULL CHECK (reason_code IN ('payment_after_checkout_expired','ticket_hold_expired')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id),
  resolution_note text,
  FOREIGN KEY (district_id,payment_id) REFERENCES commerce_payments(district_id,id),
  FOREIGN KEY (district_id,webhook_event_id) REFERENCES commerce_webhook_events(district_id,id),
  UNIQUE (payment_id,provider_capture_ref),
  CHECK (
    (status='open' AND resolved_at IS NULL AND resolved_by IS NULL AND resolution_note IS NULL)
    OR
    (status='resolved' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL
      AND resolution_note IS NOT NULL AND length(resolution_note) BETWEEN 10 AND 1000)
  )
);
CREATE INDEX commerce_webhook_refund_cases_open
  ON commerce_webhook_refund_cases(district_id,opened_at DESC)
  WHERE status='open';
ALTER TABLE commerce_webhook_refund_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE commerce_webhook_refund_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commerce_webhook_refund_cases
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

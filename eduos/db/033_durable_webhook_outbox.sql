-- Durable, tenant-isolated webhook work queue. Jobs are mutable; delivery
-- attempts remain in the append-only webhook_deliveries ledger.
ALTER TABLE flow_events ADD CONSTRAINT flow_events_district_id_id_key UNIQUE(district_id,id);

CREATE TABLE webhook_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  subscription_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK(length(event_type) <= 48),
  payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND length(payload::text) <= 8192),
  delivery_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','delivered','dead_letter','cancelled')),
  attempts smallint NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  max_attempts smallint NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  last_outcome text,
  last_status_code integer CHECK(last_status_code IS NULL OR last_status_code BETWEEN 100 AND 599),
  last_error text CHECK(last_error IS NULL OR length(last_error) <= 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(district_id, subscription_id, event_id),
  UNIQUE(delivery_id),
  FOREIGN KEY(district_id, subscription_id) REFERENCES webhook_subscriptions(district_id,id),
  FOREIGN KEY(district_id,event_id) REFERENCES flow_events(district_id,id),
  CHECK((status='processing' AND lease_until IS NOT NULL AND lease_token IS NOT NULL) OR status<>'processing')
);
CREATE INDEX webhook_outbox_ready ON webhook_outbox(district_id, available_at, created_at)
  WHERE status IN ('pending','processing');
ALTER TABLE webhook_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_outbox
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

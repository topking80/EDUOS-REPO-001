-- Phase 32.0.44: cross-profile flow events and signed outbound webhooks.
-- Events hold an allow-listed type, opaque references and bounded counters
-- only: no free text and no student-identifying content.
CREATE TABLE flow_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  actor_user_id uuid NOT NULL,
  actor_role text NOT NULL CHECK(actor_role IN ('superintendent','principal','teacher','parent','pupil')),
  event_type text NOT NULL CHECK(length(event_type) <= 48 AND event_type ~ '^[a-z]+(\.[a-z]+){1,2}$'),
  audience text[] NOT NULL CHECK(
    cardinality(audience) BETWEEN 1 AND 5
    AND audience <@ ARRAY['superintendent','principal','teacher','parent','pupil']::text[]),
  source text NOT NULL CHECK(source IN ('server','client-reported')),
  refs jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(refs)='object' AND length(refs::text) <= 512),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(counts)='object' AND length(counts::text) <= 256),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,actor_user_id) REFERENCES memberships(district_id,user_id)
);
CREATE INDEX flow_events_feed ON flow_events(district_id,occurred_at DESC);
CREATE INDEX flow_events_school ON flow_events(district_id,school_id,occurred_at DESC);
ALTER TABLE flow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE flow_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON flow_events
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

-- Signing secrets are derived from a server-held key and are never stored here.
CREATE TABLE webhook_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  created_by uuid NOT NULL,
  url text NOT NULL CHECK(length(url) BETWEEN 12 AND 2048 AND url ~ '^https?://'),
  event_types text[] NOT NULL CHECK(cardinality(event_types) BETWEEN 1 AND 16),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
  last_delivery_at timestamptz,
  last_outcome text CHECK(last_outcome IS NULL OR last_outcome IN ('delivered','http_error','network_error','blocked','timeout')),
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  disabled_by uuid,
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,created_by) REFERENCES memberships(district_id,user_id),
  CHECK((status='disabled' AND disabled_at IS NOT NULL) OR status<>'disabled')
);
CREATE INDEX webhook_subscriptions_active ON webhook_subscriptions(district_id,status);
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_subscriptions
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  subscription_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  event_id uuid,
  event_type text NOT NULL CHECK(length(event_type) <= 48),
  attempt smallint NOT NULL CHECK(attempt BETWEEN 1 AND 5),
  outcome text NOT NULL CHECK(outcome IN ('delivered','http_error','network_error','blocked','timeout')),
  status_code integer CHECK(status_code IS NULL OR status_code BETWEEN 100 AND 599),
  duration_ms integer CHECK(duration_ms IS NULL OR duration_ms >= 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,subscription_id) REFERENCES webhook_subscriptions(district_id,id)
);
CREATE INDEX webhook_deliveries_recent ON webhook_deliveries(district_id,subscription_id,occurred_at DESC);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON webhook_deliveries
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

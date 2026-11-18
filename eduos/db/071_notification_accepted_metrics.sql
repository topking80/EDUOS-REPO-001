-- Queue backlog monitoring (release gate, 2026-11-16). Operators need to see
-- when webhook or notification delivery falls behind, without the metrics
-- endpoint exposing any district, recipient or message. Both outboxes are
-- tenant-isolated under forced row-level security, so the runtime role can't
-- count across districts itself. This owner-run function walks the districts,
-- setting the tenant context for each, and returns only totals per queue and
-- state plus the age in seconds of the oldest job that is due. It restores the
-- caller's tenant setting before returning.
CREATE OR REPLACE FUNCTION eduos_queue_backlog()
RETURNS TABLE(queue text, state text, jobs bigint, oldest_seconds double precision)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d uuid;
  prior text := current_setting('app.district_id', true);
  w_ready bigint := 0; w_ready_at timestamptz; w_leased bigint := 0; w_delayed bigint := 0; w_dead bigint := 0;
  n_ready bigint := 0; n_ready_at timestamptz; n_leased bigint := 0; n_delayed bigint := 0; n_failed bigint := 0; n_accepted bigint := 0;
  r record;
BEGIN
  FOR d IN SELECT id FROM districts LOOP
    PERFORM set_config('app.district_id', d::text, true);
    SELECT count(*) FILTER (WHERE (status='pending' AND available_at<=now()) OR (status='processing' AND lease_until<now())) AS ready,
           min(available_at) FILTER (WHERE (status='pending' AND available_at<=now()) OR (status='processing' AND lease_until<now())) AS ready_at,
           count(*) FILTER (WHERE status='processing' AND lease_until>=now()) AS leased,
           count(*) FILTER (WHERE status='pending' AND available_at>now()) AS delayed
      INTO r FROM webhook_outbox WHERE district_id=d AND status IN ('pending','processing');
    w_ready := w_ready + r.ready; w_leased := w_leased + r.leased; w_delayed := w_delayed + r.delayed;
    IF r.ready_at IS NOT NULL AND (w_ready_at IS NULL OR r.ready_at < w_ready_at) THEN w_ready_at := r.ready_at; END IF;
    w_dead := w_dead + (SELECT count(*) FROM webhook_outbox WHERE district_id=d AND status='dead_letter');

    SELECT count(*) FILTER (WHERE coalesce(next_attempt_at, created_at)<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now())) AS ready,
           min(coalesce(next_attempt_at, created_at)) FILTER (WHERE coalesce(next_attempt_at, created_at)<=now() AND (lease_expires_at IS NULL OR lease_expires_at<=now())) AS ready_at,
           count(*) FILTER (WHERE lease_expires_at>now()) AS leased,
           count(*) FILTER (WHERE next_attempt_at>now() AND (lease_expires_at IS NULL OR lease_expires_at<=now())) AS delayed
      INTO r FROM notification_outbox WHERE district_id=d AND status='pending' AND channel<>'in_app';
    n_ready := n_ready + r.ready; n_leased := n_leased + r.leased; n_delayed := n_delayed + r.delayed;
    IF r.ready_at IS NOT NULL AND (n_ready_at IS NULL OR r.ready_at < n_ready_at) THEN n_ready_at := r.ready_at; END IF;
    n_failed := n_failed + (SELECT count(*) FROM notification_outbox WHERE district_id=d AND status='failed' AND channel<>'in_app');
    n_accepted := n_accepted + (SELECT count(*) FROM notification_outbox WHERE district_id=d AND status='accepted' AND channel<>'in_app');
  END LOOP;
  PERFORM set_config('app.district_id', coalesce(prior, ''), true);
  RETURN QUERY VALUES
    ('webhook', 'ready', w_ready, CASE WHEN w_ready_at IS NULL THEN 0 ELSE extract(epoch FROM now() - w_ready_at)::float8 END),
    ('webhook', 'leased', w_leased, 0::float8),
    ('webhook', 'delayed', w_delayed, 0::float8),
    ('webhook', 'dead_letter', w_dead, 0::float8),
    ('notification', 'ready', n_ready, CASE WHEN n_ready_at IS NULL THEN 0 ELSE extract(epoch FROM now() - n_ready_at)::float8 END),
    ('notification', 'leased', n_leased, 0::float8),
    ('notification', 'delayed', n_delayed, 0::float8),
    ('notification', 'failed', n_failed, 0::float8),
    ('notification', 'accepted', n_accepted, 0::float8);
END $$;

-- The terminal-state counts would otherwise scan the whole table each scrape.
CREATE INDEX IF NOT EXISTS webhook_outbox_dead_letter ON webhook_outbox(district_id) WHERE status = 'dead_letter';
CREATE INDEX IF NOT EXISTS notification_outbox_failed ON notification_outbox(district_id) WHERE status = 'failed' AND channel <> 'in_app';

-- Provider-accepted jobs are terminal but should remain visible in metrics.
CREATE INDEX IF NOT EXISTS notification_outbox_accepted ON notification_outbox(district_id) WHERE status = 'accepted' AND channel <> 'in_app';

-- One ledger row per webhook delivery attempt.
--
-- The outbox worker records each attempt with
-- INSERT ... ON CONFLICT DO NOTHING, but webhook_deliveries had no unique key,
-- so the ON CONFLICT never fired. When a worker stalled past its lease and
-- another worker reclaimed the job, both wrote a row with the same
-- (delivery_id, attempt). This index makes the existing ON CONFLICT do what it
-- was written for: the first result recorded for an attempt is kept, and a
-- late duplicate is ignored.
--
-- webhook_deliveries is an append-only ledger, so existing rows aren't
-- rewritten. If an older deployment already holds duplicates, the index only
-- covers rows recorded from this migration on; retention
-- (RETENTION_WEBHOOK_DELIVERY_DAYS, default 90) removes the older ones over time.
-- The check can't SELECT for duplicates first: the ledger is under FORCE ROW
-- LEVEL SECURITY and the migration has no district context, so a SELECT sees
-- no rows. The index build sees every row, so try the full index and fall back
-- if it reports duplicates.
DO $$
DECLARE cutoff timestamptz := now();
BEGIN
  BEGIN
    CREATE UNIQUE INDEX webhook_deliveries_attempt_unique ON webhook_deliveries(delivery_id, attempt);
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'webhook_deliveries has duplicate (delivery_id, attempt) rows; enforcing uniqueness from % on', cutoff;
    EXECUTE format('CREATE UNIQUE INDEX webhook_deliveries_attempt_unique ON webhook_deliveries(delivery_id, attempt) WHERE occurred_at >= %L', cutoff);
  END;
END $$;

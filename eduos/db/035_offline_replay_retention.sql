-- Audit 37.4.0 item 6: retention for offline replay receipts.
--
-- offline_replays holds one opaque receipt per (user, Idempotency-Key) so a
-- second delivery of a queued phone write is a no-op. The API accepts a queued
-- write for 24 hours after it was recorded (QUEUE_MAX_AGE_MS in
-- src/offline-replay.js, plus 2 minutes of clock skew), and a receipt is
-- created no earlier than the write was recorded. A receipt older than that
-- window can never block a legitimate replay again. Until now nothing deleted
-- receipts, so the table grew without bound.
--
-- The purge keeps receipts for at least 2 days, comfortably beyond the replay
-- window, so idempotency protection is never shortened. Run by
-- src/retention.js as the owner role, one district at a time.

CREATE FUNCTION eduos_retention_purge_offline_replays(p_days int) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  IF p_days IS NULL OR p_days < 2 THEN
    RAISE EXCEPTION 'offline replay receipts must be kept at least 2 days (the replay window is 24 hours)';
  END IF;
  DELETE FROM offline_replays WHERE district_id = d AND created_at < now() - make_interval(days => p_days);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN jsonb_build_object('offline_replays', n);
END; $$;
REVOKE ALL ON FUNCTION eduos_retention_purge_offline_replays(int) FROM PUBLIC;

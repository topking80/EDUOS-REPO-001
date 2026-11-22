-- SIS-06: incremental scheduled syncs.
--
-- A schedule can read only what changed since the last successful run
-- (OneRoster dateLastModified; Ed-Fi Change Queries), with a full sync at
-- least every full_sync_hours, and always after any change to the connector
-- (the watermark records the configuration version it was taken under).
-- Incremental runs import students only; class rosters are refreshed by full
-- runs, because removing a roster link needs the complete enrollment list.
-- Like every schedule setting, these need a different district lead's approval.
ALTER TABLE integration_sync_schedules
  ADD COLUMN incremental boolean NOT NULL DEFAULT false,
  ADD COLUMN full_sync_hours integer NOT NULL DEFAULT 24 CHECK (full_sync_hours BETWEEN 1 AND 168);

-- Where the next incremental read starts, and when the last full one finished.
ALTER TABLE integration_connectors
  ADD COLUMN sync_watermark jsonb CHECK (sync_watermark IS NULL OR (jsonb_typeof(sync_watermark) = 'object' AND octet_length(sync_watermark::text) <= 1024)),
  ADD COLUMN last_full_sync_at timestamptz;

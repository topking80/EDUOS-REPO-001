-- FED-10: restores of Master Control from a backup. Recording one (npm run
-- mc:after-restore) makes every district's next policy bundle version jump by
-- version_skip, past any version issued after the backup was taken, so each
-- district's EduOS accepts it (it refuses versions it has already passed).
SET search_path = master_control, pg_temp;

CREATE TABLE restore_events (
  id text PRIMARY KEY CHECK (id ~ '^rs-[0-9a-f]{16}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200),
  backup_taken_at timestamptz,
  version_skip integer NOT NULL CHECK (version_skip BETWEEN 1 AND 1000000),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 5 AND 1000)
);
CREATE TRIGGER restore_events_append_only BEFORE UPDATE OR DELETE ON restore_events FOR EACH ROW EXECUTE FUNCTION reject_change();

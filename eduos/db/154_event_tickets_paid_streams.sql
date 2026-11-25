-- Live event ticketing (plays, concerts, assemblies, ceremonies) and paywalled
-- live streams with season passes, default-off kill switch, write-only stream
-- secret hash, and fail-closed media consent masking for minors.
-- Grants live only in db/runtime_grants.template.sql.

ALTER TABLE school_events
  ADD COLUMN IF NOT EXISTS event_kind text NOT NULL DEFAULT 'sport'
    CHECK (event_kind IN ('sport','play','concert','assembly','ceremony','club_showcase','other'));

CREATE TABLE IF NOT EXISTS school_stream_seasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 140),
  school_year text NOT NULL CHECK (school_year ~ '^\d{4}-\d{4}$'),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS school_stream_seasons_scope_idx
  ON school_stream_seasons(district_id, school_id, status, starts_at DESC);

ALTER TABLE event_ticket_types
  ADD COLUMN IF NOT EXISTS pass_kind text NOT NULL DEFAULT 'admission'
    CHECK (pass_kind IN ('admission','stream_pass','season_stream_pass')),
  ADD COLUMN IF NOT EXISTS stream_season_id uuid REFERENCES school_stream_seasons(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='event_ticket_types_season_pass_chk') THEN
    ALTER TABLE event_ticket_types
      ADD CONSTRAINT event_ticket_types_season_pass_chk
      CHECK ((pass_kind = 'season_stream_pass') = (stream_season_id IS NOT NULL));
  END IF;
END $$;

ALTER TABLE event_streams
  ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'free'
    CHECK (access_mode IN ('free','paid_pass')),
  ADD COLUMN IF NOT EXISTS live_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stream_season_id uuid REFERENCES school_stream_seasons(id),
  ADD COLUMN IF NOT EXISTS media_consent_required boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS unconsented_minors_masked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stream_secret_hash text;

ALTER TABLE school_stream_seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_stream_seasons FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS school_stream_seasons_tenant_scope ON school_stream_seasons;
CREATE POLICY school_stream_seasons_tenant_scope ON school_stream_seasons
  USING (
    district_id = nullif(current_setting('app.district_id', true), '')::uuid
    AND (
      school_id = nullif(current_setting('app.school_id', true), '')::uuid
      OR current_setting('app.role', true) IN ('superintendent', 'it_admin')
    )
  )
  WITH CHECK (
    district_id = nullif(current_setting('app.district_id', true), '')::uuid
    AND (
      school_id = nullif(current_setting('app.school_id', true), '')::uuid
      OR current_setting('app.role', true) IN ('superintendent', 'it_admin')
    )
  );

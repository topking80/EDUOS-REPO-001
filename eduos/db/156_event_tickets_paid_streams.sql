-- Live event ticketing (plays, concerts, assemblies, ceremonies) and paywalled
-- live streams with season passes, default-off kill switch, write-only stream
-- secret hash, and fail-closed media consent masking for minors.
-- Grants live only in db/runtime_grants.template.sql.

ALTER TABLE school_events
  ADD COLUMN IF NOT EXISTS event_kind text NOT NULL DEFAULT 'sport'
    CHECK (event_kind IN ('sport','play','concert','assembly','ceremony','club_showcase','recital','other'));

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

ALTER TABLE school_events DROP CONSTRAINT IF EXISTS school_events_event_kind_check;
ALTER TABLE school_events ADD CONSTRAINT school_events_event_kind_check
  CHECK (event_kind IN ('sport','play','concert','assembly','ceremony','club_showcase','recital','other'));

-- District choice of livestream provider. Credentials are sealed and write-only.
-- This table stores the choice only; no live provider API calls are made here.
CREATE TABLE IF NOT EXISTS district_stream_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'none' CHECK (provider IN ('none','mux','cloudflare_stream','vimeo','other')),
  secrets_enc text CHECK (secrets_enc IS NULL OR (secrets_enc ~ '^c1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$' AND length(secrets_enc) <= 8000)),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE district_stream_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE district_stream_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS district_stream_settings_tenant_scope ON district_stream_settings;
CREATE POLICY district_stream_settings_tenant_scope ON district_stream_settings
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
DROP POLICY IF EXISTS district_stream_settings_admin_write ON district_stream_settings;
CREATE POLICY district_stream_settings_admin_write ON district_stream_settings AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent','it_admin') AND updated_by = eduos_ctx_user()));
DROP POLICY IF EXISTS district_stream_settings_admin_update ON district_stream_settings;
CREATE POLICY district_stream_settings_admin_update ON district_stream_settings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','it_admin'))
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role() IN ('superintendent','it_admin') AND updated_by = eduos_ctx_user()));

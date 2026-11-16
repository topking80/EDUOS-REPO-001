-- 37.6.0 Clubs, sports, school events and guarded ticket inventory.
CREATE TABLE IF NOT EXISTS school_activities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN ('club','sport')),
 title text NOT NULL CHECK(length(title) BETWEEN 2 AND 160), description text NOT NULL DEFAULT '' CHECK(length(description)<=4000),
 grade_min smallint CHECK(grade_min BETWEEN 0 AND 12), grade_max smallint CHECK(grade_max BETWEEN 0 AND 12),
 meeting_details text NOT NULL DEFAULT '' CHECK(length(meeting_details)<=1000),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(grade_min IS NULL OR grade_max IS NULL OR grade_min<=grade_max)
);
CREATE INDEX IF NOT EXISTS school_activities_scope_idx ON school_activities(district_id,school_id,status,kind,title);
CREATE TABLE IF NOT EXISTS activity_staff (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, activity_id uuid NOT NULL REFERENCES school_activities(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id), staff_role text NOT NULL CHECK(staff_role IN ('advisor','coach')),
 assigned_by uuid NOT NULL REFERENCES users(id), assigned_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(district_id,activity_id,user_id)
);
CREATE INDEX IF NOT EXISTS activity_staff_user_idx ON activity_staff(district_id,user_id,activity_id);
CREATE TABLE IF NOT EXISTS activity_memberships (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, activity_id uuid NOT NULL REFERENCES school_activities(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id), status text NOT NULL DEFAULT 'active' CHECK(status IN ('pending','active','declined','withdrawn')),
 joined_at timestamptz NOT NULL DEFAULT now(), reviewed_by uuid REFERENCES users(id), UNIQUE(district_id,activity_id,user_id)
);
CREATE TABLE IF NOT EXISTS school_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, activity_id uuid REFERENCES school_activities(id) ON DELETE SET NULL,
 title text NOT NULL CHECK(length(title) BETWEEN 2 AND 180), description text NOT NULL DEFAULT '' CHECK(length(description)<=4000),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, venue text NOT NULL DEFAULT '' CHECK(length(venue)<=300),
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','cancelled','completed')),
 created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at)
);
CREATE INDEX IF NOT EXISTS school_events_scope_idx ON school_events(district_id,school_id,starts_at,status);
CREATE TABLE IF NOT EXISTS event_ticket_types (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, event_id uuid NOT NULL REFERENCES school_events(id) ON DELETE CASCADE,
 name text NOT NULL CHECK(length(name) BETWEEN 2 AND 80), price_cents integer NOT NULL DEFAULT 0 CHECK(price_cents BETWEEN 0 AND 1000000),
 currency char(3) NOT NULL DEFAULT 'USD' CHECK(currency ~ '^[A-Z]{3}$'), capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 1000000),
 sold_count integer NOT NULL DEFAULT 0 CHECK(sold_count BETWEEN 0 AND capacity), sales_open boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(district_id,event_id,name)
);
CREATE TABLE IF NOT EXISTS event_ticket_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, event_id uuid NOT NULL REFERENCES school_events(id) ON DELETE CASCADE,
 buyer_user_id uuid NOT NULL REFERENCES users(id), ticket_type_id uuid NOT NULL REFERENCES event_ticket_types(id),
 quantity smallint NOT NULL CHECK(quantity BETWEEN 1 AND 10), total_cents integer NOT NULL CHECK(total_cents>=0),
 currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 status text NOT NULL CHECK(status IN ('complimentary','payment_pending','paid','refunded','cancelled')),
 idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 120), provider_reference text,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(district_id,buyer_user_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS event_ticket_orders_event_idx ON event_ticket_orders(district_id,event_id,created_at DESC);
CREATE TABLE IF NOT EXISTS event_tickets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, order_id uuid NOT NULL REFERENCES event_ticket_orders(id) ON DELETE CASCADE,
 event_id uuid NOT NULL REFERENCES school_events(id) ON DELETE CASCADE, ticket_code_hash text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','checked_in','cancelled','refunded')),
 checked_in_at timestamptz, checked_in_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS event_streams (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, event_id uuid NOT NULL REFERENCES school_events(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','provider_pending','live','ended','cancelled')),
 provider text, provider_event_ref text, audience text NOT NULL DEFAULT 'school' CHECK(audience IN ('school','district','ticket_holders')),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, recording_allowed boolean NOT NULL DEFAULT false,
 approved_by uuid REFERENCES users(id), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(ends_at>starts_at), CHECK(provider IS NULL OR provider IN ('mux','cloudflare_stream','vimeo','youtube_unlisted'))
);
CREATE TABLE IF NOT EXISTS activity_media_assets (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, activity_id uuid REFERENCES school_activities(id) ON DELETE CASCADE,
 event_id uuid REFERENCES school_events(id) ON DELETE CASCADE, media_kind text NOT NULL CHECK(media_kind IN ('image','video')),
 storage_key text NOT NULL, mime_type text NOT NULL, byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 52428800),
 consent_status text NOT NULL DEFAULT 'pending' CHECK(consent_status IN ('pending','approved','denied','withdrawn')),
 moderation_status text NOT NULL DEFAULT 'pending' CHECK(moderation_status IN ('pending','approved','rejected')),
 uploaded_by uuid NOT NULL REFERENCES users(id), approved_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(activity_id IS NOT NULL OR event_id IS NOT NULL)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['school_activities','activity_staff','activity_memberships','school_events','event_ticket_types','event_ticket_orders','event_tickets','event_streams','activity_media_assets'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS %I ON %I',t||'_tenant_scope',t);
  EXECUTE format('CREATE POLICY %I ON %I USING (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid) WITH CHECK (district_id=nullif(current_setting(''app.district_id'',true),'''')::uuid)',t||'_tenant_scope',t);
 END LOOP;
END $$;

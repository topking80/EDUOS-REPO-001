-- EduOS 37.6.0 (candidate): district marketplace.
-- The 32.2 app catalog grows vendor listings with a district privacy review.
-- Schools request a listing through the existing app_requests queue; the
-- district approves it through the existing licensing (apps -> app_licenses ->
-- app_assignments). Nothing can be requested or approved until the listing's
-- privacy review is "approved" (enforced here as well as in the API). A fee
-- hook records THAT a billable event happened: no amounts, no payments.
-- Numbered 064: 051-057 and 060 are clubs & sports (#47), 058 is the district
-- AI privacy controls (#48), 059 Leo/Edison; the 37.6 branches are 061-064.
-- src/migrate.js applies every numbered file after 050 in name order.

DO $$
DECLARE def text; kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='notification_outbox'::regclass AND conname='notification_outbox_kind_check';
  -- Reads both forms PostgreSQL prints: ARRAY['a'::text, ...] (as created
  -- by 013/030) and '{a,b}'::text[] (after another widening like this one),
  -- so the 37.6 migrations can widen the list in any order.
  kinds := ARRAY(SELECT DISTINCT (regexp_matches(def, '[''{,]([a-z0-9_]+)(?=[''},])', 'g'))[1]);
  IF NOT 'marketplace' = ANY(kinds) THEN
    kinds := kinds || 'marketplace'::text;
    ALTER TABLE notification_outbox DROP CONSTRAINT notification_outbox_kind_check;
    EXECUTE format('ALTER TABLE notification_outbox ADD CONSTRAINT notification_outbox_kind_check CHECK(kind = ANY(%L::text[]))', kinds);
  END IF;
END $$;

CREATE TABLE marketplace_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  website text CHECK(website IS NULL OR (length(website) <= 308 AND website ~ '^https://[^[:space:]]{3,}$')),
  contact_email text CHECK(contact_email IS NULL OR contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id,id)
);
CREATE UNIQUE INDEX marketplace_vendors_name ON marketplace_vendors(district_id,lower(name));
CREATE TABLE marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  vendor_id uuid NOT NULL,
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  category text NOT NULL CHECK(length(btrim(category)) BETWEEN 1 AND 40),
  description text NOT NULL CHECK(length(btrim(description)) BETWEEN 1 AND 1000),
  grade_levels text[] NOT NULL DEFAULT '{}' CHECK(cardinality(grade_levels) <= 15),
  integration_type text NOT NULL DEFAULT 'link' CHECK(integration_type IN ('link','oidc_sso','lti13')),
  -- (PostgreSQL regex repetition counts stop at 255, so length is checked separately.)
  launch_url text NOT NULL CHECK(length(launch_url) <= 508 AND launch_url ~ '^https://[^[:space:]]{3,}$'),
  data_sharing_scope text NOT NULL DEFAULT 'none' CHECK(data_sharing_scope IN ('none','identity','roster_basic','roster_full')),
  pricing_note text CHECK(pricing_note IS NULL OR length(pricing_note) <= 300),
  privacy_status text NOT NULL DEFAULT 'not_reviewed' CHECK(privacy_status IN ('not_reviewed','in_review','changes_requested','approved','rejected')),
  privacy_checklist jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(privacy_checklist)='object'),
  privacy_notes text CHECK(privacy_notes IS NULL OR length(privacy_notes) <= 1000),
  dpa_expires_on date,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  app_id uuid,
  status text NOT NULL DEFAULT 'listed' CHECK(status IN ('listed','unlisted')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(district_id,id),
  FOREIGN KEY(district_id,vendor_id) REFERENCES marketplace_vendors(district_id,id),
  FOREIGN KEY(district_id,app_id) REFERENCES apps(district_id,id)
);
-- Every privacy decision, with the checklist as it was (append-only).
CREATE TABLE marketplace_privacy_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  listing_id uuid NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  checklist jsonb NOT NULL,
  note text CHECK(note IS NULL OR length(note) <= 1000),
  reviewer uuid NOT NULL REFERENCES users(id),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,listing_id) REFERENCES marketplace_listings(district_id,id)
);
CREATE TRIGGER marketplace_privacy_reviews_append_only BEFORE UPDATE OR DELETE ON marketplace_privacy_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
ALTER TABLE app_requests ADD COLUMN listing_id uuid,
  ADD COLUMN requested_scope text NOT NULL DEFAULT 'school' CHECK(requested_scope IN ('school','district')),
  ADD COLUMN seats_requested integer CHECK(seats_requested IS NULL OR seats_requested BETWEEN 1 AND 100000),
  ADD CONSTRAINT app_requests_listing_fk FOREIGN KEY(district_id,listing_id) REFERENCES marketplace_listings(district_id,id);
-- A marketplace request can only be approved while its listing's privacy
-- review is approved and the DPA (if dated) has not expired, whichever route
-- does the update.
CREATE FUNCTION eduos_marketplace_request_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l marketplace_listings;
BEGIN
  IF NEW.listing_id IS NULL OR NEW.status <> 'approved' OR OLD.status = 'approved' THEN RETURN NEW; END IF;
  SELECT * INTO l FROM marketplace_listings WHERE id=NEW.listing_id AND district_id=NEW.district_id;
  IF l.privacy_status IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'privacy review not approved' USING ERRCODE='23514';
  END IF;
  IF l.dpa_expires_on IS NOT NULL AND l.dpa_expires_on < current_date THEN
    RAISE EXCEPTION 'data privacy agreement expired' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER app_requests_marketplace_guard BEFORE UPDATE ON app_requests
  FOR EACH ROW EXECUTE FUNCTION eduos_marketplace_request_guard();
-- Fee hook PLACEHOLDER: records THAT a billable event happened. No amounts,
-- no payment processing, nothing sent anywhere.
CREATE TABLE marketplace_fee_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  listing_id uuid NOT NULL,
  license_id uuid,
  event text NOT NULL CHECK(event IN ('license_approved')),
  status text NOT NULL DEFAULT 'deferred' CHECK(status IN ('deferred')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,listing_id) REFERENCES marketplace_listings(district_id,id),
  FOREIGN KEY(district_id,license_id) REFERENCES app_licenses(district_id,id)
);
CREATE TRIGGER marketplace_fee_events_append_only BEFORE UPDATE OR DELETE ON marketplace_fee_events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_vendors','marketplace_listings','marketplace_privacy_reviews','marketplace_fee_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- District roles manage and review. Principals and teachers see vendor names
-- and only listed, privacy-approved listings. Families and learners see none.
CREATE POLICY scope_read ON marketplace_vendors AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_district_role() OR eduos_ctx_role() IN ('principal','teacher'));
CREATE POLICY scope_insert ON marketplace_vendors AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_is_district_role());
CREATE POLICY scope_update ON marketplace_vendors AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_district_role()) WITH CHECK (eduos_is_table_owner() OR eduos_is_district_role());
CREATE POLICY scope_read ON marketplace_listings AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_district_role()
         OR (eduos_ctx_role() IN ('principal','teacher') AND status='listed' AND privacy_status='approved'));
CREATE POLICY scope_insert ON marketplace_listings AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_is_district_role());
CREATE POLICY scope_update ON marketplace_listings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_district_role()) WITH CHECK (eduos_is_table_owner() OR eduos_is_district_role());
CREATE POLICY scope_read ON marketplace_privacy_reviews AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_is_district_role());
CREATE POLICY scope_insert ON marketplace_privacy_reviews AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_is_district_role() AND reviewer=eduos_ctx_user()));
CREATE POLICY scope_read ON marketplace_fee_events AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_is_district_role());
CREATE POLICY scope_insert ON marketplace_fee_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_is_district_role() AND created_by=eduos_ctx_user()));
REVOKE ALL ON FUNCTION eduos_marketplace_request_guard() FROM PUBLIC;

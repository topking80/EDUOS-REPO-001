-- 36.0.0: school-scoped librarian role and district-managed borrower card mapping.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('superintendent','it_admin','principal','teacher','parent','pupil','driver','sro','librarian'));
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_school_scope_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_school_scope_check CHECK((role IN ('superintendent','it_admin') AND school_id IS NULL) OR (role NOT IN ('superintendent','it_admin') AND school_id IS NOT NULL));
CREATE TABLE IF NOT EXISTS library_borrower_cards (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 card_hash text NOT NULL, created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(district_id,school_id,card_hash), UNIQUE(district_id,school_id,user_id)
);
ALTER TABLE library_borrower_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE library_borrower_cards FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS library_borrower_card_scope ON library_borrower_cards;
CREATE POLICY library_borrower_card_scope ON library_borrower_cards USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid) WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
ALTER TABLE flow_events DROP CONSTRAINT IF EXISTS flow_events_actor_role_check;
ALTER TABLE flow_events ADD CONSTRAINT flow_events_actor_role_check CHECK(actor_role IN ('superintendent','it_admin','principal','teacher','parent','pupil','driver','sro','librarian'));
ALTER TABLE flow_events DROP CONSTRAINT IF EXISTS flow_events_audience_check;
ALTER TABLE flow_events ADD CONSTRAINT flow_events_audience_check CHECK(cardinality(audience) BETWEEN 1 AND 9 AND audience <@ ARRAY['superintendent','it_admin','principal','teacher','parent','pupil','driver','sro','librarian']::text[]);

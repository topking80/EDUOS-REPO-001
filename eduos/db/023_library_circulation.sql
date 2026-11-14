-- 35.8.0 circulation ledger and reservations; tenant and school scoped.
CREATE TABLE IF NOT EXISTS library_loans (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 item_id uuid NOT NULL REFERENCES library_items(id) ON DELETE RESTRICT,
 borrower_user_id uuid NOT NULL REFERENCES users(id),
 checked_out_by uuid NOT NULL REFERENCES users(id),
 checked_out_at timestamptz NOT NULL DEFAULT now(), due_at timestamptz NOT NULL,
 returned_at timestamptz, returned_to uuid REFERENCES users(id),
 status text NOT NULL DEFAULT 'checked_out' CHECK(status IN ('checked_out','returned','lost','damaged')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS library_loans_borrower_active_idx ON library_loans(district_id,school_id,borrower_user_id,due_at) WHERE returned_at IS NULL;
CREATE INDEX IF NOT EXISTS library_loans_due_idx ON library_loans(district_id,school_id,due_at) WHERE returned_at IS NULL;
CREATE TABLE IF NOT EXISTS library_reservations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 item_id uuid NOT NULL REFERENCES library_items(id) ON DELETE CASCADE,
 borrower_user_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','ready','fulfilled','cancelled','expired')),
 created_at timestamptz NOT NULL DEFAULT now(), ready_at timestamptz, fulfilled_at timestamptz
);
CREATE INDEX IF NOT EXISTS library_reservations_queue_idx ON library_reservations(district_id,school_id,item_id,created_at) WHERE status IN ('queued','ready');
ALTER TABLE library_loans ENABLE ROW LEVEL SECURITY; ALTER TABLE library_loans FORCE ROW LEVEL SECURITY;
ALTER TABLE library_reservations ENABLE ROW LEVEL SECURITY; ALTER TABLE library_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS library_loan_scope ON library_loans;
CREATE POLICY library_loan_scope ON library_loans USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid) WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
DROP POLICY IF EXISTS library_reservation_scope ON library_reservations;
CREATE POLICY library_reservation_scope ON library_reservations USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid) WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);

-- 36.1.0 renewal controls; family access is resolved from active student-user links.
ALTER TABLE library_loans ADD COLUMN IF NOT EXISTS renewal_count integer NOT NULL DEFAULT 0 CHECK(renewal_count BETWEEN 0 AND 2);
ALTER TABLE library_loans ADD COLUMN IF NOT EXISTS last_renewed_at timestamptz;
CREATE INDEX IF NOT EXISTS library_loans_family_history_idx ON library_loans(district_id,borrower_user_id,checked_out_at DESC);

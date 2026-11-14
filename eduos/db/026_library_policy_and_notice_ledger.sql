-- 36.2.0 district borrowing policy and auditable overdue notice ledger
CREATE TABLE IF NOT EXISTS library_borrowing_policies (
 district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
 loan_days integer NOT NULL DEFAULT 14 CHECK(loan_days BETWEEN 1 AND 120),
 max_renewals integer NOT NULL DEFAULT 2 CHECK(max_renewals BETWEEN 0 AND 10),
 renewal_days integer NOT NULL DEFAULT 14 CHECK(renewal_days BETWEEN 1 AND 120),
 overdue_grace_days integer NOT NULL DEFAULT 0 CHECK(overdue_grace_days BETWEEN 0 AND 60),
 updated_by uuid REFERENCES users(id), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(district_id,school_id)
);
CREATE TABLE IF NOT EXISTS library_notice_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
 school_id uuid NOT NULL REFERENCES schools(id) ON DELETE CASCADE, loan_id uuid NOT NULL REFERENCES library_loans(id) ON DELETE CASCADE,
 borrower_user_id uuid NOT NULL REFERENCES users(id), notice_type text NOT NULL CHECK(notice_type IN ('overdue_digest','due_soon')),
 notice_date date NOT NULL DEFAULT CURRENT_DATE, channel text NOT NULL DEFAULT 'in_app' CHECK(channel IN ('in_app','email','sms')),
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sent','skipped','failed')),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(loan_id,notice_type,notice_date,channel)
);
ALTER TABLE library_borrowing_policies ENABLE ROW LEVEL SECURITY; ALTER TABLE library_borrowing_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE library_notice_ledger ENABLE ROW LEVEL SECURITY; ALTER TABLE library_notice_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS library_policy_tenant_scope ON library_borrowing_policies;
CREATE POLICY library_policy_tenant_scope ON library_borrowing_policies USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid) WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);
DROP POLICY IF EXISTS library_notice_tenant_scope ON library_notice_ledger;
CREATE POLICY library_notice_tenant_scope ON library_notice_ledger USING(district_id=nullif(current_setting('app.district_id',true),'')::uuid) WITH CHECK(district_id=nullif(current_setting('app.district_id',true),'')::uuid);

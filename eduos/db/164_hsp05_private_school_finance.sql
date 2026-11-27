-- HSP-05: private school tuition and finance (design: docs/product/hsp-05-tuition-and-finance.md).
--
-- Billing is separate from academic records, and duties are separated:
--   finance           billing accounts, invoices, recording payments, asking for aid and refunds, preparing reconciliations
--   school admin      approves payment providers, aid and discounts, and refunds, and signs reconciliations off,
--                     never their own request or preparation
--   guardian          their own account's invoices, payments and receipts
--   everyone else     nothing
-- EduOS keeps no card or bank details: a payment provider is an account
-- reference, and a payment records how it was paid and its reference.
-- Money is in US cents. Issued invoices don't change: they're paid, or voided
-- with a reason, and corrections are new lines on a new invoice.

CREATE TABLE ps_payment_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  provider text NOT NULL CHECK (provider IN ('manual','paypal','square','btcpay','other')),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 2 AND 80),
  account_reference text CHECK (account_reference IS NULL OR length(btrim(account_reference)) BETWEEN 2 AND 120),
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','disabled')),
  proposed_by uuid NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  CHECK ((status = 'proposed') = (approved_by IS NULL) OR status = 'disabled'),
  CHECK (approved_by IS NULL OR approved_by <> proposed_by),
  UNIQUE (school_id, id)
);

CREATE TABLE ps_billing_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  payer_membership_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, payer_membership_id) REFERENCES private_school_memberships(school_id, id),
  UNIQUE (school_id, id)
);

CREATE TABLE ps_billing_account_learners (
  school_id uuid NOT NULL,
  account_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  PRIMARY KEY (account_id, learner_id),
  FOREIGN KEY (school_id, account_id) REFERENCES ps_billing_accounts(school_id, id),
  FOREIGN KEY (school_id, learner_id) REFERENCES private_school_learners(school_id, id)
);

CREATE TABLE ps_invoice_counters (school_id uuid NOT NULL, year integer NOT NULL, last integer NOT NULL DEFAULT 0, PRIMARY KEY (school_id, year));

CREATE TABLE ps_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  account_id uuid NOT NULL,
  number text,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','void')),
  due_on date,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  issued_by uuid REFERENCES users(id),
  issued_at timestamptz,
  total_cents bigint,
  voided_by uuid REFERENCES users(id),
  voided_at timestamptz,
  void_reason text CHECK (void_reason IS NULL OR length(btrim(void_reason)) BETWEEN 3 AND 300),
  FOREIGN KEY (school_id, account_id) REFERENCES ps_billing_accounts(school_id, id),
  CHECK ((status = 'draft') = (issued_at IS NULL) OR (status = 'void' AND issued_at IS NULL)),
  CHECK ((issued_at IS NULL) = (number IS NULL) AND (issued_at IS NULL) = (total_cents IS NULL)),
  CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  UNIQUE (school_id, id),
  UNIQUE (school_id, number)
);

CREATE TABLE ps_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('tuition','fee','aid','discount','credit')),
  description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  learner_id uuid,
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0 AND abs(amount_cents) <= 100000000),
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  FOREIGN KEY (school_id, invoice_id) REFERENCES ps_invoices(school_id, id),
  FOREIGN KEY (school_id, learner_id) REFERENCES private_school_learners(school_id, id),
  -- Charges are positive; aid, discounts and credits reduce the bill.
  CHECK ((kind IN ('tuition','fee')) = (amount_cents > 0)),
  -- Aid and discounts need a school administrator's approval, not the person who added them.
  CHECK (kind NOT IN ('aid','discount') OR approved_by IS NULL OR approved_by <> created_by)
);

CREATE TABLE ps_receipt_counters (school_id uuid NOT NULL, year integer NOT NULL, last integer NOT NULL DEFAULT 0, PRIMARY KEY (school_id, year));

CREATE TABLE ps_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 100000000),
  method text NOT NULL CHECK (method IN ('check','ach','cash','provider','other')),
  provider_id uuid,
  reference text CHECK (reference IS NULL OR length(btrim(reference)) BETWEEN 1 AND 120),
  received_on date NOT NULL,
  receipt_number text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (school_id, invoice_id) REFERENCES ps_invoices(school_id, id),
  FOREIGN KEY (school_id, provider_id) REFERENCES ps_payment_providers(school_id, id),
  CHECK ((method = 'provider') = (provider_id IS NOT NULL)),
  UNIQUE (school_id, id),
  UNIQUE (school_id, receipt_number)
);
CREATE TRIGGER ps_payments_append_only BEFORE UPDATE OR DELETE ON ps_payments FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

CREATE TABLE ps_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 300),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected')),
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  FOREIGN KEY (school_id, payment_id) REFERENCES ps_payments(school_id, id),
  CHECK ((status = 'requested') = (decided_by IS NULL)),
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

CREATE TABLE ps_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES private_schools(id),
  period_from date NOT NULL,
  period_to date NOT NULL,
  totals jsonb NOT NULL CHECK (jsonb_typeof(totals) = 'object'),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  prepared_by uuid NOT NULL REFERENCES users(id),
  prepared_at timestamptz NOT NULL DEFAULT now(),
  signed_off_by uuid REFERENCES users(id),
  signed_off_at timestamptz,
  CHECK (period_to >= period_from),
  CHECK (signed_off_by IS NULL OR signed_off_by <> prepared_by),
  CHECK ((signed_off_by IS NULL) = (signed_off_at IS NULL))
);

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION eduos_ps_finance() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT eduos_ps_has(ARRAY['finance','school_admin']) $$;
-- A guardian's own billing account (by the session's membership).
CREATE FUNCTION eduos_ps_pays(p_account uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ps_has(ARRAY['guardian']) AND EXISTS (SELECT 1 FROM ps_billing_accounts a WHERE a.id = p_account AND a.school_id = eduos_ctx_private_school()
    AND a.payer_membership_id = eduos_ctx_ps_membership())
$$;
CREATE FUNCTION eduos_ps_invoice_account(p_invoice uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT account_id FROM ps_invoices WHERE id = p_invoice AND school_id = eduos_ctx_private_school() $$;
CREATE FUNCTION eduos_ps_payment_invoice(p_payment uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$ SELECT invoice_id FROM ps_payments WHERE id = p_payment AND school_id = eduos_ctx_private_school() $$;
-- Billing sees only the names of enrolled learners (for invoice lines), nothing else of their records.
CREATE FUNCTION eduos_ps_billing_learners() RETURNS TABLE(id uuid, display_name text, enrollment_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.display_name, l.enrollment_status FROM private_school_learners l WHERE eduos_ps_finance() AND l.school_id = eduos_ctx_private_school() ORDER BY l.display_name
$$;
-- The next invoice or receipt number for the school and year: INV-2026-0001, RCT-2026-0001.
CREATE FUNCTION eduos_ps_next_number(p_kind text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE y integer := extract(year FROM now() AT TIME ZONE 'UTC'); n integer;
BEGIN
  IF NOT eduos_ps_finance() THEN RAISE EXCEPTION 'finance only' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_kind = 'invoice' THEN
    INSERT INTO ps_invoice_counters(school_id, year, last) VALUES (eduos_ctx_private_school(), y, 1)
      ON CONFLICT (school_id, year) DO UPDATE SET last = ps_invoice_counters.last + 1 RETURNING last INTO n;
    RETURN format('INV-%s-%s', y, lpad(n::text, 4, '0'));
  ELSIF p_kind = 'receipt' THEN
    INSERT INTO ps_receipt_counters(school_id, year, last) VALUES (eduos_ctx_private_school(), y, 1)
      ON CONFLICT (school_id, year) DO UPDATE SET last = ps_receipt_counters.last + 1 RETURNING last INTO n;
    RETURN format('RCT-%s-%s', y, lpad(n::text, 4, '0'));
  END IF;
  RAISE EXCEPTION 'unknown kind';
END $$;

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_payment_providers','ps_billing_accounts','ps_billing_account_learners','ps_invoices','ps_invoice_lines','ps_payments','ps_refunds','ps_reconciliations',
                           'ps_invoice_counters','ps_receipt_counters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY school_isolation ON %I
      USING (eduos_is_table_owner() OR school_id = eduos_ctx_private_school())
      WITH CHECK (eduos_is_table_owner() OR school_id = eduos_ctx_private_school())$p$, t);
    EXECUTE format($p$CREATE POLICY members_only ON %I AS RESTRICTIVE
      USING (CASE WHEN eduos_is_table_owner() THEN true ELSE cardinality(eduos_ps_roles()) > 0 END)$p$, t);
  END LOOP;
END $$;
-- Counters: only through eduos_ps_next_number (the owner).
CREATE POLICY counters_owner ON ps_invoice_counters AS RESTRICTIVE USING (eduos_is_table_owner());
CREATE POLICY counters_owner ON ps_receipt_counters AS RESTRICTIVE USING (eduos_is_table_owner());
-- Finance and the school admin see billing; guardians their own account's.
CREATE POLICY billing_finance ON ps_payment_providers AS RESTRICTIVE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() END);
CREATE POLICY billing_visible ON ps_billing_accounts AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() OR eduos_ps_pays(id) END);
CREATE POLICY billing_written ON ps_billing_accounts AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() END);
CREATE POLICY billing_changed ON ps_billing_accounts AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() END);
CREATE POLICY account_learners_visible ON ps_billing_account_learners AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() OR eduos_ps_pays(account_id) END);
CREATE POLICY account_learners_written ON ps_billing_account_learners AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() END);
CREATE POLICY account_learners_deleted ON ps_billing_account_learners AS RESTRICTIVE FOR DELETE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() END);
-- Guardians see issued invoices only, never drafts.
CREATE POLICY invoice_visible ON ps_invoices AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() OR (eduos_ps_pays(account_id) AND status IN ('issued','void') AND issued_at IS NOT NULL) END);
CREATE POLICY invoice_written ON ps_invoices AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() AND eduos_ps_active() END);
CREATE POLICY invoice_changed ON ps_invoices AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() END);
CREATE POLICY line_visible ON ps_invoice_lines AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE EXISTS (SELECT 1 FROM ps_invoices i WHERE i.id = invoice_id) END);
CREATE POLICY line_written ON ps_invoice_lines AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() AND created_by = eduos_ctx_user() AND EXISTS (SELECT 1 FROM ps_invoices i WHERE i.id = invoice_id AND i.status = 'draft') END);
-- Only a school administrator approves aid and discounts.
CREATE POLICY line_approved ON ps_invoice_lines AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) AND EXISTS (SELECT 1 FROM ps_invoices i WHERE i.id = invoice_id AND i.status = 'draft') END);
CREATE POLICY line_deleted ON ps_invoice_lines AS RESTRICTIVE FOR DELETE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() AND EXISTS (SELECT 1 FROM ps_invoices i WHERE i.id = invoice_id AND i.status = 'draft') END);
CREATE POLICY payment_visible ON ps_payments AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() OR eduos_ps_pays(eduos_ps_invoice_account(invoice_id)) END);
CREATE POLICY payment_written ON ps_payments AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() AND recorded_by = eduos_ctx_user() END);
CREATE POLICY refund_visible ON ps_refunds AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() OR (status = 'approved' AND eduos_ps_pays(eduos_ps_invoice_account(eduos_ps_payment_invoice(payment_id)))) END);
CREATE POLICY refund_requested ON ps_refunds AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() AND requested_by = eduos_ctx_user() AND status = 'requested' END);
CREATE POLICY refund_decided ON ps_refunds AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) END);
CREATE POLICY reconciliation_finance ON ps_reconciliations AS RESTRICTIVE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_finance() END);
CREATE POLICY reconciliation_signed ON ps_reconciliations AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) END);
-- Provider approval: the school admin, not whoever proposed it (checked by the table too).
CREATE POLICY provider_approved ON ps_payment_providers AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_ps_has(ARRAY['school_admin']) END);

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_ps_finance()','eduos_ps_pays(uuid)','eduos_ps_invoice_account(uuid)','eduos_ps_payment_invoice(uuid)','eduos_ps_billing_learners()','eduos_ps_next_number(text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;

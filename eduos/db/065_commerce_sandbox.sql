-- EduOS 37.7.0 (candidate): commerce, SANDBOX ONLY.
-- Paid event tickets (inventory holds, orders, refunds, receipts, hashed QR
-- check-in codes), a marketplace purchase flow on the 37.6 fee hook, and an
-- append-only revenue ledger in integer cents. The deck's split (p39-p40):
-- net school commerce goes 85% school / 10% district / 5% state fund after
-- the processor's fee, sales tax and the 3% EdOS network fee; the marketplace
-- keeps a 5% vendor fee. Every settlement and refund is also an EDAL entry.
--
-- Nothing here moves money. The only payment adapter is "sandbox" (no keys,
-- no network). Commerce is off unless the server runs with
-- COMMERCE_PAYMENT_PROVIDER=sandbox AND the superintendent enables it.
-- No student data is stored in any commerce table: the payer is the adult
-- (guardian or district) account, and pupils cannot pay.
--
-- Numbered 065 (after the 37.6 marketplace, 064). The open FCM device push
-- branch (#52) must renumber past this file before it merges.

-- 1. EDAL learns two kinds. Reads both printed forms of the CHECK, like the
--    notification widenings in 062-064.
DO $$
DECLARE def text; kinds text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='edal_entries'::regclass AND conname='edal_entries_kind_check';
  IF def IS NULL THEN RAISE EXCEPTION 'edal_entries_kind_check not found'; END IF;
  kinds := ARRAY(SELECT DISTINCT (regexp_matches(def, '[''{,]([a-z0-9_]+)(?=[''},])', 'g'))[1]);
  IF NOT ('commerce_settlement' = ANY(kinds) AND 'commerce_refund' = ANY(kinds)) THEN
    kinds := ARRAY(SELECT DISTINCT k FROM unnest(kinds || ARRAY['commerce_settlement','commerce_refund']) k ORDER BY k);
    ALTER TABLE edal_entries DROP CONSTRAINT edal_entries_kind_check;
    EXECUTE format('ALTER TABLE edal_entries ADD CONSTRAINT edal_entries_kind_check CHECK(kind = ANY(%L::text[]))', kinds);
  END IF;
END $$;
-- The payer appends the settlement; a school leader (or the superintendent)
-- the refund. Commerce entries never name a student. The recorder can read
-- back their own entry (INSERT ... RETURNING needs it).
DROP POLICY scope_insert ON edal_entries;
CREATE POLICY scope_insert ON edal_entries AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (recorded_by=eduos_ctx_user() AND (
       (kind='final_grade' AND eduos_learning_staff(school_id, subject_student_id))
    OR (kind IN ('credential','credential_revoked') AND eduos_is_school_lead(school_id))
    OR (kind='mastery_milestone' AND (eduos_learning_staff(school_id, subject_student_id) OR (eduos_ctx_role()='pupil' AND eduos_is_linked_student(subject_student_id))))
    OR (kind='commerce_settlement' AND subject_student_id IS NULL AND eduos_ctx_role() IN ('parent','superintendent'))
    OR (kind='commerce_refund' AND subject_student_id IS NULL
        AND (eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school()))))));
DROP POLICY scope_read ON edal_entries;
CREATE POLICY scope_read ON edal_entries AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school())
      OR (subject_student_id IS NOT NULL AND (eduos_teaches_student(subject_student_id) OR eduos_is_linked_student(subject_student_id)))
      OR (kind IN ('commerce_settlement','commerce_refund') AND recorded_by=eduos_ctx_user()));

-- 2. District settings. Off by default; the split must add up to 100%.
CREATE TABLE commerce_settings (
  district_id uuid PRIMARY KEY REFERENCES districts(id),
  enabled boolean NOT NULL DEFAULT false,
  network_fee_bps integer NOT NULL DEFAULT 300 CHECK(network_fee_bps BETWEEN 0 AND 1000),
  sales_tax_bps integer NOT NULL DEFAULT 0 CHECK(sales_tax_bps BETWEEN 0 AND 3000),
  school_share_bps integer NOT NULL DEFAULT 8500 CHECK(school_share_bps BETWEEN 0 AND 10000),
  district_share_bps integer NOT NULL DEFAULT 1000 CHECK(district_share_bps BETWEEN 0 AND 10000),
  state_share_bps integer NOT NULL DEFAULT 500 CHECK(state_share_bps BETWEEN 0 AND 10000),
  state_fund_label text NOT NULL DEFAULT 'State education fund' CHECK(length(btrim(state_fund_label)) BETWEEN 1 AND 120),
  marketplace_fee_bps integer NOT NULL DEFAULT 500 CHECK(marketplace_fee_bps BETWEEN 0 AND 3000),
  hold_minutes integer NOT NULL DEFAULT 10 CHECK(hold_minutes BETWEEN 2 AND 60),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(school_share_bps + district_share_bps + state_share_bps = 10000)
);

-- 3. Ticket orders gain a hold and payment times. Orders and tickets move
--    only along these transitions, whoever updates them.
ALTER TABLE event_ticket_orders ADD COLUMN hold_expires_at timestamptz,
  ADD COLUMN paid_at timestamptz, ADD COLUMN refunded_at timestamptz,
  ADD CONSTRAINT event_ticket_orders_hold_check CHECK(status <> 'payment_pending' OR hold_expires_at IS NOT NULL);
CREATE INDEX event_ticket_orders_holds ON event_ticket_orders(district_id, hold_expires_at) WHERE status='payment_pending';
CREATE FUNCTION eduos_ticket_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.district_id<>OLD.district_id OR NEW.school_id<>OLD.school_id OR NEW.event_id<>OLD.event_id OR NEW.buyer_user_id<>OLD.buyer_user_id
     OR NEW.ticket_type_id<>OLD.ticket_type_id OR NEW.quantity<>OLD.quantity OR NEW.total_cents<>OLD.total_cents OR NEW.currency<>OLD.currency
     OR NEW.idempotency_key<>OLD.idempotency_key THEN
    RAISE EXCEPTION 'ticket order terms are fixed' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT ((OLD.status='payment_pending' AND NEW.status IN ('paid','cancelled')) OR (OLD.status='paid' AND NEW.status='refunded')) THEN
    RAISE EXCEPTION 'ticket order cannot go from % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER event_ticket_orders_guard BEFORE UPDATE ON event_ticket_orders FOR EACH ROW EXECUTE FUNCTION eduos_ticket_order_guard();
CREATE FUNCTION eduos_ticket_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_id<>OLD.order_id OR NEW.event_id<>OLD.event_id OR NEW.district_id<>OLD.district_id OR NEW.school_id<>OLD.school_id THEN
    RAISE EXCEPTION 'ticket terms are fixed' USING ERRCODE='23514';
  END IF;
  IF NEW.ticket_code_hash<>OLD.ticket_code_hash AND OLD.status<>'issued' THEN
    RAISE EXCEPTION 'only an unused ticket gets a new code' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT (OLD.status='issued' AND NEW.status IN ('checked_in','cancelled','refunded')) THEN
    RAISE EXCEPTION 'ticket cannot go from % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER event_tickets_guard BEFORE UPDATE ON event_tickets FOR EACH ROW EXECUTE FUNCTION eduos_ticket_guard();
-- Families see only their own orders and tickets; staff keep the school view
-- (the school-scope tenant policy from 056 still applies on top).
CREATE POLICY scope_buyer ON event_ticket_orders AS RESTRICTIVE FOR ALL
  USING (eduos_is_table_owner() OR buyer_user_id=eduos_ctx_user() OR eduos_ctx_role() IN ('superintendent','it_admin','principal','vice_principal','teacher'))
  WITH CHECK (eduos_is_table_owner() OR buyer_user_id=eduos_ctx_user() OR eduos_ctx_role() IN ('superintendent','it_admin','principal','vice_principal','teacher'));
CREATE POLICY scope_buyer ON event_tickets AS RESTRICTIVE FOR ALL
  USING (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','it_admin','principal','vice_principal','teacher')
         OR EXISTS(SELECT 1 FROM event_ticket_orders o WHERE o.id=order_id AND o.buyer_user_id=eduos_ctx_user()))
  WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role() IN ('superintendent','it_admin','principal','vice_principal','teacher')
         OR EXISTS(SELECT 1 FROM event_ticket_orders o WHERE o.id=order_id AND o.buyer_user_id=eduos_ctx_user()));

-- 4. Marketplace prices and purchases. A purchase pays for one approved
--    license (one fee event from the 37.6 hook).
ALTER TABLE marketplace_listings ADD COLUMN unit_price_cents integer CHECK(unit_price_cents IS NULL OR unit_price_cents BETWEEN 1 AND 10000000),
  ADD COLUMN price_unit text NOT NULL DEFAULT 'seat' CHECK(price_unit IN ('seat','flat'));
CREATE TABLE marketplace_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  fee_event_id uuid NOT NULL REFERENCES marketplace_fee_events(id),
  listing_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  license_id uuid,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 100000),
  unit_price_cents integer NOT NULL CHECK(unit_price_cents BETWEEN 1 AND 10000000),
  total_cents integer NOT NULL CHECK(total_cents BETWEEN 1 AND 100000000),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK(currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'payment_pending' CHECK(status IN ('payment_pending','paid','refunded','cancelled')),
  idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 16 AND 120),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  CHECK(total_cents = quantity * unit_price_cents),
  UNIQUE(district_id, created_by, idempotency_key),
  UNIQUE(district_id, id),
  FOREIGN KEY(district_id, listing_id) REFERENCES marketplace_listings(district_id, id),
  FOREIGN KEY(district_id, vendor_id) REFERENCES marketplace_vendors(district_id, id),
  FOREIGN KEY(district_id, license_id) REFERENCES app_licenses(district_id, id)
);
CREATE UNIQUE INDEX marketplace_purchases_one_per_fee ON marketplace_purchases(fee_event_id) WHERE status IN ('payment_pending','paid');
CREATE FUNCTION eduos_marketplace_purchase_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.district_id<>OLD.district_id OR NEW.fee_event_id<>OLD.fee_event_id OR NEW.total_cents<>OLD.total_cents OR NEW.quantity<>OLD.quantity
     OR NEW.unit_price_cents<>OLD.unit_price_cents OR NEW.created_by<>OLD.created_by OR NEW.vendor_id<>OLD.vendor_id THEN
    RAISE EXCEPTION 'purchase terms are fixed' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT ((OLD.status='payment_pending' AND NEW.status IN ('paid','cancelled')) OR (OLD.status='paid' AND NEW.status='refunded')) THEN
    RAISE EXCEPTION 'purchase cannot go from % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER marketplace_purchases_guard BEFORE UPDATE ON marketplace_purchases FOR EACH ROW EXECUTE FUNCTION eduos_marketplace_purchase_guard();

-- 5. Payments (sandbox only). Amount, payer and fee never change; status
--    moves forward only.
CREATE TABLE commerce_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid REFERENCES schools(id),
  purpose text NOT NULL CHECK(purpose IN ('event_tickets','marketplace_license')),
  ticket_order_id uuid REFERENCES event_ticket_orders(id),
  marketplace_purchase_id uuid REFERENCES marketplace_purchases(id),
  payer_user_id uuid NOT NULL REFERENCES users(id),
  amount_cents integer NOT NULL CHECK(amount_cents BETWEEN 1 AND 100000000),
  currency char(3) NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
  processing_fee_cents integer NOT NULL CHECK(processing_fee_cents >= 0 AND processing_fee_cents <= amount_cents),
  provider text NOT NULL CHECK(provider IN ('sandbox')),
  provider_ref text NOT NULL UNIQUE CHECK(provider_ref ~ '^pay_sandbox_[0-9a-f]{24}$'),
  refund_ref text CHECK(refund_ref IS NULL OR refund_ref ~ '^re_sandbox_[0-9a-f]{24}$'),
  status text NOT NULL DEFAULT 'requires_confirmation' CHECK(status IN ('requires_confirmation','succeeded','declined','expired','refunded')),
  decline_code text CHECK(decline_code IS NULL OR decline_code ~ '^[a-z_]{1,60}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  refunded_at timestamptz,
  CHECK((purpose='event_tickets') = (ticket_order_id IS NOT NULL)),
  CHECK((purpose='marketplace_license') = (marketplace_purchase_id IS NOT NULL)),
  CHECK(purpose <> 'event_tickets' OR school_id IS NOT NULL),
  UNIQUE(district_id, id)
);
CREATE UNIQUE INDEX commerce_payments_one_live_order ON commerce_payments(ticket_order_id) WHERE status IN ('requires_confirmation','succeeded','refunded');
CREATE UNIQUE INDEX commerce_payments_one_live_purchase ON commerce_payments(marketplace_purchase_id) WHERE status IN ('requires_confirmation','succeeded','refunded');
CREATE INDEX commerce_payments_school ON commerce_payments(district_id, school_id, created_at DESC);
CREATE INDEX commerce_payments_payer ON commerce_payments(district_id, payer_user_id, created_at DESC);
CREATE FUNCTION eduos_commerce_payment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.district_id<>OLD.district_id OR NEW.school_id IS DISTINCT FROM OLD.school_id OR NEW.purpose<>OLD.purpose
     OR NEW.ticket_order_id IS DISTINCT FROM OLD.ticket_order_id OR NEW.marketplace_purchase_id IS DISTINCT FROM OLD.marketplace_purchase_id
     OR NEW.payer_user_id<>OLD.payer_user_id OR NEW.amount_cents<>OLD.amount_cents OR NEW.currency<>OLD.currency
     OR NEW.processing_fee_cents<>OLD.processing_fee_cents OR NEW.provider<>OLD.provider OR NEW.provider_ref<>OLD.provider_ref THEN
    RAISE EXCEPTION 'payment terms are fixed' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT ((OLD.status='requires_confirmation' AND NEW.status IN ('succeeded','declined','expired'))
                                    OR (OLD.status='succeeded' AND NEW.status='refunded')) THEN
    RAISE EXCEPTION 'payment cannot go from % to %', OLD.status, NEW.status USING ERRCODE='23514';
  END IF;
  IF NEW.status='refunded' AND NEW.refund_ref IS NULL THEN RAISE EXCEPTION 'a refund needs its reference' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER commerce_payments_guard BEFORE UPDATE ON commerce_payments FOR EACH ROW EXECUTE FUNCTION eduos_commerce_payment_guard();

-- 6. The revenue ledger and receipts: append-only, written only by
--    eduos_commerce_record() below. Settlement lines are >= 0 and add up to
--    the gross; a refund is the exact negation of its settlement.
CREATE TABLE commerce_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  payment_id uuid NOT NULL,
  school_id uuid REFERENCES schools(id),
  entry_kind text NOT NULL CHECK(entry_kind IN ('settlement','refund')),
  line text NOT NULL CHECK(line IN ('gross','processing_fee','sales_tax','network_fee','school_share','district_share','state_share','marketplace_fee','vendor_payable')),
  recipient text NOT NULL CHECK(recipient IN ('payer','processor','tax_authority','platform','school','district','state_fund','vendor')),
  recipient_id uuid,
  amount_cents bigint NOT NULL CHECK(amount_cents BETWEEN -100000000 AND 100000000),
  edal_entry_id uuid NOT NULL REFERENCES edal_entries(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK((entry_kind='settlement' AND amount_cents >= 0) OR (entry_kind='refund' AND amount_cents <= 0)),
  UNIQUE(payment_id, entry_kind, line),
  FOREIGN KEY(district_id, payment_id) REFERENCES commerce_payments(district_id, id)
);
CREATE INDEX commerce_ledger_school ON commerce_ledger_entries(district_id, school_id, created_at);
CREATE TABLE commerce_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  payment_id uuid NOT NULL,
  school_id uuid REFERENCES schools(id),
  kind text NOT NULL CHECK(kind IN ('payment','refund')),
  receipt_number text NOT NULL CHECK(receipt_number ~ '^R-[0-9]{8}-[0-9A-F]{10}$'),
  payer_user_id uuid NOT NULL REFERENCES users(id),
  amount_cents bigint NOT NULL,
  currency char(3) NOT NULL,
  description text NOT NULL CHECK(length(description) BETWEEN 1 AND 300),
  lines jsonb NOT NULL CHECK(jsonb_typeof(lines)='array'),
  edal_entry_id uuid NOT NULL REFERENCES edal_entries(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_id, kind),
  UNIQUE(district_id, receipt_number),
  FOREIGN KEY(district_id, payment_id) REFERENCES commerce_payments(district_id, id)
);
CREATE TRIGGER commerce_ledger_append_only BEFORE UPDATE OR DELETE ON commerce_ledger_entries FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER commerce_receipts_append_only BEFORE UPDATE OR DELETE ON commerce_receipts FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

-- 7. Row-level security.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commerce_settings','marketplace_purchases','commerce_payments','commerce_ledger_entries','commerce_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
-- Settings: everyone in the district may read the rates (families see the
-- split on their receipt); only the superintendent changes them.
CREATE POLICY scope_write ON commerce_settings AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='superintendent');
CREATE POLICY scope_update ON commerce_settings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent') WITH CHECK (eduos_is_table_owner() OR eduos_ctx_role()='superintendent');
CREATE POLICY scope_all ON marketplace_purchases AS RESTRICTIVE FOR ALL
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent')
  WITH CHECK (eduos_is_table_owner() OR (eduos_ctx_role()='superintendent' AND created_by=eduos_ctx_user()));
-- Payments: the payer, the school's leaders, the superintendent.
CREATE POLICY scope_read ON commerce_payments AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR payer_user_id=eduos_ctx_user() OR eduos_ctx_role()='superintendent'
         OR (school_id IS NOT NULL AND eduos_ctx_role()='principal' AND school_id=eduos_ctx_school()));
CREATE POLICY scope_insert ON commerce_payments AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (payer_user_id=eduos_ctx_user() AND (
       (purpose='event_tickets' AND eduos_ctx_role()='parent')
    OR (purpose='marketplace_license' AND eduos_ctx_role()='superintendent'))));
CREATE POLICY scope_update ON commerce_payments AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR payer_user_id=eduos_ctx_user() OR eduos_ctx_role()='superintendent'
         OR (school_id IS NOT NULL AND eduos_ctx_role()='principal' AND school_id=eduos_ctx_school()))
  WITH CHECK (eduos_is_table_owner() OR payer_user_id=eduos_ctx_user() OR eduos_ctx_role()='superintendent'
         OR (school_id IS NOT NULL AND eduos_ctx_role()='principal' AND school_id=eduos_ctx_school()));
-- Ledger: leaders only (the payer sees their lines on the receipt).
CREATE POLICY scope_read ON commerce_ledger_entries AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_ctx_role()='superintendent' OR (eduos_ctx_role()='principal' AND school_id=eduos_ctx_school()));
CREATE POLICY scope_insert ON commerce_ledger_entries AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_read ON commerce_receipts AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR payer_user_id=eduos_ctx_user() OR eduos_ctx_role()='superintendent'
         OR (school_id IS NOT NULL AND eduos_ctx_role()='principal' AND school_id=eduos_ctx_school()));
CREATE POLICY scope_insert ON commerce_receipts AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());

-- 8. Recording a settlement or refund. The API appends the EDAL entry (its
--    payload names the payment and carries the lines), then calls this,
--    which checks the caller's right, the EDAL entry and the arithmetic, and
--    writes the ledger lines and the receipt. Returns the receipt.
CREATE FUNCTION eduos_commerce_record(p_payment uuid, p_kind text, p_edal_entry uuid, p_lines jsonb, p_description text)
RETURNS TABLE(receipt_id uuid, receipt_number text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); u uuid := eduos_ctx_user(); r text := eduos_ctx_role();
  p commerce_payments; e edal_entries; payload text; gross bigint; rest bigint; n int; nd int; num text; rid uuid;
BEGIN
  IF d IS NULL OR u IS NULL THEN RAISE EXCEPTION 'session context required' USING ERRCODE='42501'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('settlement','refund') THEN RAISE EXCEPTION 'unknown entry kind' USING ERRCODE='22023'; END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' THEN RAISE EXCEPTION 'lines must be an array' USING ERRCODE='22023'; END IF;
  SELECT * INTO p FROM commerce_payments x WHERE x.id=p_payment AND x.district_id=d FOR UPDATE;
  IF p.id IS NULL THEN RAISE EXCEPTION 'payment not found' USING ERRCODE='P0002'; END IF;
  IF p_kind='settlement' AND NOT (p.status='succeeded' AND p.payer_user_id=u) THEN
    RAISE EXCEPTION 'only the payer settles a succeeded payment' USING ERRCODE='42501';
  END IF;
  IF p_kind='refund' AND NOT (p.status='refunded' AND (r='superintendent' OR (r='principal' AND p.school_id IS NOT NULL AND p.school_id=eduos_ctx_school()))) THEN
    RAISE EXCEPTION 'only a school leader records a refund' USING ERRCODE='42501';
  END IF;
  -- The EDAL entry must be this caller's, of the matching kind, about no
  -- student, and its payload (hash-checked) must name this payment and carry
  -- exactly these lines.
  SELECT * INTO e FROM edal_entries x WHERE x.id=p_edal_entry AND x.district_id=d;
  SELECT x.payload INTO payload FROM edal_payloads x WHERE x.entry_id=p_edal_entry AND x.district_id=d;
  IF e.id IS NULL OR payload IS NULL OR e.kind <> 'commerce_'||p_kind OR e.recorded_by<>u OR e.subject_student_id IS NOT NULL
     OR e.school_id IS DISTINCT FROM p.school_id
     OR encode(sha256(convert_to(payload, 'UTF8')), 'hex') <> e.payload_hash
     OR (payload::jsonb->>'paymentId') IS DISTINCT FROM p.id::text OR (payload::jsonb->'lines') IS DISTINCT FROM p_lines THEN
    RAISE EXCEPTION 'EDAL entry does not match this payment' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM commerce_ledger_entries x WHERE x.payment_id=p.id AND x.entry_kind=p_kind) THEN
    RAISE EXCEPTION 'already recorded' USING ERRCODE='23505';
  END IF;
  SELECT count(*), count(DISTINCT c.line) INTO n, nd
    FROM jsonb_to_recordset(p_lines) AS c(line text, recipient text, amount bigint, "recipientId" uuid);
  IF n = 0 OR n <> nd THEN RAISE EXCEPTION 'each line exactly once' USING ERRCODE='23514'; END IF;
  IF p_kind='settlement' THEN
    SELECT c.amount INTO gross FROM jsonb_to_recordset(p_lines) AS c(line text, amount bigint) WHERE c.line='gross';
    SELECT coalesce(sum(c.amount), 0) INTO rest FROM jsonb_to_recordset(p_lines) AS c(line text, amount bigint) WHERE c.line<>'gross';
    IF gross IS DISTINCT FROM p.amount_cents::bigint OR rest <> gross
       OR EXISTS(SELECT 1 FROM jsonb_to_recordset(p_lines) AS c(amount bigint) WHERE c.amount IS NULL OR c.amount < 0)
       OR coalesce((SELECT c.amount FROM jsonb_to_recordset(p_lines) AS c(line text, amount bigint) WHERE c.line='processing_fee'), 0) <> p.processing_fee_cents THEN
      RAISE EXCEPTION 'settlement lines do not balance' USING ERRCODE='23514';
    END IF;
  ELSE
    -- A refund is exactly the negation of the settlement, line for line.
    IF (SELECT count(*) FROM commerce_ledger_entries x WHERE x.payment_id=p.id AND x.entry_kind='settlement') <> n
       OR EXISTS(SELECT 1 FROM jsonb_to_recordset(p_lines) AS c(line text, recipient text, amount bigint, "recipientId" uuid)
                 LEFT JOIN commerce_ledger_entries s ON s.payment_id=p.id AND s.entry_kind='settlement' AND s.line=c.line
                 WHERE s.id IS NULL OR c.amount IS DISTINCT FROM -s.amount_cents OR c.recipient IS DISTINCT FROM s.recipient
                    OR c."recipientId" IS DISTINCT FROM s.recipient_id) THEN
      RAISE EXCEPTION 'refund lines must reverse the settlement' USING ERRCODE='23514';
    END IF;
  END IF;
  INSERT INTO commerce_ledger_entries(district_id,payment_id,school_id,entry_kind,line,recipient,recipient_id,amount_cents,edal_entry_id)
    SELECT d, p.id, p.school_id, p_kind, c.line, c.recipient, c."recipientId", c.amount, e.id
      FROM jsonb_to_recordset(p_lines) AS c(line text, recipient text, amount bigint, "recipientId" uuid);
  num := 'R-' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD') || '-' || upper(substr(encode(sha256(convert_to(p.id::text||p_kind, 'UTF8')), 'hex'), 1, 10));
  INSERT INTO commerce_receipts(district_id,payment_id,school_id,kind,receipt_number,payer_user_id,amount_cents,currency,description,lines,edal_entry_id)
    VALUES(d, p.id, p.school_id, CASE p_kind WHEN 'settlement' THEN 'payment' ELSE 'refund' END, num, p.payer_user_id,
           CASE p_kind WHEN 'settlement' THEN p.amount_cents ELSE -p.amount_cents END, p.currency, left(coalesce(nullif(btrim(p_description), ''), 'EduOS purchase'), 300), p_lines, e.id)
    RETURNING id INTO rid;
  RETURN QUERY SELECT rid, num;
END; $$;

-- 9. Holds. An unpaid order holds its seats for hold_minutes; anyone in the
--    district may release holds that have expired (checkout calls it first,
--    retention calls it daily). Returns how many orders were released.
CREATE FUNCTION eduos_commerce_expire_holds() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); o record; n int := 0;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  FOR o IN SELECT id, ticket_type_id, quantity FROM event_ticket_orders
            WHERE district_id=d AND status='payment_pending' AND hold_expires_at < now() ORDER BY id FOR UPDATE SKIP LOCKED LOOP
    UPDATE event_ticket_orders SET status='cancelled' WHERE id=o.id;
    UPDATE event_ticket_types SET sold_count=greatest(sold_count-o.quantity, 0) WHERE id=o.ticket_type_id AND district_id=d;
    UPDATE commerce_payments SET status='expired' WHERE ticket_order_id=o.id AND status='requires_confirmation';
    n := n + 1;
  END LOOP;
  UPDATE marketplace_purchases m SET status='cancelled' FROM commerce_payments p
   WHERE m.district_id=d AND m.status='payment_pending' AND p.marketplace_purchase_id=m.id AND p.status IN ('declined','expired');
  RETURN n;
END; $$;
CREATE FUNCTION eduos_retention_feature_commerce(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); prev text := current_setting('app.school_id', true); s uuid; n int := 0;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  -- Financial records (payments, ledger, receipts) are kept: they hold no
  -- student data and districts must keep them for audit. Only stale holds
  -- go. Ticket tables are school-scoped (056), so release school by school.
  FOR s IN SELECT id FROM schools WHERE district_id=d ORDER BY id LOOP
    PERFORM set_config('app.school_id', s::text, true);
    n := n + eduos_commerce_expire_holds();
  END LOOP;
  PERFORM set_config('app.school_id', coalesce(prev, ''), true);
  RETURN jsonb_build_object('commerce_holds_released', n);
END; $$;
REVOKE ALL ON FUNCTION eduos_commerce_record(uuid, text, uuid, jsonb, text), eduos_commerce_expire_holds(),
  eduos_retention_feature_commerce(jsonb), eduos_ticket_order_guard(), eduos_ticket_guard(),
  eduos_marketplace_purchase_guard(), eduos_commerce_payment_guard() FROM PUBLIC;

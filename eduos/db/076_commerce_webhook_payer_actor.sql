-- EduOS 37.8.0: preserve the authenticated purchaser context independently
-- of pending_actor, which is intentionally cleared when checkout creation ends.
-- The webhook worker may use this snapshot only to run the existing payer-only
-- settlement path; it must still re-check the payment and order under tenant RLS.
ALTER TABLE commerce_payments
  ADD COLUMN payer_actor jsonb;

ALTER TABLE commerce_payments
  ADD CONSTRAINT commerce_payments_payer_actor_shape CHECK (
    payer_actor IS NULL OR (
      jsonb_typeof(payer_actor) = 'object'
      AND payer_actor ? 'userId'
      AND payer_actor ? 'role'
      AND (payer_actor->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND payer_actor->>'role' IN ('parent','pupil','teacher','principal','superintendent','district_it','staff','bus_driver','librarian','coach','school_nurse','sro')
      AND (NOT (payer_actor ? 'schoolId') OR payer_actor->>'schoolId' IS NULL
           OR (payer_actor->>'schoolId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    )
  );

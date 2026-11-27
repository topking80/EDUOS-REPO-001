-- FED-07: jurisdiction rules on exchange agreements. When the producing
-- district's rules require it, its approval records the consent or
-- authorization the exchange relies on.
SET search_path = master_control, pg_temp;

ALTER TABLE exchange_agreements
  ADD COLUMN consent_reference text CHECK (consent_reference IS NULL OR length(btrim(consent_reference)) BETWEEN 3 AND 200);

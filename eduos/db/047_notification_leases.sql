-- Notification dispatch leases (2026-11-16 audit). The dispatcher used to keep
-- a transaction open, holding the row lock, while it waited on the channel
-- adapter. Fine for the dry-run adapters; a real email/SMS/push sender that
-- answers slowly would tie up database connections and locks. Now it claims
-- a batch with a lease (committed at once), sends with no transaction open,
-- and settles each row in a short transaction that only succeeds while it
-- still holds the lease. A lease that runs out (a crashed dispatcher) is
-- simply claimable again.
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS lease_token uuid;
ALTER TABLE notification_outbox ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

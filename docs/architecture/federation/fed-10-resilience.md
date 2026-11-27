# FED-10 — Resilience: backup, restore, integrity checks and running without Master Control

Status: built. This completes the federation track (FED-02 to FED-10).

Code:
- `eduos/src/master-control/integrity.js` and `verify.js` (`npm run mc:verify`);
- `eduos/src/master-control/after-restore.js` (`npm run mc:after-restore`);
- migration `eduos/db/master-control/007_restore_events.sql`;
- the bundle version rule in `eduos/src/master-control/app.js`.

Tests: the FED-10 cases in `eduos/test/integration/master-control.test.js`. They take a real `pg_dump` of the `master_control` schema, restore it into a new database, and compare the two integrity reports.

## What keeps working when Master Control is down

Master Control isn't in any district's request path. While it's down:
- Every EduOS keeps running. It keeps following the policy bundles it already holds (FED-05, FED-07).
- Retention minimums and legal holds still apply.
- Districts keep signing in to EduOS. Identity federation (FED-04) is only for signing in to Master Control.
- Already-built exchange report files can be delivered once it's back.

What waits:
- new policy releases and answers to them;
- exchange agreements, terms, deliveries and reads;
- incidents, and the key registry.

The FED-09 alert `MasterControlScrapeUnavailable` fires.

## Backing up

Master Control lives in its own `master_control` schema. Back it up with a role that can read every table: a superuser, or a role with `BYPASSRLS` and `SELECT` on the schema, as for EduOS (`eduos/docs/MIGRATIONS.md`):

```sh
pg_dump -Fc -n master_control -f mc-$(date -u +%Y%m%dT%H%MZ).dump "<backup-role URL>"
```

- Take one at least daily, and before every upgrade. Keep the same retention as EduOS's backups.
- The dump holds no student data, but it does hold:
  - the authority model;
  - the audit log;
  - signed bundles and exchange aggregates;
  - public keys.

  Store it encrypted.
- The signing secret (`MC_POLICY_SIGNING_SECRET`) isn't in the database. Keep it in the secret manager, with its own backup.

## Restoring

1. Stop Master Control.
2. Restore into an empty database, or after dropping the schema: `pg_restore --exit-on-error -d "<URL>" mc-....dump`. Then run `npm run mc:migrate` so newer migrations and the `mc_app` grants are applied.
3. **Check it:** `MC_DATABASE_URL=... MC_POLICY_SIGNING_SECRET=... npm run mc:verify`. It prints a JSON report and exits 1 if anything is wrong. It checks:
   - the audit hash chain (FED-03);
   - the authority model, against the FED-02 rules;
   - every district's chain of policy bundles: the signature against the key registry, the stored hash, each bundle pointing at the one before, and versions going up by one, apart from jumps after a recorded restore;
   - every exchange delivery's stored hash against its contents.
4. **Record the restore** before Master Control serves anyone:

   ```sh
   npm run mc:after-restore -- --note "Restored from 02:00 backup after disk failure" --backup-taken-at 2026-11-26T02:00:00Z
   ```

   Bundles issued after the backup are gone from Master Control, but districts may already hold them. EduOS refuses a version it has already passed, so the next bundle for every district jumps ahead by `--skip` versions (default 1000). The restore is appended to the audit log.
5. Start Master Control.
6. Re-issue the current policies, as a release from each state, so every district gets a bundle that reflects the restored state. EduOS flags a gap in the chain (the lost versions) and accepts the bundle.
7. Re-do anything recorded after the backup. The audit log of the failed instance, if it survives, shows what. This can include incidents, key revocations, agreement approvals and deliveries. Revoke again any key that was revoked after the backup.

A district's EduOS restored from an older backup also loses bundles. Its superintendent uploads the newest bundle file again, from Master Control's bundle list. Versions only go up, so the newest file is accepted.

## Recovery targets

These are suggested starting points; set them in the deployment's own plan.
- **Data loss (RPO):** up to one backup interval of Master Control changes. Districts lose nothing of their own.
- **Recovery time (RTO):** a few hours is tolerable for most deployments, since districts aren't blocked meanwhile.

Practise the restore (steps 2–4) on a copy each term. `mc:verify` should report exactly what it reports on the live database.

## Not in this slice

- Streaming replication or automatic failover for Master Control.
- Automatic backups: scheduling is the deployment's.
- Exporting the audit log to separate write-once storage.

# Database migrations, backup, rollback and recovery

## Inventory

Numbered `db/NNN_*.sql` migration files are discovered and applied in
lexicographic order by `src/db.js` and `src/migrate.js`. Each one is recorded
in `schema_migrations` once applied. The API refuses to start if any discovered
migration is missing from that table. After the migrations, `src/migrate.js`
re-applies the runtime role's grants (`db/runtime_grants.template.sql`) on
every run.

## Roles

| Role | Used for | Must be |
|---|---|---|
| Owner (`DATABASE_URL` when migrating) | `npm run db:migrate`, notification dispatch, retention | Owns the tables; not a superuser |
| Runtime (`EDUOS_APP_ROLE`, the API's `DATABASE_URL`) | The API | Not a superuser, no `BYPASSRLS`, owns nothing |
| Backup | `pg_dump` | A superuser or a role with `BYPASSRLS` |

The owner can't take backups. Most tables have forced row-level security,
and `pg_dump` stops at the first one ("query would be affected by
row-level security policy"). `test/integration/backup-restore.test.js` pins
this.

## Upgrading

1. Take a backup with the backup role and keep it until the new version has
   run for a while:
   `pg_dump -Fc -f eduos-before-<version>.dump "<backup-role URL>/eduos"`
2. Stop the API, or put it in maintenance mode.
3. Run `npm run db:migrate` with the owner's URL and `EDUOS_APP_ROLE` set.
   Each migration runs in its own transaction. If one fails, that migration
   is rolled back completely, the run stops, and the API won't start on the
   new version (a migration is missing). Fix the cause and run it again; the
   migrations that already succeeded are skipped.
4. Start the new version of the API.

`test/integration/upgrade-path.test.js` upgrades a populated database from
an older release this way and checks the result.

## Rolling back

Migrations only go forward; there are no down migrations. To undo an
upgrade, restore the backup from step 1 and run the previous version:

```bash
createdb -O <owner> eduos_restored
pg_restore --exit-on-error --no-owner --role <owner> -d "<superuser URL>/eduos_restored" eduos-before-<version>.dump
DATABASE_URL="<owner URL>/eduos_restored" EDUOS_APP_ROLE=<runtime role> npm run db:migrate   # re-applies grants; nothing else to do
```

Then point the previous API version's `DATABASE_URL` (runtime role) at
`eduos_restored`, or rename the databases. Anything written after the backup
is lost, so restore only if the new version can't be fixed forward.

`--exit-on-error` makes any failed statement stop the restore, so you never
run on a partial copy. `test/integration/backup-restore.test.js` runs this
procedure on every CI run: it backs up a populated database, restores it into
a new one, re-applies grants, and checks that the API serves it as the
runtime role with districts still isolated.

## Writing migrations

- **Changing existing rows:** migrations run as the owner with no district
  set, and most tenant policies have no owner exception. A plain `UPDATE`,
  `DELETE` or `INSERT ... SELECT` over a tenant table silently matches
  nothing. Loop over the districts in a `DO` block and set `app.district_id`
  for each one (see `db/049_rls_backfill_repair.sql`). Then add a row to
  `upgrade-path.test.js` that the migration must change.
- **Functions used by generated columns, indexes, defaults or constraints:**
  name the schema of everything they call (`public.eduos_redact_tokens(...)`).
  `pg_restore` runs with an empty `search_path` (see
  `db/050_restore_safe_generated_columns.sql`).
- **New functions** start with no EXECUTE for anyone: the grants template
  revokes PUBLIC on every run. Grant the runtime role only what it calls,
  including any helper a row-level security policy calls.
  `upgrade-path.test.js` fails if a policy helper isn't executable by the
  runtime role, or if any EduOS function is executable by PUBLIC.

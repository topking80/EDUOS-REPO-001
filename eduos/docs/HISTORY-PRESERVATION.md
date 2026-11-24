# Preserving student history (TC-08)

Student history photos live in the district's private S3-compatible bucket
(see `MEDIA-STORAGE.md`). TC-08 makes sure they stay intact, cost less to
keep as they age, and can't be deleted while a legal matter needs them.
`db/132_history_preservation.sql`, `src/history-preservation.js`,
`src/history-preservation-routes.js`.

## What the district sets (superintendent, Student history → Preservation)

| Setting | Default | Meaning |
|---|---|---|
| Check every | 90 days (7–365) | How often each photo is read back and compared with its checksum |
| Move to archive storage after | never (30–3650 days) | Photos older than this move to `HISTORY_ARCHIVE_STORAGE_CLASS` |
| Flag students over | 80 % (50–99) | Capacity report counts students past this share of their limit |
| Records retention schedule | — | The board policy / state schedule this district follows (reference only) |

The per-student limits themselves stay in the media policy (MEDIA-01).
**Donations never change any limit, schedule or priority here**; the API
says so (`donationsAffectLimits: false`) and nothing reads donation data.

## Integrity

* When a photo is stored, its SHA-256 is recorded (`private_media_objects.sha256`).
  Photos stored before 37.8.0 get their checksum on their first check.
* `npm run history:preserve` (cron, nightly is plenty; or
  `HISTORY_PRESERVE_INTERVAL_SECONDS` to run it inside the API) reads each
  photo that is due and compares. A changed or missing object is marked
  `mismatch` / `missing`, logged, and every superintendent gets an in-app
  notice. The next check that finds it intact again logs `recovered`.
* A storage outage is not treated as a lost photo: the job counts it as an
  error and tries again next run. Exit code 2 means storage isn't configured.

## Archive storage

Set `HISTORY_ARCHIVE_STORAGE_CLASS` to `STANDARD_IA`, `GLACIER_IR` or
`ONEZONE_IA` (AWS names; MinIO and most S3-compatible stores accept
`STANDARD_IA`). Only classes that read instantly are allowed, so photo links
keep working with no restore step. The move is an in-place server-side copy
(same key, same bucket permissions), and the copy is read back and must match
the checksum before the photo is recorded as archived. The job never deletes,
re-compresses or transcodes anything.

## Legal holds

* The school's principal or vice principal, or the superintendent, puts a
  hold on a student (reason, optional matter/case number). Only the
  superintendent lifts it, with a note. Both are audited and logged.
* While a hold is on:
  * history items can't be withdrawn for deletion or deleted (database trigger);
  * photos aren't released from storage: a rejected contribution or a
    cancelled capsule keeps its photos in the bucket (`kept_for_hold`);
  * Time Capsules don't open (the release sweep reports `held`, logged once a
    day, and retries; confirming a milestone answers `legal_hold_active`).
* Holds don't grant anyone access; they only stop removal and release.

## Capacity reporting

`GET /api/history/preservation` gives the records office, per school:
students with photos, bytes used, bytes in archive, students over the alert
share, students who can't add another full-size photo, check results and
active holds. Counts only: no student names, no storage keys. Principals and
vice principals see their own school; the superintendent sees all.

## Restore drill (do this once a term, and after any storage change)

The database holds checksums; the bucket holds the photos. Both need backups.

1. **Bucket protection** (district IT, once): turn on bucket **versioning**,
   and either cross-region replication or a nightly copy to a second bucket
   or provider. Keep object-lock / retention on the replica if the district's
   records policy requires it.
2. **Pick a sample**: in a staging copy of the database,
   `SELECT asset_id, storage_key, sha256 FROM private_media_objects WHERE purpose='history' ORDER BY random() LIMIT 20;`
3. **Restore** those objects from the replica (or a previous version) into a
   scratch bucket, e.g. `aws s3api get-object --bucket <replica> --key <storage_key> /tmp/x`.
4. **Verify**: `sha256sum /tmp/x` must equal the recorded `sha256` for every sample.
5. **Full path**: point a staging EduOS at the restored database and bucket,
   run `npm run history:preserve` with `HISTORY_PRESERVE_LIMIT` high enough
   to cover the sample (after setting their `verified_at` to NULL), and
   confirm `mismatch` and `missing` are 0.
6. Record the date, sample size and result in the district's continuity log.

To recover a single flagged photo in production: restore the previous object
version over the same key; the next check marks it `recovered`.

## Not in TC-08 (yet)

* Deleting history at the end of its retention period. Nothing is deleted
  automatically. A retention review workflow (with notice and a second
  approver) needs the district's records schedule decisions first.
* Video, audio and documents (only photos are stored today).

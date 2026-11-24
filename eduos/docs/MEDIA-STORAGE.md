# Photos in Student History: storage and malware scanning (MEDIA-01)

Photos on student history items are stored in a **private S3-compatible
bucket** and **scanned by ClamAV** before anyone can see them. Photos stay off
until both are configured and the superintendent turns them on (Student
history → Photos in student history).

## What happens to a photo

1. A teacher (or the school's leader) adds a photo to an item that isn't
   published yet, with a description (alt text, required) and an optional
   caption. The browser sends it to EduOS, not to the bucket.
2. EduOS checks the district's limits: photos on, size per photo, photos per
   item, total per student. Failed or blocked photos don't count.
3. ClamAV scans the upload. Anything other than a clean answer, including
   ClamAV being unreachable, refuses the photo (fails closed).
4. The image is decoded as the type it claims (JPEG, PNG or WebP; a mismatch is
   refused), turned upright, fitted inside 2400 px and re-encoded from its
   pixels. That drops EXIF (camera, time, **GPS location**), XMP, comments,
   thumbnails and trailing data.
5. ClamAV scans the processed photo. Only that processed file is written to the
   bucket. The original is never stored.
6. The photo appears with the item, to exactly the people who can see the item,
   once it is published. Each view goes through EduOS, which checks the viewer
   and redirects to a **60-second** presigned link (`Cache-Control: no-store`,
   `Referrer-Policy: no-referrer`). Storage keys never reach a browser.

Downloads of a student's history (TC-05 export) list each photo's description
and caption; the image files aren't included.

## Family photos (MEDIA-02)

A guardian adds photos to a family memory they've sent for review, through
exactly the same checks. Only that guardian (while it's pending, and while no
custody restriction applies) can add them; the guardian and the school's
reviewer (principal, vice principal, superintendent) can see them while it's
pending. Approval puts the photos on the published family memory, where
exactly the people who can see that memory see them. If the memory is
withdrawn or rejected, its photos stop counting toward the student's total and
are deleted from the bucket.

## Time Capsule photos (MEDIA-03)

A capsule's owner adds their own photos to it while it's a draft, beside the
message, through the same checks; photos already on the history items placed
in the capsule come along with them. The owner sees them while drafting.
Recipients see nothing, not even that photos exist, until the capsule is
released to them, exactly like the rest of its contents; withheld items keep
their photos withheld. Sealing stops changes. Cancelling a capsule deletes the
owner's own photos from the bucket (photos that belong to history items stay
with those items). Capsule photos count toward the student's total.

## Setting it up

### Bucket

Any S3-compatible service: AWS S3, Cloudflare R2, Backblaze B2, Wasabi or
MinIO. Create a bucket that is **private** (block all public access; no public
policy; no website hosting) and, where offered, turn on default encryption and
versioning. No CORS rules are needed: browsers never write to the bucket.

Create credentials that can only `PutObject`, `GetObject` and `DeleteObject`
on that bucket (no listing, no other buckets). Then set on the API:

| Setting | Example |
| --- | --- |
| `MEDIA_S3_ENDPOINT` | `https://s3.us-east-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `https://s3.us-west-004.backblazeb2.com`, `https://minio.district.internal` (must be https) |
| `MEDIA_S3_REGION` | `us-east-1` (R2: `auto`) |
| `MEDIA_S3_BUCKET` | `district-eduos-media` |
| `MEDIA_S3_PATH_STYLE` | `true` for MinIO and R2; leave unset for AWS |
| `MEDIA_S3_ACCESS_KEY_ID`, `MEDIA_S3_SECRET_ACCESS_KEY` | the credentials above (keep them in the secrets store, never in the repository) |
| `HISTORY_ARCHIVE_STORAGE_CLASS` | optional (TC-08): `STANDARD_IA`, `GLACIER_IR` or `ONEZONE_IA`; old history photos move there in place. See `HISTORY-PRESERVATION.md` |
| `HISTORY_PRESERVE_INTERVAL_SECONDS` | optional (TC-08): run the integrity check inside the API every N seconds (default 0: use `npm run history:preserve` from cron) |

### ClamAV

Run `clamd` where the API can reach it on TCP and where `freshclam` can update
its signatures. For example, alongside the compose stack:

```yaml
  clamav:
    image: clamav/clamav:stable   # pin by digest in production
    networks: [scan]
    restart: unless-stopped
```

with the `app` service also on the `scan` network (which needs outbound access
for signature updates; the database network stays internal). Then set:

| Setting | Example |
| --- | --- |
| `CLAMAV_HOST` | `clamav` |
| `CLAMAV_PORT` | `3310` |

`clamd`'s default `StreamMaxLength` (25 MB) is above the largest photo EduOS
accepts (20 MB).

### Turning photos on

The superintendent sets, under Student history → Photos in student history:
photos on or off, largest photo (default 10 MB, up to 20 MB), photos per item
(default 6), and total per student (default 250 MB, up to 5 GB). These limits
are the district's alone.

## Not yet

* **Video.** Needs a transcoding step that sanitizes the file the way
  re-encoding does for photos.
* **Deleting** a photo after publication follows the district's records rules
  (TC-08 retention work).

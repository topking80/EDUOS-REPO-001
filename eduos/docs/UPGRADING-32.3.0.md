# Upgrading to EduOS 32.3.0

32.3.0 adds school branding: mascots, school colors and icon displays, with a
WCAG AA publish gate. It has **one new migration**
(`db/011_school_branding.sql`), new runtime grants, a new npm dependency
(`sharp`, for image processing) and two optional environment variables.
The Caddyfile is unchanged; the new public endpoints are under `/api/*`.

## Docker Compose deployments
```sh
git pull   # or unpack the release
docker compose --profile edge up -d --build   # migrate applies 011 and the new grants
```
The image build runs `npm ci`, which installs sharp's prebuilt libvips for
Alpine (linuxmusl-x64). No system packages are needed.

## Non-compose deployments
1. Deploy the code and run `npm ci`. sharp ships prebuilt binaries for Linux
   (glibc and musl, x64 and arm64), macOS and Windows. On other platforms see
   the sharp install documentation.
2. Run `npm run db:migrate` as the **owner** role. Migration 011:
   - creates `branding_uploads`, `branding_assets`, `branding_profiles` and
     `user_preferences` with RLS and FORCE;
   - adds `eduos_can_edit_branding()` and `eduos_in_branding_scope()`.

   The grants make uploads and assets insert-only for the runtime role. Only
   draft profiles can be deleted.
3. Restart the API.

## What changed for operators

| Area | Change | Action |
|---|---|---|
| New tab "School branding" | Principals edit their own school. Superintendents and IT admins edit any school and the district default. Drafts stay private until published. | Tell principals the tab exists. Optionally publish a district default first. |
| Uploads | PNG, JPG, WebP or SVG, up to `BRANDING_UPLOAD_MAX_KB` (default 2048). Rasters are re-encoded (metadata stripped) and SVGs are sanitized. Only processed PNG/SVG output is stored, in the database (≤ 1 MB per variant). | Optional: lower the limit. |
| Publishing | Refused with `422 contrast_failed` if any text color fails WCAG AA (4.5:1). Icon contrast below 3:1 is a warning. | None |
| Public endpoints | `/api/public/branding/<districtId>/<schoolId>`, `/icon-N.png` and `/manifest.webmanifest` expose a school's **published** name, mascot and colors, with no sign-in, for the sign-in page, favicon and PWA manifest. They are rate-limited by `PUBLIC_BRANDING_RATE_LIMIT_PER_MIN` (default 300 per IP). | If a school's name or mascot must not be public, don't publish branding for it. Unknown ids return 404. |
| Sign-in page per school | Share `https://<host>/?school=<districtId>.<schoolId>` (for example on the school website) to get a branded sign-in page. | Optional |
| Webhooks | New event type `branding.published` (ids only). | Subscribe if you mirror branding elsewhere. |
| Audit | New `resource_type = 'branding'` entries, and `preferences.update`. | None |
| User preference | **High contrast** button for every signed-in user, saved per account. | None |
| `/health` | Returns version `32.3.0`. | None |

## Local evaluation
`make up` seeds branding for the demo district: a default, Riverside
Elementary (Otters) and Lincoln Middle (Lynx). The mascots are original
drawings. Seeding is idempotent: it adds branding only where a school has
none. `make smoke` and `make smoke-browser` exercise the designer, the AA
block, publishing and the branded views. Both restore the seeded design
afterwards.

## Rollback
Migration 011 is additive. 32.2.0 ignores the new tables. Rolling back to
32.2.0 was **not tested**. Restore from the backup you took before migrating.

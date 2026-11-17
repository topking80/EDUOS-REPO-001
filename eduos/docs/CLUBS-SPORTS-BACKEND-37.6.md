# Clubs & Sports backend foundation (37.6.0)

## Included
- Clubs and sports share a typed activity model; school leaders create and assign club advisors / team coaches. Teachers manage only activities explicitly assigned to them.
- Learners can join published activities when linked school and grade eligibility permits.
- Assigned advisors/coaches create event drafts. Only principals or superintendents publish and configure ticket inventory or stream schedules.
- Ticket capacity is reserved transactionally. Complimentary tickets use idempotency keys and opaque one-time ticket codes; only SHA-256 ticket-code hashes are stored.
- Paid ticket checkout returns `paid_ticketing_not_configured`; no card data or payment is collected.
- Stream schedules are metadata only. No provider, playback URL, upload, recording or livestream is connected. Recording is off by default.
- Writes run in tenant transactions and emit audit events. PostgreSQL RLS enforces district isolation; route checks enforce school and staff-assignment scope.

## API
- `GET /api/activities`, `POST /api/activities`, `PATCH /api/activities/:id`
- `POST /api/activities/:id/staff`, `POST /api/activities/:id/join`
- `GET /api/events`, `POST /api/activities/:id/events`
- `POST /api/events/:id/ticket-types`, `POST /api/events/:id/tickets`
- `POST /api/events/:id/stream`, `GET /api/events/:id/stream`

All writes require session authentication and CSRF. Responses are no-store.

## Sports roster and results (37.7.0)\n- Coaches and advisors assigned to a sport activity can add roster entries only for students with active activity membership and within the team grade range. Jersey numbers are unique among active roster entries for a team.\n- Only assigned staff and school/district leads can view a roster; roster names and grades are not exposed through the public activity results endpoint.\n- Assigned staff can record results only after the event end time. Results remain drafts until a principal or superintendent explicitly publishes them.\n- API: `GET/POST /api/activities/:id/roster`, `GET /api/activities/:id/results`, `POST /api/events/:id/result`.\n\n## Apply
From `eduos/`: `npm run db:migrate` (migrations 051 and 052), then `npm test`. Run the PostgreSQL integration suite with the configured test database.

## Production blockers
Before paid sales: configure district-approved hosted checkout, signature-verified webhooks, idempotent payment transitions, refunds/chargebacks and settlement reconciliation. Before live video: configure approved provider, short-lived audience-bound playback authorization, captions, recording consent and replay retention. Before uploads: private object storage, MIME sniffing/re-encoding, malware scanning, EXIF stripping, consent, moderation and retention. Add QR check-in and guardian/student participant consent workflows.


## Media consent and moderation (37.8.0)
- Assigned club/team staff register students appearing in an existing media asset; each participant begins with pending consent.
- A parent/guardian may grant or deny consent only for a student connected to their active guardian account and already registered in that asset. Consent is stored per student, asset and guardian, with district RLS.
- A principal/superintendent may approve moderation only after every registered participant has approved guardian consent.
- APIs: `GET /api/activities/:id/media`, `POST /api/media/:id/participants`, `POST /api/media/:id/consent`, `PATCH /api/media/:id/moderation`.
- Responses omit storage keys. No upload endpoint, public URL, signed URL, playback, or publication is enabled. A district-approved private object-storage adapter, content scanning/re-encoding, EXIF stripping, retention policy and authenticated delivery are required before media can be uploaded or viewed.


## Private media pipeline contract (37.9.0)
- Added a provider-neutral adapter contract for private object storage, authenticated object metadata checks, malware scanning, image re-encoding and short-lived private read URLs.
- Upload intent validation allowlists JPEG/PNG/WebP and MP4/WebM/QuickTime with 20 MiB image and 50 MiB video caps. SVG and caller-selected storage keys are rejected.
- The pipeline requires storage, scanning and image-processing adapters; it is disabled by default and returns `private_media_pipeline_not_configured` when adapters are absent. No upload endpoint or public URL is enabled by this change.
- Delivery requires all three states: guardian consent approved, moderation approved and security scan clean. Read URLs are capped at 60 seconds.
- Video processing is explicitly blocked until a video transcode/sanitization adapter is implemented.

## Server-side storage-key boundary (37.9.1)
- The media pipeline now returns only the asset ID, one-use upload URL and expiry to its caller. It never returns the private object-storage key or processed-object key.
- Follow-up verification and read-URL operations accept the asset ID plus district/school scope; the pipeline resolves the private key internally and rejects cross-tenant references.
- Read-URL creation additionally requires successful malware scanning and image processing, as well as approved guardian consent and moderation. The returned read URL and expiry are the only storage-delivery fields exposed.
- The current private key registry is process-local and intentionally fails closed after restart. It is a security boundary for the adapter contract, not a durable production registry. Before enabling uploads in production or across multiple app instances, replace it with a durable, tenant-scoped server-side asset registry (for example, a protected database table with forced RLS), and add authenticated upload/verification routes that never serialize storage keys.
- Do not log adapter responses, storage keys, signed URLs or upload URLs. Keep provider credentials in server-only secret configuration.

 
## Media delivery security hardening (37.9.2)
- Image processor output is rejected unless it returns an allowlisted JPEG/PNG/WebP MIME type, a positive size no greater than 20 MiB, and explicit `metadataStripped: true` and `reencoded: true` attestations. The processor receives the allowlist, output-size cap and sanitization requirements.
- Upload URLs must use HTTPS and expire in the future within five minutes. Read URLs must use HTTPS and expire in the future within the 60-second delivery limit.
- Read-URL creation no longer accepts caller-supplied consent or moderation statuses. A configured authorization adapter must execute the PostgreSQL-backed `createPostgresMediaAuthorization` gate, which locks the asset, every participant row and every guardian decision, checks all participants and denials/withdrawals, and mints the signed URL before the tenant transaction releases its locks.
- The database authorization adapter restricts delivery to principals/superintendents in scope and assigned activity teachers. The pipeline remains disabled unless storage, scanning, image processing and authorization adapters are all configured.
- These changes harden the provider contract; no production storage, scanner or image processor is connected, and the API does not expose upload or delivery routes. The process-local storage-key registry remains a production blocker until replaced by a durable tenant-scoped registry.

 
## Durable private media registry (37.9.3)
- Replaced the process-local storage-key map with `private_media_objects`, a PostgreSQL registry keyed by media asset ID and scoped by district and school. It is protected by forced district RLS.
- Migration `054_private_media_object_registry.sql` is registered in `src/migrate.js`; the runtime role receives only SELECT/INSERT/UPDATE, with DELETE/TRUNCATE revoked.
- The pipeline now requires a registry adapter and authenticated tenant actor for upload-intent persistence, object verification and delivery. Storage keys remain server-side and are not included in public pipeline results.
- This removes the restart/multi-instance loss caused by the in-memory map. Production uploads remain disabled until the district-approved storage, scanner and image-processing adapters and authenticated upload routes are configured.

 
## Guardian consent withdrawal (37.10.0)
- The guardian consent endpoint accepts explicit `action: "grant" | "deny" | "withdraw"` (the existing `granted: boolean` request remains supported for grant/deny).
- Withdrawal is allowed only when that guardian has an existing approved decision. The prior consent row is changed to `withdrawn`, and an audit event records the withdrawal decision.
- A withdrawn decision blocks media delivery just like a denial; the asset consent state becomes withdrawn and the participant cannot be treated as approved.

 
## Stream schedule authorization (37.11.0)
- Stream schedule reads now allow only known school/district roles.
- District-audience schedules are restricted to district-level roles. Ticket-holder schedules require an active issued/checked-in ticket belonging to the authenticated buyer. School-audience schedules remain limited to the event's school scope.
- Playback remains disabled until an approved provider and short-lived audience-bound playback authorization are integrated.

 
## Idempotent ticket-code recovery (37.12.0)
- A retry by the authenticated original buyer replays the same order. For each still-issued ticket, the server generates a fresh random code, replaces the stored SHA-256 hash, and returns the new code once. Any previously issued but unredeemed code is invalidated.
- Checked-in, cancelled or refunded tickets do not receive a new code. Reusing an idempotency key for a different event is rejected.
- Parent retries revalidate the active guardian-to-school relationship before revealing replacement codes. Ticket codes are never stored in plaintext.

 
## Composite tenant/school integrity (37.13.0)
- Migration `055_clubs_sports_composite_scope_constraints.sql` adds composite foreign keys tying activities, events, ticket types/orders/tickets, streams, rosters, results and media participants/consents to the same district and school.
- The constraints supplement route-level checks and forced district RLS; mismatched school relationships now fail at the database boundary.

 
## Follow-up audit hardening
- Idempotent ticket retries now reject changes to the original event, ticket type, or quantity instead of silently replaying a different order.
- Composite scope migration 055 also binds roster entries, media participants, and guardian consent records to the student's school as well as the district.
- The cross-district media read test asserts the early tenant-scope rejection before registry access.

- Migration `056_clubs_sports_school_scope_rls.sql` tightens RLS from district-only to district plus active school context for club, event, ticket, roster, consent, and private-media tables. Superintendent and district IT roles retain cross-school access.
- The composite constraints also bind private object registry rows to their media asset and each guardian consent row to a registered media participant, preventing orphaned object metadata and unregistered-student consent records.
- The image pipeline now reads back the processed private object and independently verifies its actual MIME type and byte size, then malware-scans the processed output before marking it deliverable.

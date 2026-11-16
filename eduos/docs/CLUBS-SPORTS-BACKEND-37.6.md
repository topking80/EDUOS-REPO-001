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

## Apply
From `eduos/`: `npm run db:migrate`, then `npm test`. Run the PostgreSQL integration suite with the configured test database.

## Production blockers
Before paid sales: configure district-approved hosted checkout, signature-verified webhooks, idempotent payment transitions, refunds/chargebacks and settlement reconciliation. Before live video: configure approved provider, short-lived audience-bound playback authorization, captions, recording consent and replay retention. Before uploads: private object storage, MIME sniffing/re-encoding, malware scanning, EXIF stripping, consent, moderation and retention. Add QR check-in and guardian/student participant consent workflows.

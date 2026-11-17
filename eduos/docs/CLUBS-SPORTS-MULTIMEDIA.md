# Clubs & Sports Multimedia Hub

## Scope

The Clubs & Sports Hub is a shared extracurricular destination for learners and families, with publishing and oversight workflows for teachers serving as coaches or club advisors and for principals.

The web app has a role-aware Clubs & Sports destination for learners, families, teachers and principals, and the Flutter learner app has a native screen. Since 37.6.0 (#46 on the #47 backend) the web screen reads the live API: published clubs and teams, joining (learners), upcoming events, permission slips (guardians sign, learners see the status), sports eligibility (the team's coach and the athletic director only), slip management for activity staff, and naming athletic directors (principals). It does not provide purchases, media uploads or streaming.

## Product areas

- Clubs: profiles, advisor, eligibility, meeting calendar, interest/registration workflow, announcements and showcases.
- Sports: teams, coaches, rosters, practice and game schedules, results, standings and team updates.
- Multimedia: moderated photo galleries, video highlights, event recaps and school-approved livestream pages.
- Ticketing: event setup, ticket types, capacity, complimentary/paid tickets, order history, refunds and check-in/QR validation.
- Live streaming: scheduled event pages, provider-hosted live playback, captions, access controls, replay availability and moderation.

## Roles and access model

- Learners browse activities and see only activities available to their school and grade/eligibility rules.
- Guardians view linked learners' activities, event details and authorized ticket purchases.
- Teachers acting as coaches or club advisors manage only the teams/clubs assigned to them.
- Principals approve school publishing, events, media and ticketing; district administrators configure shared providers and policy.
- Media upload, publishing, payment administration, refunds and stream controls require distinct server-side permissions and audit events. A client-side role check is never an authorization boundary.

## Payments and ticketing requirements

Ticket checkout is intentionally not enabled in this preview. Before sales are activated, integrate a district-approved payment processor using hosted checkout or tokenized payment methods. EduOS must not store raw card numbers or security codes. Verify provider webhooks, make order creation idempotent, reconcile refunds and chargebacks, enforce event capacity transactionally, issue non-guessable ticket identifiers and support QR check-in without exposing student records. District finance settings must define tax, fees, refund rules and settlement ownership before launch.

## Live-streaming and media safeguards

Use an approved streaming provider rather than relaying video through the application server. Require an event owner, school approval, audience scope, scheduled start/end, moderation contact and accessibility checks. Provide captions and an accessible non-video event update path. Recordings are off by default; recording and replay require explicit school approval and appropriate participant/guardian permissions. Restrict embeds to allowlisted provider origins, protect private streams with short-lived access, and prevent public indexing of restricted events. Media uploads require type/size validation, malware scanning, metadata handling, moderation and retention rules before publication.

## Data and implementation boundary

The web UI is connected to the live clubs/sports APIs (see above). The backend foundation includes district- and school-scoped activity, event, ticket inventory, roster, result, stream-schedule and media-consent tables and APIs, forced RLS, composite scope constraints, staff-assignment checks, guardian consent history and moderation gates.

The following are still deliberately unavailable and must not be presented as live features:
- Paid ticket checkout, refunds, chargebacks and settlement. Paid orders fail closed with `paid_ticketing_not_configured`; complimentary tickets and check-in are implemented.
- Stream playback and recording. The backend stores schedules and audience metadata only; `playbackEnabled` remains false.
- Media upload and publication. The provider-neutral private pipeline is disabled unless storage, scanning, image-processing adapters and explicit upload/read hostname allowlists are configured. Video processing remains disabled. The current API does not expose a complete upload-to-publication workflow.
- The Flutter Clubs & Sports destination is currently learner-only; other roles continue through the role-specific app experience.
- Sports eligibility, athletic directors and guardian e-sign permission slips are live (db/060); see CLUBS-SPORTS-BACKEND-37.6.md. Eligibility is pass/fail by named district rule for the coach and athletic director only, computed on read and never stored.

Before production launch, configure approved storage/scanner/processor providers, add a complete upload workflow, integrate payment and streaming providers, and add real PostgreSQL/API authorization tests for tenant boundaries, consent changes, ticket recovery and stream audience access.

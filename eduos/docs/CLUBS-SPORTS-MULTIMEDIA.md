# Clubs & Sports Multimedia Hub

## Scope

The Clubs & Sports Hub is a shared extracurricular destination for learners and families, with publishing and oversight workflows for teachers serving as coaches or club advisors and for principals.

The first UI slice adds a role-aware destination to the learner, family, teacher and principal web-app navigation and exposes it in the Flutter learner app through its existing web fallback. The current screen is an explicitly labelled preview using sample activity and event data. It does not provide live enrollment, purchases, media uploads or streaming.

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

The initial UI is a navigation and experience preview only. No database schema, API route, payment processor, streaming provider, media storage, upload endpoint or ticket inventory was added. The next implementation phase must introduce tenant- and school-scoped tables and APIs, row-level security, audited staff assignment checks, moderation and consent workflows, payment-provider integration, streaming-provider integration and integration tests before presenting ticket purchases or live video as available.

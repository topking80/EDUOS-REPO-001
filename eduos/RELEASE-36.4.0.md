# EduOS 36.4.0 — Specialized School Operations Consoles

## New role workspaces
- Vice Principal: school operations queue, attendance/safety navigation and facilities escalation.
- Guidance Counselor: non-confidential counseling referral routing queue.
- Nurse: health-office operational task queue.
- Maintenance: facilities work-order queue.
- Lunch Staff: meal-service operations queue.

## Access model
Each role is school-scoped. Principals can provision these accounts at their own school; district IT and superintendents can provision across the district. Vice principals receive limited attendance, cases and safety permissions. Counselors receive cases workflow permissions. Nurses receive only health-office task permissions, not general student records. Maintenance and lunch staff receive only their service domains.

## Privacy guardrails
The health-office and counseling queues reject free-text details to avoid collecting diagnoses, treatment notes, or confidential counseling narratives in this operational queue. These consoles are not an electronic health record or a replacement for the district's approved student-support case management system. No sensitive student data is surfaced in the generic queue.

## API
- `GET /api/school-operations/:domain`
- `POST /api/school-operations/:domain`
- `POST /api/school-operations/:domain/:id/status`

Domains: facilities, health_office, counseling, meal_service.

## Deployment
Apply migration `027_school_operations_consoles.sql` and refresh runtime grants by running the standard migration/grant process. Deploy the application and refresh client assets.

## Verification
Focused static contract tests and JavaScript syntax checks are included. Live PostgreSQL/RLS, identity provisioning, browser workflows and operational acceptance testing were not run.

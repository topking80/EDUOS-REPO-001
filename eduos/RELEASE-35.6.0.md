# EduOS 35.6.0 — SRO Incident Assignment & Acknowledgement

- School principals can assign an active, school-scoped SRO to a live incident.
- The assigned SRO can acknowledge or decline; only that assigned SRO may respond.
- Assignment and response events are appended to the incident responders timeline and audited.
- SRO timeline visibility is limited to the SRO's own assignments; school leadership sees the full timeline.
- Existing district SRO school-scope policy is checked at assignment time.
- No student records, guardian data, roll-call data, release authority, dispatch, or law-enforcement integration is added.

## API
- `GET /api/safety/incidents/:id/sro-assignment`
- `POST /api/safety/incidents/:id/sro-assignment` body: `{ "sroUserId": "<uuid>", "note": "optional" }`
- `POST /api/safety/incidents/:id/sro-assignment-response` body: `{ "response": "acknowledged" | "declined", "note": "optional" }`

## Verification
Static syntax checks and focused authorization tests are included. Live PostgreSQL/RLS and browser end-to-end testing were not run. This is internal coordination, not dispatch or a substitute for district emergency procedures.

EduOS District Edition 32.0.13 — Project Artwork Integration

What changed
- Reused three existing EduOS project diagrams in the live interface: system architecture on District Overview, deployment pathways on District Planner, and core service flow on AI Agents.
- Added a new vector illustration based on the five personas already defined in the project: Superintendent, Principal, Teacher, Parent/Guardian, and Pupil. It appears on each persona home screen.
- Replaced the unreadable role-matrix PNG with an accessible, responsive persona illustration. The damaged PNG is intentionally not shipped or referenced.
- Added responsive image treatment, captions, descriptive alternative text, lazy loading and asynchronous decoding.
- Preserved existing navigation, workflow logic, API bridge, OIDC/session code, migrations, RLS and authorization behavior.

Artwork provenance and boundaries
- Architecture, service-flow and deployment diagrams are reused from the earlier EduOS full-project archive.
- The five-persona illustration is a new SVG assembled from role names already present in the application.
- Persona switching remains a demonstration interface and does not authenticate a user or grant server permissions.
- No customer logos, named district logos, named third-party partners, endorsements, testimonials, awards or certifications were added.

Validation
- Focused integration and artwork tests: 12 passed.
- Full suite: 100 passed, 8 blocked by missing runtime packages (`cookie` and `jose`); see docs/VALIDATION-32.0.13.md.
- Server, API bridge and inline application JavaScript syntax checks passed.
- ZIP integrity checked.

Limitations
- This is a visual integration update, not a production readiness or compliance certification.
- Existing diagrams are reference illustrations only, not evidence of live integrations, deployed network topology or current operational telemetry.
- Full browser screenshot and cross-device visual testing was not completed in this environment.

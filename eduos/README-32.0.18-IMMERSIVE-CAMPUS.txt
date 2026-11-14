EduOS District Edition 32.0.18 — Immersive Campus Explorer
===========================================================

This release adds an interactive campus workspace to the existing EduOS application.

What changed
------------
- Added an Interactive Campus workspace to all five persona navigation trees.
- Campus explorer uses the existing synthetic school records and lets the user switch the selected school.
- Added six selectable campus areas: learning, library/media, student support, administration, technology/infrastructure, and family connection.
- Each campus area presents related workspace links where that persona has access.
- Reused the existing EduOS school-building and district-learning visual language.
- Added three original, accessible SVG assets: district operating constellation, school building cutaway, and classroom learning ecosystem.
- Added responsive layout, keyboard-operable buttons, aria-pressed state, and live detail updates.
- Clearly labels campus model as conceptual; it is not a verified room inventory or live facilities map.

Important limitations
---------------------
- The campus view is a navigation and concept-exploration layer over local demonstration records.
- It does not provide geospatial coordinates, room-level inventory, live building telemetry, or real facilities integration.
- Persona switching in the browser remains a demonstration affordance, not a security boundary.
- No FERPA/COPPA compliance or production-readiness claim is made.

Run
---
From this directory:
  npm install
  npm start

See README.md for the existing server, database, and configuration instructions.

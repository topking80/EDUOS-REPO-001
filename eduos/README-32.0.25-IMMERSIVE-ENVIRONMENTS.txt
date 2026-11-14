EduOS District Edition 32.0.25 — Immersive District & School Environments
============================================================================

Artwork additions
-----------------
- eduos-district-campus-atlas.svg: illustrated district campus landscape with
  multiple school buildings, athletics and shared services.
- eduos-school-floorplan-explorer.svg: conceptual school floor plan with
  classrooms, library/media, administration, student services, cafeteria,
  commons and technology.
- eduos-specialist-school-environments.svg: illustrated library, cafeteria,
  gymnasium and student-support environments.

Interactive integration
-----------------------
The shared layered artwork suite now includes an environment explorer with
District, School and Specialist Spaces selectors. Selecting a view updates
the displayed illustration and its explanatory caption. Keyboard-operable
buttons expose pressed state and the description region is announced via
aria-live.

All prior EduOS project artwork and the 32.0.23 deployment hardening changes
are retained. New assets use the project's navy, blue, amber and teal palette.

The district map and floor plan are conceptual illustrations. They are not
geographic records, actual school locations, surveyed plans, code drawings,
or verified building configurations.

Validation
----------
- New artwork tests: 4 passed.
- SVG XML validation: 18 passed.
- Inline JavaScript syntax: 2 passed.
- Full suite: 125 passed, 14 failed. The existing dependency-related failures
  remain because `pg` is unavailable in this environment.
- ZIP integrity: verified.
- No browser screenshot regression or live Docker/Caddy test was run.

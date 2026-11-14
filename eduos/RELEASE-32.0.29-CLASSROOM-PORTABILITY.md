# EduOS 32.0.29 — Classroom Layout Portability

## Changes
- Added JSON export for a teacher's classroom preference.
- Added JSON import with schema checks, allowed layout and desk-position checks, known floor/room validation, and a 32 KB upload limit.
- Added a versioned browser-storage key (`eduos-classroom-preference-v329`) and backward-compatible restore from the previous v326 key.
- Added a required teacher/room label before saving.
- Kept classroom plans as teacher preferences, not authoritative room drawings or student rosters.
- Kept emergency route content unconfigured until supplied and verified by school safety personnel.
- Updated package and lockfile release versions to 32.0.29.

## Validation
- `node --test`: **150 passed, 0 failed**.
- Inline application JavaScript: syntax check passed.
- SVG assets: 18/18 parsed successfully.
- ZIP integrity: verified after packaging.

## Boundaries
- Preferences remain in the current browser unless the user exports the JSON file. No server sync or district account association is implemented by this change.
- Imported layouts are limited to the built-in demonstration floors (1–3) and rooms (101–104, 201–204, 301–304).
- The floor plan remains illustrative. Do not use it for emergency response until actual building plans and approved procedures are entered and verified.
- No live browser interaction test, PostgreSQL test, OIDC provider test, Docker test, or production deployment test was performed.

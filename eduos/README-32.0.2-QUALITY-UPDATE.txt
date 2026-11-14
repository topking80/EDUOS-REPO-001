EduOS District Edition 32.0.2 — Workspace Usability Update

This update improves the existing Phase 32.0.1 product rather than adding another feature area.

User experience changes
- Added a skip-to-content link for keyboard and assistive-technology users.
- Added workspace search within the currently selected persona navigation.
- Search filters workspace links and department groups; Escape clears the query.
- Added Ctrl+K / Command+K shortcut to focus workspace search.
- Added visible keyboard focus styles.
- Added aria-current to the active workspace link.
- Moved focus to the workspace content after route navigation.
- Made the top workspace header sticky and refined small-screen header behavior.
- Corrected the product version label and clarified local demo vs authenticated API data.

Preserved
- Phase 32.0.1 Student 360 and intervention case workflows.
- Phase 28/32 authenticated API bridge, OIDC, server-side permission checks, CSRF, audit and database migrations.
- Phase 31.1 standalone reference UI remains in demo/.

Validation
- Automated tests: see docs/VALIDATION-32.0.2.md.
- Inline app JavaScript syntax and server JavaScript syntax checked.
- ZIP archive integrity checked.

Limitations
- No live browser automation was run; responsive behavior is implemented but not visually certified across devices.
- PostgreSQL migration execution and live OIDC login require configured services and credentials and were not performed.
- The local persona switch remains a synthetic demo selector, not an authentication or authorization boundary.

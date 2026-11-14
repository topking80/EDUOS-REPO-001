EduOS District Edition 32.0.12 — Persona Navigation Audit

Purpose
This is a focused reliability patch to the existing five-persona interface.
It does not add new product modules or change the server authorization model.

Findings and fixes
1. Fixed dead-end home navigation. The persona home page rendered quick-access
   tiles and workspace-tree buttons with data-page attributes, but the delegated
   navigation handler only listened for sidebar and top-left navigation buttons.
   Content-area page buttons are now handled as well.
2. Prevented duplicate navigation. Buttons that already have a data-act action
   are excluded from the generic page-navigation handler, so My Work shortcuts
   and other action-driven controls retain their dedicated behavior.
3. Escaped navigation error messages before inserting them into the DOM and
   marked the error panel as an alert. This avoids treating route/error text as
   trusted HTML.
4. Added regression coverage for all five persona menus, route-to-renderer
   registration, home navigation delegation, role route guards, and safe error
   rendering.

Scope
- Existing personas: Superintendent, Principal, Teacher, Parent/Guardian, Pupil.
- Existing workspace routes and role menu structure are preserved.
- Existing server API, OIDC/session code, database migrations, RLS and policy
  enforcement are unchanged from 32.0.11.
- Browser persona switching remains a synthetic demonstration and is not an
  authentication or authorization boundary.

Validation
- New persona/navigation audit tests: 4 passed, 0 failed.
- Inline application JavaScript syntax: passed.
- API bridge syntax: passed.
- Server JavaScript syntax: passed.
- Full npm test: 105 total; 97 passed, 8 failed because this environment has
  no installed runtime dependencies `cookie` and `jose`. The failures occur in
  tests that dynamically import authentication/OIDC modules. They are not
  counted as passing. A clean `npm ci` and full `npm test` remain required.
- ZIP integrity checked after packaging.
- No live browser automation, PostgreSQL/RLS, OIDC provider, or multi-instance
  test was performed.

This is a development quality patch, not production certification.

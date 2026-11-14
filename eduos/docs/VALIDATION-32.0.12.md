# EduOS 32.0.12 Validation Report

## Change scope
Focused five-persona navigation and safe error-rendering audit, based on the
32.0.11 integrated source. No backend, authentication, authorization, schema,
or migration behavior was changed.

## Findings fixed
- Home quick-access tiles and workspace-tree buttons were rendered with
  `data-page`, but the delegated navigation listener omitted content-area
  buttons. They are now routed through the existing `go()` guard.
- Generic navigation now skips controls with a dedicated `data-act` handler,
  avoiding duplicate page renders for action-driven shortcuts.
- Navigation error text is HTML-escaped before DOM insertion; the error panel
  has `role="alert"`.

## Passed
- New persona navigation audit: 4/4 tests.
- All five persona menu definitions map to registered page renderers.
- Role route guard remains present.
- Inline application script: `node --check` passed.
- `public/api-bridge.js`: `node --check` passed.
- All `src/*.js` files: `node --check` passed.
- ZIP integrity: passed.

## Full test suite
`npm test`: 105 tests total, 97 passed, 8 failed.

The 8 failures are caused by missing installed dependencies in this runtime:
- `cookie` unavailable when tests import `src/auth.js`.
- `jose` unavailable when tests import `src/oidc.js`.

These are not passing tests and the package must be verified in a network-enabled
build environment with `npm ci` followed by `npm test`.

## Not tested
- Real browser click-through / keyboard E2E.
- PostgreSQL migration execution and row-level security.
- Live OIDC sign-in and callback.
- Multi-instance deployment.

## Release status
Development quality patch only. Not production certified.

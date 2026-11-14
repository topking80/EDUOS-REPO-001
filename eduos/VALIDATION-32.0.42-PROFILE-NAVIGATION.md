# Validation — 32.0.42 · Cross-profile navigation, broken links & loops

Goal: confirm functionality works across every persona, with no broken links and
no navigation loops. Audited the served app (`public/index.html`) and the newest
standalone demo (`demo/eduos-district-edition-phase32.0.15-standalone.html`) in a
real Chromium browser (`profile-nav-audit.cjs`), driving the app's own `go()`
navigation and switching through all five personas.

## Method
- Loaded the app over HTTP (so absolute `/assets/...` paths resolve exactly as in
  production) and crawled **every nav link in every persona**.
- A link counts as broken if `go()` renders the "That section could not open"
  alert, logs a navigation `console.error`, throws, or renders empty.
- Static model cross-check: `roleMenus` (what the menu shows) vs
  `personaConfig` (what each persona may open) vs `renderers`/`pageNames`.
- Loop/stability: A→B→A must return; same-page re-render must be idempotent; any
  "maximum call stack" / recursion is flagged.

## Result — served app (`public/index.html`)

| Persona | Nav links | Result |
|---|---|---|
| Superintendent | 32 | 32/32 OK |
| Principal | 25 | 25/25 OK |
| Teacher | 14 | 14/14 OK |
| Parent / Guardian | 13 | 13/13 OK |
| Pupil | 11 | 11/11 OK |
| **Total** | **95** | **95/95 OK, 0 broken** |

- **Model consistency:** 0 issues — menu, persona access, renderers and page
  names fully agree (no page is shown that `go()` would refuse).
- **Loops:** none — A→B→A returns Home; re-render idempotent; no recursion.
- **Cross-profile:** all five personas switch; five distinct menu signatures.
- **Uncaught JS errors:** 0.

## Result — standalone demo (`...phase32.0.15-standalone.html`)
**81/81** links OK across all five personas; 0 broken; 0 model issues; 0 loops;
five distinct menus.

## Asset notes (not broken in-app links)
Over HTTP the only non-200 requests were external/environmental, not navigation:
- A **Google Font** (`fonts.googleapis.com/css2…`) referenced by
  `eduos-vision.css` — needs outbound internet; the browser falls back to system
  fonts offline. `eduos-vision.html/.js/.css` themselves all serve **200**.
- Under `file://` only, the app's absolute `/assets/...` paths cannot resolve;
  all 25 files exist in `public/assets` and serve 200 over HTTP. Load the app via
  a server (or the shipped HTTP/2 edge), not `file://`.

## Reproduce
```
# serve public/ on :8099, then:
node profile-nav-audit.cjs http://127.0.0.1:8099/index.html
# or, for a standalone demo file:
node profile-nav-audit.cjs /abs/path/to/demo/....standalone.html
```
Exit code is non-zero if any broken link, model issue, or loop is found.

## Observation (non-blocking, not a link/loop defect)
The Superintendent *Home* surfaces a teacher-oriented "My classroom & school
floor plan" card. It renders correctly and is in-scope for every persona's home;
if that card is meant to be teacher/principal-only, that is a content-scoping
tweak, independent of navigation integrity.

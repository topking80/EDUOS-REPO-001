# API route inventory (SEC-05)

`test/route-inventory.test.js` reads every route EduOS registers from Express's own router (`src/route-inventory.js`), in all three node tiers (classic, district hub, school node), and checks:

1. **A session or a reviewed exception.** Every route has `requireSession` in its chain, or is listed in the test's `PUBLIC` table with why it is reachable without one.
2. **The caller is still checked.** Each listed route names how the caller is checked instead: a device key, an edge device token, an association key, an EDEN node signature (`nodeAuth`), an LTI signed launch, client assertion or service token, a commerce webhook secret, the metrics token, or a share token in the URL. The test finds that check in the route's chain or in its handler, before the handler's first database call. Routes marked `public` or `sign-in` are open by design (the sign-in flow itself, branding for the sign-in page, credential verification, the health probe).
3. **Rate limits.** `/api`, `/auth` and `/lti` all sit under the per-session and per-address ceiling in `src/server.js` (LTI joined it with SEC-05). Listed routes marked `route` also keep their own, tighter limiter. Only ops probes outside those prefixes (`/health`, `/metrics`, the JWKS and the web app shell) have none.
4. **CSRF.** Every state-changing session route runs `requireCsrf` after `requireSession`.
5. **Caching.** `/api`, `/auth` and `/lti` answers are `Cache-Control: no-store` by default (`noStoreByDefault` in `src/server.js`, added with SEC-05). Only the routes listed as `public` (branding and the JWKS) set a public max-age. The test also checks the header over HTTP on refused and open requests.

## Adding a route

- A route for signed-in people: put `requireSession` first, then `requireCsrf` for anything other than GET or HEAD. There's nothing to list.
- A route reachable without a session (a device, a partner system, a public page): add an entry to `PUBLIC` in `test/route-inventory.test.js` with `why`, `check`, `limit` and `cache`. Check the caller before any database call. Give the route its own `express-rate-limit` limiter unless the prefix ceiling is enough, and say which in the entry.
- Removing a route, or adding a session guard to a listed one, makes the test fail until the entry is removed, so the list doesn't go stale.

Not covered: the separate Master Control service (`src/master-control/`) has its own app and sign-in and isn't part of this inventory.

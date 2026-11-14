# 32.0.44 — Cross-profile flow: transitions, webhooks, JavaScript through every layer

"Java" was implemented as **JavaScript**, the language of this project, from the
browser down to the database. No JVM component was added.

## The flow, layer by layer
| Layer | What was added |
|---|---|
| Workspace UI (`public/index.html`) | `flowEmit()` raised by hire / remove / create-section / enroll / unenroll / section-full. Unread badges on the other profiles' switches, a "Cross-profile activity" feed on every Home and on Staffing & Sections, a profile handoff ribbon, page and profile enter transitions, animated section bars. `prefers-reduced-motion` turns all of it off. |
| Across tabs | `BroadcastChannel` + `storage` events: a Principal tab updates live when a Teacher tab enrolls a pupil (it will not re-render over a form someone is typing in). |
| API bridge (`public/api-bridge.js`) | `publishFlowEvent`, `flowEvents`, `webhooks`, `createWebhook`, `disableWebhook`, `testWebhook`, each role-guarded. Events go to the server only when a real signed-in account matches the acting workspace. |
| Server (`src/server.js`, `src/flow-events.js`, `src/webhooks.js`) | `POST/GET /api/flow-events`; webhook subscribe / list / disable / test / delivery log; server-raised events after `POST /api/assignments` and `POST /api/attendance`. |
| Database (`db/008_flow_events_webhooks.sql`) | `flow_events`, `webhook_subscriptions`, `webhook_deliveries`, all with forced row-level security; events and delivery logs are append-only for the runtime role. |

## Safeguards
- **No names leave the browser.** Events are an allow-listed type, opaque references and bounded counters. Free text, unknown keys and name-shaped references are rejected (400). Family profiles see roster counts, never another pupil's name.
- **Who can do what.** Principals and teachers raise events for their own event types; parents and pupils cannot. Only superintendents manage webhooks; neither permission can be granted through access requests. School scope comes from the session, never the request.
- **Webhook destinations (SSRF).** HTTPS only, no embedded credentials, no private / loopback / link-local / metadata addresses (IPv4, IPv6, mapped forms), no low ports, optional host allow-list. Every DNS answer must be public and the connection is pinned to the vetted address; redirects are never followed; 5 s timeout.
- **Authenticity.** `X-EduOS-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` with a 5-minute replay window. Secrets are derived from `WEBHOOK_SIGNING_KEY`, shown once, never stored. Without the key the feature returns 503.
- **Failure handling.** 3 attempts with backoff on timeouts / 5xx / 429, every attempt logged, automatic disable after 10 consecutive failures. Delivery runs after the response, so a slow receiver cannot delay a user.

## Validation performed
| Check | Result |
|---|---|
| Unit + source tests (`npm test`) | **209 / 209** (22 new in `test/phase33-flow-webhooks.test.js`) |
| Browser flow (`flow-functional.cjs`) | **18 / 18** — events, badges, feed, transitions, live second tab, escaping, reduced motion |
| Live server + PostgreSQL 16 + receiver (`flow-live-check.mjs`) | **52 / 52** — authorization, validation, audience, tenant isolation, SSRF rejections, signed delivery, retries, no redirects, disable, audit, RLS and grants |
| Full stack in a browser (`flow-fullstack.cjs`) | **10 / 10** — UI action → bridge → server → database → external receiver, under the production CSP, no violations |
| Staffing (`staffing-functional.cjs`) / navigation (`profile-nav-audit.cjs`) | 13 / 13 · 98 links, 0 broken, 0 loops |
| Server without `WEBHOOK_SIGNING_KEY` | create webhook → 503 |

## Limits to know
- Staffing (teachers, sections, rosters) is still browser-side demo data, so staffing events reach the server as `source: "client-reported"` from an authenticated, authorized account; they are notifications, not an authoritative roster. Assignment and attendance events are `source: "server"`.
- Delivery is in-process: an event being retried when the server restarts is not resumed (attempts already made stay in the log). A durable outbox is the next step for production.
- Live checks used synthetic accounts with sessions seeded directly in the database; the OIDC sign-in itself was not re-run here. Not a penetration test or a production certification.

## Reproduce
```
npm test
# browser: serve public/ on :8099
node flow-functional.cjs
# live: PostgreSQL + migrations + db/runtime_grants.template.sql + flow-live-seed.sql,
# server started with WEBHOOK_SIGNING_KEY and WEBHOOK_ALLOW_INSECURE_LOOPBACK=true (dev only)
node flow-live-check.mjs http://127.0.0.1:8181 src/webhooks.js "dbname=eduos"
node flow-fullstack.cjs http://127.0.0.1:8181
```

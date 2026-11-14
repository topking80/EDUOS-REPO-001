# EduOS limits (32.2.0)

EduOS 32.2.0 has **no product limits**: no plan tiers and no fixed maximum
number of schools, students, users, webhooks or apps. The limits that remain
fall into three groups, and every one of them can be configured:

1. **District caps.** These are opt-in. Each district can set its own caps,
   and every cap is unlimited unless the district sets it.
2. **Paging.** Large lists are returned in pages instead of being cut off.
3. **Security and reliability limits.** These protect sign-in, sessions and
   the server's memory. They are kept on purpose, use safe defaults, and can be
   adjusted with environment variables.

## 1. District caps (`district_settings`; NULL = unlimited, the default)

Set them with `PATCH /api/district/settings`, which a superintendent or IT
admin can call. They are enforced when the matching record is created.

| Cap | Enforced on | Default |
|---|---|---|
| `max_schools` (`maxSchools`) | `POST /api/schools` (counts active schools) | unlimited |
| `max_students` (`maxStudents`) | SIS imports (the whole batch rolls back with `409 district_limit_reached`) | unlimited |
| `max_users` (`maxUsers`) | `POST /api/users` | unlimited |
| `max_active_webhooks` (`maxActiveWebhooks`) | `POST /api/webhooks` | unlimited (was a fixed 10) |
| `max_apps` (`maxApps`) | `POST /api/apps` (counts active apps) | unlimited |

`GET /api/district/settings` returns each cap alongside the current count.

## 2. Inventory: every limit found in 32.1.0 and what 32.2.0 does with it

| Limit in 32.1.0 | Kind | 32.2.0 |
|---|---|---|
| `/api/students` `LIMIT 200` | truncation | Paged with `?limit` and `?offset`; returns `page.total`; adds `?q=` name or student-number search |
| `/api/users` `LIMIT 2000` memberships | truncation | Paged by user; adds `?q=`, `?role=` and `?schoolId=` |
| `/api/attendance` 250, `/api/cases` 250, `/api/assignments` 200, `/api/audit` 250, `/api/access-requests` 250, `/api/guardian-invitations` 200, `/api/family/messages` 200, `/api/integrations/sis/runs` 100, `/api/rosters` 1000, `/api/flow-events` 50, `/api/webhooks` 50, webhook deliveries 25 | truncation | All paged. The default page size is `PAGE_SIZE_DEFAULT` (200) and the maximum is `PAGE_SIZE_MAX` (1000). Each response includes `page.nextOffset`. |
| Audit CSV export: newest 5,000 events only | truncation | Streams every event in keyset-ordered chunks of 2,000, so memory use stays flat |
| SIS import: at most 5,000 students and 10,000 attendance rows per batch | product cap | Removed. Rows are written set-based in chunks of 2,000. The only bound is the body size, `SIS_IMPORT_MAX_MB` (default 50 MB). |
| SIS CSV import body 5 MB; CSV text 2 MB | size | Both follow `SIS_IMPORT_MAX_MB`. The body is parsed only after the session, CSRF token and permission have been checked. |
| JSON `/api/integrations/sis/import` limited to the global 256 KB parser | size | Uses the bulk parser (`SIS_IMPORT_MAX_MB`) after authentication |
| `MAX_ACTIVE_WEBHOOKS = 10` | product cap | Removed. The district can set `max_active_webhooks` if it wants a cap. |
| Webhook dispatch: `LIMIT 10` subscriptions per event; a delivery was **dropped** when 16 were already in flight | truncation | Every matching subscription receives the event. Deliveries queue behind `WEBHOOK_MAX_IN_FLIGHT` (16) instead of being dropped. |
| Flow-event counters at most 100,000 | data bound | Raised to 1,000,000,000 |
| Guardian invitations: 20 per hour per IP | rate limit | 1,000 per hour, set by `GUARDIAN_INVITE_RATE_LIMIT_PER_HOUR`. The old value blocked a school office sending its back-to-school invitations. |
| Webhook admin: 40 per 15 minutes | rate limit | 200, set by `WEBHOOK_ADMIN_RATE_LIMIT_PER_15M` |
| Student 360 sections: 100 rows each; UI shows 8 or 30 | summary window | Kept. These are summary panels, and the full history is in the paged list endpoints. |
| Text lengths (titles 180, notes 1,000, responses 20,000, feedback 4,000), score range 0–100, DB CHECK sizes | data quality | Kept. These are validation rules, not capacity limits. |

## 3. Security and reliability limits (kept; configurable)

| Setting | Default | Why it stays |
|---|---|---|
| `LOGIN_RATE_LIMIT_PER_15M` | 600 per IP | Slows password and code-guessing attacks against sign-in. A whole school behind one NAT address fits within 600. |
| `GUARDIAN_ACCEPT_RATE_LIMIT_PER_15M` | 10 per IP | Protects one-time invitation tokens from guessing |
| `FLOW_EVENT_RATE_LIMIT_PER_MIN` | 120 | Stops a client from flooding feeds and webhooks |
| `WEBHOOK_ADMIN_RATE_LIMIT_PER_15M` | 200 | Limits automated probing of webhook URLs (SSRF) |
| `JSON_BODY_LIMIT` | 256kb | Prevents oversized bodies on ordinary API calls from exhausting memory |
| `SIS_IMPORT_MAX_MB` | 50 (allowed range 1–1024) | Bounds the memory one import can use. Only an authorized importer can send a body this large. |
| `PAGE_SIZE_MAX` | 1000 | Bounds the memory and time one request can use. Callers page through larger lists. |
| `SESSION_MAX_PER_USER` | 5 (allowed range 1–1000) | Limits how many sessions one stolen account can keep open. Raise it for shared devices. |
| `SESSION_CACHE_MAX` | 5000 | Memory bound for the optional session cache |
| `WEBHOOK_MAX_IN_FLIGHT` | 16 | Concurrency bound for outbound deliveries (queued, not dropped) |
| Webhooks: 3 attempts, 64 KB response, 2,048-character URL, at most 16 event types per subscription | fixed | SSRF and resource protections |
| CSRF tokens, session idle timeout and TTL, OIDC state binding | fixed or configured as before | Unchanged |

## Measured (seeded large district)

`node dev/seed-large.mjs` builds a district of 50 schools and 50,000 students
through the public SIS CSV import endpoint, then times the list and search
endpoints. `LARGE_SINGLE_BATCH=50000` also imports 50,000 students in one batch.

Measured on the local dev stack, Nov 10, 2026:

| Operation | Time |
|---|---|
| Import 50,000 students plus 50,000 attendance events (50 batches) | about 10 s; 238 ms per batch of 1,000 |
| Import one batch of 50,000 students | 2.5 s |
| First and deepest page of 1,000 students | under 105 ms |
| Search | about 35 ms |
| Home dashboard | under 50 ms |

Full results are in `FIX-REPORT-32.2.0.md`.

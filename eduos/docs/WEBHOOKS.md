# Outbound webhooks

Signed HTTPS notifications of flow events, sent to receivers a district
registers (`POST /api/webhooks`). They stay off unless `WEBHOOK_SIGNING_KEY`
(32+ characters) is set. Payloads carry event types, opaque references and
counters, never names.

## Delivery

- **Outbox.** Each event is written to a durable outbox in the same
  transaction that records it (`webhook_outbox`), and server-raised events
  (assignments, attendance, app mesh, branding) are written in the same
  transaction as the change itself: no change commits without its event.
- **When jobs go out.** Workers deliver due jobs after the request that raised
  the event has been answered, and on a sweep the API runs every
  `WEBHOOK_DISPATCH_INTERVAL_SECONDS` (default 60; `0` turns it off), so a
  quiet district's webhooks and retries go out without cron.
  `src/webhook-dispatch.js` (`npm run webhooks:dispatch`, or the compose
  `webhooks` service) does the same from a scheduler. Any number of API
  instances and dispatchers can run at once. Reading the event feed
  (`GET /api/flow-events`) never starts a delivery, so keep the sweep or the
  dispatcher running.
- **Leases.** A worker claims a batch with a lease. Just before each job's
  delivery it renews that job's lease, and skips the job if another worker has
  taken it. A delivery is cut off at 45 seconds (DNS at most 15 s, HTTP 5 s),
  well inside the two-minute lease. So a job is never delivered by two workers
  at once, even when a batch takes longer than its original claim. A crash
  can still re-send a job after its lease runs out; the `X-EduOS-Delivery` id
  is the same on every attempt, so receivers should de-duplicate on it.
- **Deadlines.** The 5-second HTTP timeout is absolute (connect to last
  byte), not an idle timer, and the 45-second job deadline aborts the request:
  a receiver that trickles bytes is cut off and its socket closed before the
  slot is reused.
- **Concurrency.** Every delivery from one process (request-triggered
  workers, the sweep, "Send test") goes through one limiter of
  `WEBHOOK_MAX_IN_FLIGHT` (default 16). Across the whole deployment (all API
  replicas and dispatchers) at most `WEBHOOK_GLOBAL_MAX_IN_FLIGHT` (default
  64; `0` = per-process only) are in flight, tracked in PostgreSQL with
  leased slots. A job that finds no slot is put back without using an attempt;
  "Send test" answers 503 `webhook_capacity_busy`. A worker claims no more jobs
  than it has free slots.
- **Registration.** One active subscription per URL per district, and at most
  `max_active_webhooks` (district setting); both are enforced by PostgreSQL,
  so concurrent requests can't get past them.
- **Retries.** A timeout, network error, HTTP 408, 5xx or 429 is retried with back-off
  (15 s, 30 s, 60 s … at most an hour). If the receiver sends `Retry-After`
  (seconds or an HTTP date) on a 408, 429 or 503, the next attempt waits at least
  that long, capped at an hour.
  - After `max_attempts` the job is a dead letter.
  - A domain that doesn't exist gets one retry.
  - After 10 failures in a row the subscription is disabled.

## Signatures

Every delivery is signed in this header:

```
X-EduOS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>
```

Receivers should check that any `v1` matches (in constant time) and reject a
`t` more than 5 minutes off. The per-subscription secret is derived from
`WEBHOOK_SIGNING_KEY` and shown once at creation. A webhook manager can fetch
it again with `POST /api/webhooks/:id/secret`, which is audited.

### Rotating the signing key

1. Set `WEBHOOK_SIGNING_KEY_PREVIOUS` to the current key and
   `WEBHOOK_SIGNING_KEY` to a new one, then restart. Every delivery now carries
   two signatures: `t=…,v1=<new>,v1=<old>`. Receivers holding the old secret
   keep verifying.
2. For each subscription, fetch the new secret
   (`POST /api/webhooks/:id/secret`) and give it to the receiver.
3. Remove `WEBHOOK_SIGNING_KEY_PREVIOUS` and restart. Only the new signature
   is sent from then on.

Receivers that parse the header strictly as `t=…,v1=…` need to accept a second
`v1` before step 1.

## Destinations

- **Scheme and credentials.** HTTPS only, with no credentials in the URL.
  Ports are 443 or above 1023.
- **Addresses.** Every DNS answer must be a public unicast address, and the
  connection is pinned to the vetted address (no rebinding). Redirects are not
  followed, and responses are capped at 64 KB. Refused:
  - private, loopback, link-local and multicast ranges;
  - CGNAT, documentation and benchmarking ranges;
  - IPv4-embedding forms: mapped, compatible, SIIT, 6to4, NAT64 and Teredo;
  - the rest of the IANA special-purpose IPv4 and IPv6 registries
    (`src/webhooks.js`).
- **Allowlist.** `WEBHOOK_ALLOWED_HOSTS` pins receivers to listed domains and
  their subdomains. In production, webhooks don't start without it unless
  `WEBHOOK_ALLOW_ANY_PUBLIC_HOST=true` says any public HTTPS receiver is
  intended.

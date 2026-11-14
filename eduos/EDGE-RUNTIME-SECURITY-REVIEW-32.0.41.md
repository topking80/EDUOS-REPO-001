# Edge Runtime Security Review — 32.0.41 (strengthening addendum to 32.0.40)

32.0.40 closed the critical enrollment-intake exposures (loopback bind, bearer
token, strict schema, pending-only records, hardened container/unit). 32.0.41
strengthens that same surface against the remaining denial-of-service and
request-framing vectors, and converts the earlier source-level review into
executed behavioral tests.

## New hardening in this release

| # | Hardening | Vector closed | Where |
|---|---|---|---|
| 1 | Per-connection read timeout (`Handler.timeout`, default 10s) + `408` on body-read timeout | Slowloris / slow-read: a client holding a thread open indefinitely on `ThreadingHTTPServer` | `scripts/eduos-enrollment.py` |
| 2 | Pending-queue cap (`MAX_PENDING`, default 1000) → `503 queue_full` | Disk-fill DoS: an *authenticated* client writing unlimited pending records | `scripts/eduos-enrollment.py` |
| 3 | Rate-limit table pruned each request + bounded (`MAX_TRACKED_IPS`) | Unbounded memory growth in the `attempts` map | `scripts/eduos-enrollment.py` |
| 4 | Reject `Transfer-Encoding` (require explicit `Content-Length`) → `411`; verify full body read → `400 incomplete_body` | Ambiguous/chunked request framing; truncated-body parsing | `scripts/eduos-enrollment.py` |
| 5 | Empty capability set, syscall allow-list, `IPAddressDeny=any`/`IPAddressAllow=localhost`, namespace/proc/clock/hostname restrictions, `MemoryMax`/`TasksMax`, `UMask=0077` | Kernel-level defense-in-depth; loopback-only now enforced by the kernel, not only the app | `services/enrollment.service` |
| 6 | Container memory/CPU/PID caps + `--read-only-tmpfs` + HEALTHCHECK | Host resource exhaustion from a connection flood; liveness | `quadlet/eduos-enrollment.container` |
| 7 | Loopback-guard refactored to a testable `loopback_only()` and covered by tests | Regression protection for the non-loopback-bind refusal | handler + tests |

## Validation performed here
- `python3 -m py_compile` on the hardened handler — clean.
- **15 behavioral tests executed** (`tests/test_enrollment.py`, real loopback
  server, temp token/queue): health-open; missing/wrong-token → 401; valid →
  202 with a `0600` `pending_review` file; extra-field/bad-device-id/bad-role →
  400; wrong content-type → 415; **chunked → 411**; oversize → 413; PUT/DELETE →
  405; **rate-limit → 429**; **queue-full → 503**; loopback-guard and
  token-validation unit checks. All pass.
- `systemd-analyze verify services/enrollment.service` — no invalid-directive
  errors (only the expected off-host "bootstrap.service not found" dependency
  notice); every added hardening directive is recognized.
- Node application suite unchanged by this work: **187/187**.

## Residual items (unchanged, still outstanding — not production certification)
Runtime integration with Podman/systemd/SELinux, a TLS-terminating local proxy,
the district IdP, mTLS health ingestion, and image digest-pinning/signature
enforcement are **not** validated in this package. The update agent remains
simulation-only. The `platform/edge-runtime-reference/` tree is an un-hardened
reference copy retained because the integration test asserts its presence; the
hardened runtime is `edge-platform/eduos/`. Do not represent this as a completed
penetration test or production certification.

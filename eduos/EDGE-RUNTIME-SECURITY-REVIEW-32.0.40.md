# Edge Runtime Security Review — 32.0.40

| Finding | Previous risk | Remediation/status |
|---|---|---|
| Enrollment unauthenticated HTTP endpoint | Critical: any reachable client could submit arbitrary enrollment payloads | Closed: loopback bind + bearer token + strict JSON schema + rate limit |
| Public port binding | High: service published on all interfaces | Closed in Quadlet: 127.0.0.1 only |
| Raw form data persisted | High: arbitrary PII and unvalidated payload storage | Closed: allow-listed device ID/role only; pending-only record |
| Root service/container | High: compromise grants excessive privilege | Reduced: dedicated UID/GID 10001, no capabilities, read-only container and systemd hardening |
| Token lifecycle | Previously absent | Per-boot random token, protected runtime file, fail-closed startup |
| Update agent | Simulated update operation | Still simulation-only; no actual update application enabled |
| Health agent | Local report only; no authenticated central transport | Still local-only; mTLS ingestion not implemented |
| Image provenance | Floating tags existed | Enrollment image versioned; digest pinning/signature enforcement remain release pipeline work |

## Validation boundary
Source-level review and syntax checks are performed in this package. Runtime integration with Podman, systemd, SELinux, a TLS proxy, district identity provider and production secrets was not available here. Do not represent this release as a completed penetration test or production certification.

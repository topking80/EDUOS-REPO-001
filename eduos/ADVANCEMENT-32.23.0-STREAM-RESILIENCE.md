# EduOS 32.23.0 — Operational Stream Resilience

## Change
The authenticated operational Server-Sent Events endpoint now applies bounded backpressure handling. A slow browser can queue at most 128 frames; if it remains blocked beyond that bound, the stream is closed so EventSource can reconnect and resume from `Last-Event-ID`. This avoids unbounded per-connection memory growth. The heartbeat timer is unreferenced so it does not keep a process alive during shutdown. Drain listeners and queued frames are cleaned up on close.

## Security and privacy retained
- Authentication and audit-read authorization remain required.
- Notification payloads still contain only district and event identifiers; each event is re-read in the subscriber's tenant/school scope.
- Stream payloads still use the fixed allowlisted taxonomy and omit student names, student IDs, resource IDs and audit details.

## Validation
- Added source-contract coverage for the bounded queue, drain handling, cleanup, heartbeat unref, and reconnect cursor.
- Full runtime/database load testing is not claimed here; the database-backed stream requires the configured PostgreSQL environment.

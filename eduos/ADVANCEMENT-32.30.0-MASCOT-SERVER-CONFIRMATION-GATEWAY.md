# EduOS 32.30.0 — Mascot Server-Confirmation Gateway

## Purpose

Add a typed Flutter event gateway between completed API workflows and mascot
animation signals. The gateway rejects non-2xx responses, rejects outcomes
that the caller has not explicitly marked as business-level server-confirmed,
and refuses events after disposal.

## Privacy and trust boundary

The gateway accepts only a closed enum of semantic operations. It does not
accept response maps, student identifiers, names, notes, or tokens. The host
application must call it only after authenticating the request and validating
the server's business-level result. An HTTP 2xx response by itself is not
proof that a handoff, attendance record, or rider arrival was accepted.

This is a client-side safety boundary, not a substitute for server-side
authorization, database transactions, or audit logging. It does not claim that
the currently browser-local arrival demo has become a production workflow.

## Verification

Four Flutter unit tests cover successful publication, HTTP rejection,
business-level rejection, and disposal. Flutter/Dart SDK availability must be
checked in the build environment before claiming those tests or a mobile build
have executed. Existing Node.js test coverage and source syntax checks should
be run separately.

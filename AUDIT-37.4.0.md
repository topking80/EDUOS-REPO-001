# EDUOS 37.4.0 — Forensic Audit Report

**Status:** Audit in progress
**Release archive:** eduos-37.4.0-dns-retry-improvements.zip
**Repository:** EDUOS-REPO-001
**Branch:** main
**Audit date:** November 14, 2026

## 1. Executive Summary

The 37.4.0 audit included static source review, automated tests, security and RLS inspection, and validation against a disposable PostgreSQL 16 database.

The audit produced positive test evidence but is not a production certification. Several security, retention, test-coverage, and deployment questions remain open.

## 2. Original Archive Verification

### Mesh assignment SQL

The original archive contains:

`SELECT 1 FROM schools WHERE id=$1 AND status='active'`

The temporary extraction contained `schoolsWHERE`, but the original archive does not. This is not a confirmed release defect.

### Offline replay SQL

The original archive contains:

`ON CONFLICT (user_id,idem_key)DO NOTHING RETURNING idem_key`

The closing parenthesis separates the SQL tokens. This is valid SQL. The temporary extraction's `DONOTHING` discrepancy is not confirmed in the original archive.

**Conclusion:** Neither apparent SQL defect is attributed to the original release.

## 3. PostgreSQL Validation

A disposable PostgreSQL 16 database was used.

Results:
- All 33 SQL migrations, from 001 through 033, executed successfully on a clean database.
- The runtime grants template executed successfully.
- The test runtime role was not a superuser, did not have BYPASSRLS, and did not have role-creation or database-creation privileges.
- The runtime role had database CONNECT and schema USAGE, but no schema CREATE privilege.
- 132 public tables were found.
- 125 tables had RLS enabled and forced.
- Seven public tables did not have RLS enabled and require documented justification.

Limitations:
- Migrations were applied as PostgreSQL superuser in the disposable database.
- This does not validate upgrades of an existing production database.
- Production ownership, permissions, and live RLS behavior remain to be verified.

## 4. Automated Test Results

### Focused webhook tests

Command:
`node --test test/phase33-flow-webhooks.test.js test/durable-webhook-outbox-37.3.test.js`

Result:
- 28 passed
- 0 failed

Coverage included DNS retry behavior, private-address blocking, redirects, signatures, delivery outcomes, tenant isolation, outbox migration and grants, and transaction insertion.

### Mesh integration tests

Command:
`EDUOS_TEST_PG_URL=... node --test test/integration/mesh.test.js`

Result:
- 9 passed
- 0 failed
- 0 skipped

The suite used a real PostgreSQL integration harness and a non-owner runtime role. It covered district and school app assignments, cross-school sharing, launch permissions, licensing, and privacy boundaries.

The isolated school-sharing test also passed.

### Tenant transaction tests

With dummy test configuration values:
- 5 passed
- 0 failed

Coverage included transaction-local tenant context, clearing school context, rollback and connection release, incomplete identity rejection, and unsafe database role rejection.

### Full test suite observations

The earlier full-suite run exposed stale hardcoded release-version and title assertions in multiple test files. Some tests referenced versions 35.0.0, 35.6.0, 35.8.0, and 34.7.0 while the package release is 37.4.0.

The safety test also conflicts with browser camera use in the barcode scanner. The test expects no getUserMedia or geolocation use, while the inspected application source contains camera access.

The full suite was not demonstrated green. No overall pass/fail total is asserted here.

## 5. Security and Architecture Findings

### RLS function execution privileges

The disposable database inspection found:
- 37 helper functions referenced by RLS policies.
- Most relied on PostgreSQL's default PUBLIC EXECUTE privilege.
- Only two policy helper functions had explicit grants to the runtime role.
- Simulating revocation of PUBLIC EXECUTE caused 35 policy helpers or dependencies to become unavailable to the runtime role.

The runtime grants template did not contain a general PUBLIC function-execution revocation.

This is a least-privilege concern. Any hardening must explicitly grant all required policy helpers and dependencies before removing PUBLIC execution. Do not apply a blanket revoke without testing all RLS policies.

### Transport check-in enforcement

The API handler validates:
- Run status and allowed offline completion timing.
- Student rider assignment.
- Stop membership in the route.
- Idempotency and queued timestamp.

The inspected database insert policy did not appear to enforce all of these same conditions.

This is a defense-in-depth concern. Determine whether equivalent database constraints are needed so direct SQL under the runtime role cannot bypass API-only checks.

### Offline replay retention

The replay receipt table has an age index and the client queue has a 24-hour age limit. The inspected retention settings and purge routines did not include cleanup of offline_replays.

This is a data-growth and retention-policy concern. Any cleanup must preserve idempotency protection for the accepted replay window.

### Webhook outbox lifecycle

The focused tests passed, but the inspected outbox tests did not cover the complete worker lifecycle:
- DNS failure followed by success on a later worker run.
- Retry exhaustion and dead-letter transition.
- Subscription failure-count and auto-disable behavior.
- Lease expiry and competing workers.

These should be tested before production approval.

## 6. Release Metadata and Test Maintenance

Several tests contain old release-version assertions.

Retain their functional safety and workflow checks, but update release metadata assertions to compare against the current package, lockfile, application title, and service-worker version. Do not delete useful tests simply because their version assertions are stale.

## 7. Outstanding Validation

1. Re-run the complete test suite against the original archive extraction.
2. Resolve stale version assertions and the camera-policy conflict.
3. Review RLS helper execution privileges and prepare a complete explicit-grant plan.
4. Add transport check-in database-level defense-in-depth tests.
5. Add offline replay timestamp-boundary and idempotency tests.
6. Define and test offline replay receipt retention.
7. Add webhook outbox lifecycle and multi-worker lease tests.
8. Validate migrations and runtime permissions using intended non-superuser roles.
9. Validate production edge, scheduler, secrets, and database connectivity.
10. Record the exact source archive checksum and test environment in release evidence.

## 8. Audit Conclusion

The audit has meaningful positive evidence:
- 33 migrations passed on a clean PostgreSQL 16 database.
- 28 focused webhook tests passed.
- 5 tenant transaction tests passed.
- 9 mesh integration tests passed.

Important security, policy, retention, and test-coverage questions remain.

The two apparent SQL syntax defects observed in the temporary extraction were not confirmed in the original ZIP and are excluded as release defects.

**Disposition: Continue validation. This report is not production approval.**

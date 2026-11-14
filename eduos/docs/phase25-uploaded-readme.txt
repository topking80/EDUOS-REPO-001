# EduOS District Edition 25.0 — Permissions Matrix & export fix

Continues the Phase 24 "Permissions & Audit Foundation", built on the fixed 24.0.1.

## Added
- Permissions Matrix (leadership-only governance page): a live grid of every
  delegated action x persona, generated from the same actionPolicy that guards
  mutations. Grouped by type (assignment, attendance, student, case, export),
  the current role's column highlighted, with "own learner only" scope flags.
- Permissions Matrix CSV export (leadership-only; denials logged to the audit).
- Exposed only to District Superintendent and School Principal personas; other
  personas have no nav entry and are blocked at the route guard.

## Fixed
- The Security & Audit Log "Export CSV" button was never wired to a handler, so
  it did nothing. It now calls exportAudit() (leadership-only) and downloads.
- (Carried from 24.0.1) Four double-escaped regex/string literals: date
  validation, CSV line join, and the NCES import BOM-strip + line-split.

## Validation
- Inline script passes `node --check`; no double-escape regressions.
- Headless browser: matrix renders for leadership and is blocked for teacher/
  parent/pupil (nav + route guard); audit CSV and permissions CSV both download;
  all 26 nav pages render with no page errors.

## Critical limitations (unchanged from 24.0)
Client-side demonstration only. Persona selection is not authentication; the
policy and audit are workflow guardrails, not a security boundary; localStorage
and the audit log are user-controlled and not tamper-proof. Do not use real
student data.

## Run
Open eduos-district-edition-phase25.html in a modern browser. No server needed.

# EduOS District Edition 27.0 — Access Requests & Grants

Continues the Phase 26 governance line (audit filters, denial explanations,
"What I can do"). Adds a full request-access delegation workflow.

## Added
- Request access: on the "What I can do" page, any blocked action shows a
  "Request access" button. The persona submits a reason; the request is logged
  to the audit log (outcome "requested") and marked pending.
- Access requests page (leadership only): district superintendent and school
  principal review pending requests and Approve, Deny, or Revoke. Pending,
  Active grants, and History are shown separately with KPIs. Every decision is
  written to the audit log (approved / rejected / revoked).
- Enforced grants: an approved request becomes a demo grant that the SAME
  policyCheck honors at the action boundary — the requesting persona can then
  perform the action (audited as "granted"), until a leader revokes it. The
  "What I can do" page reflects live status: allowed / granted / request
  pending / not allowed.
- The audit filters (Phase 26) automatically pick up the new outcomes
  (requested, approved, rejected, revoked, granted).

## Validation
- Inline script passes `node --check`; no double-escape regressions; no BOM.
- Headless browser audit of the full lifecycle:
  - Pupil requests grade access -> pending -> policy still BLOCKS while pending.
  - Superintendent approves -> grant ENFORCED (pupil can grade) -> capabilities
    shows "granted" and "Including 1 granted".
  - Superintendent revokes -> policy BLOCKS again. Every step audited.
  - Access requests page is leadership-only (no nav + route guard for
    teacher/parent/pupil).
  - All nav pages render for all personas with zero page errors.

## Critical limitations (unchanged)
Client-side demonstration only. Persona selection is not authentication; the
policy, grants, and audit are workflow guardrails, not a security boundary;
localStorage is user-controlled and not tamper-proof. Grants live in this
browser only. Do not use real student data.

## Run
Open eduos-district-edition-phase27.html in a modern browser. No server needed.

# District AI privacy governance

## Default-deny external processing

Migration 051 adds a district-level `external_provider_enabled` gate to
`ai_district_policy`. It defaults to false, including for existing districts.
When the server is configured for an external OpenAI-compatible provider, the
staff AI run endpoint refuses requests until the superintendent explicitly
enables external processing through **Assistant settings**. The policy write
requires an explicit privacy acknowledgement and records the acknowledging
superintendent and timestamp. Turning the gate off immediately blocks new
external-provider requests. A local-only deployment remains local and does
not need this opt-in.

The same district AI policy remains protected by tenant RLS and the existing
district budget advisory lock. Only the superintendent can change it;
principals and IT administrators can read it according to the existing policy
reader rules. Policy changes are audited without storing prompts or answers.

## What the acknowledgement means

The acknowledgement is not a claim that student data is safe to send, nor a
FERPA/COPPA certification or legal approval. It records that the district
understands these limitations:

- Redaction is best-effort pattern matching against the district's current
  student names and identifiers plus known contact details. It cannot
  guarantee de-identification, detect every indirect identifier, or reliably
  recognize sensitive narrative details.
- Staff-entered text may contain information not present in EduOS records.
  Do not paste student records, disability/health details, discipline or
  counseling narratives, family circumstances, credentials, or other
  sensitive personal information into an AI prompt.
- The external provider may process data under its own terms and retention
  practices. District privacy/security staff and counsel must review the
  processor, contract, data location, retention, training use, subprocessors,
  incident notice and deletion commitments before enabling this setting.
- The existing gateway records usage and audit metadata, not prompt or answer
  text. Provider-side processing and logs are outside EduOS's control.

## Release and operational checks

1. Keep the external provider disabled unless a district has completed its
   vendor and privacy review.
2. If approved, set the narrow `AI_PROVIDER_ALLOWED_HOSTS` allowlist and the
   provider credentials in the deployment environment; see
   [AI provider egress](./AI-PROVIDER-EGRESS.md).
3. Have the superintendent enable external processing and affirm the
   acknowledgement in Assistant settings.
4. Verify a disabled district receives `ai_external_provider_disabled` and
   that an enabled district still passes the external-egress and redaction
   regression suites.
5. Revoke external processing immediately if the vendor, contract, data
   handling, or district approval changes.

This control is an additional governance gate, not a substitute for
redaction, data minimization, contractual review, or production acceptance.
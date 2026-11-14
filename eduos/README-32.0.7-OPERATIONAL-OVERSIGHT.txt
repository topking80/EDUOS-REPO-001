EduOS District Edition 32.0.7 — Operational Oversight Quality Update

Purpose
Improve administrator visibility across existing workflows and make the boundary between local agent demonstrations and authenticated server audit records explicit.

What changed
- Added POST /api/agent-events, protected by an authenticated session, CSRF validation, and the existing audit-read permission (superintendent and principal roles).
- The endpoint accepts only a run ID, an allowlisted topic category, and the exact category-specific agent route. Unexpected fields—including raw questions or arbitrary agent output—are rejected.
- Server audit records retain the authenticated actor, run ID, category, bounded route, and local deterministic mode. The original user question and generated response are not sent or stored.
- The Unified AI Command workspace labels each run as Server recorded, Local only, or Not recorded.
- Connected Services includes a separate server-recorded agent activity view in the leadership audit workspace.
- Added role-scoped operational notices derived from records already visible to the signed-in user: pending district access requests and denied actions for superintendents; overdue and high-priority visible intervention cases for staff.
- If required operational feeds fail to load, the notice panel says the review is incomplete rather than presenting a false all-clear.
- Audit data is refreshed when the leadership audit tab is opened.

Security and capability boundaries
- Local deterministic orchestration remains a simulation, not external AI inference or an authenticated AI runtime.
- The browser does not send the user's original question, generated summaries, student records, or case notes to the agent-event endpoint.
- Server recording is available only to authenticated superintendent and principal sessions with audit-read permission.
- Server audit writes use the existing append-only audit_events table and tenant transaction helper.
- Operational notices are summaries, not push notifications, email, SMS, or real-time monitoring. They are calculated from the currently loaded authorized records.
- The local run history remains editable browser storage and is not an immutable audit source.

Run
1. Install dependencies with npm install.
2. Configure environment variables using .env.example.
3. Review the existing database migrations before applying them.
4. Start with npm start.

Release classification
Development quality update. Automated tests and syntax checks are included in the validation report. Live PostgreSQL, OIDC, and browser end-to-end testing remain outstanding. This release is not certified or represented as production-ready.

EduOS District Edition 32.0.6 — Agent Orchestration Quality Update

Purpose
Improve the four existing agent experiences by adding one transparent coordinator and a bounded, inspectable handoff sequence. This is a refinement of the current product, not a new external AI integration.

What changed
- Christie AI acts as the intake and synthesis coordinator in the Unified AI Command workspace.
- Topic routing selects only the relevant existing specialist: Aurora for attendance; Helios for infrastructure; Vulcan and Aurora for platform operations; Christie-only for district overview/general requests.
- Specialist steps reuse the existing deterministic local agent briefs.
- Every run shows an intake → specialist analysis (when applicable) → synthesis trace.
- A local run register retains up to 20 runs and the activity log records individual handoff events.
- The raw user question is not retained in the orchestration activity log; only its broad topic category and the generated synthetic summaries are retained.
- The command interface limits prompts to 240 characters and rejects blank questions.
- The run register and activity log are local browser data, not immutable server audit records.

Security and capability boundaries
- This is a local synthetic demonstration, not an authenticated agent runtime.
- Local persona selection is not an authorization boundary.
- The orchestration layer reads only aggregate synthetic school data and does not access student-level records or intervention notes.
- No LLM/model inference, external integrations, live telemetry, shell commands, deployment actions, or district-system mutations occur.
- A future connected runtime must enforce the signed-in user's server-side permissions at every handoff, minimize data, produce immutable server audit records, and require human approval for consequential actions.

Run
1. Install dependencies with `npm install`.
2. Configure environment variables using `.env.example`.
3. Review migrations before applying them to PostgreSQL.
4. Start with `npm start`.

This release remains a development demonstration and is not certified or represented as production-ready.

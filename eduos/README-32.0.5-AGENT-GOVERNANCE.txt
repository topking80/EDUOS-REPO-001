EduOS District Edition 32.0.5 — Agent Governance & Workflow Quality

What changed
- Replaced generic "Run demo workflow" claims with transparent local analysis.
- Defined separate operational contracts for Christie AI, Helios, Vulcan, and Aurora.
- Each agent card now states scope, inputs, expected output, and prohibited actions.
- Christie and Aurora produce deterministic summaries from the current synthetic school directory.
- Helios produces a capacity-planning review checklist from available school records.
- Vulcan produces a platform-operations checklist; it does not execute deployments or inspect infrastructure.
- Every run is recorded as a local analysis, with its basis and limitations visible.
- No external model inference, live telemetry, system commands, or production integrations are represented as active.

Important boundaries
This is still a local synthetic demonstration. Agent outputs are deterministic code, not AI-generated advice. No real SIS, network, cloud, facilities, monitoring, or DevOps service is connected. Do not use this release to make student placement, discipline, intervention, staffing, safety, or other consequential decisions. Any future connected agent requires server-side authorization, data minimization, audit logging, human approval for consequential actions, and appropriate district review.

Validation
- `npm test`: 68 passed, 0 failed.
- Inline application JavaScript syntax: passed.
- ZIP integrity: passed.
- Live PostgreSQL, OIDC, browser end-to-end, and external integration tests: not performed.

Run
1. Install dependencies with `npm install`.
2. Configure environment variables using `.env.example`.
3. Apply database migrations only against a reviewed PostgreSQL environment.
4. Start with `npm start`.

EduOS District Edition 32.0.1 — Quality Update

This is a focused improvement to the existing Phase 32.0 release, not a new feature phase.

Changes:
1. Student 360 no longer returns the internal support_plan field in family-visible case responses.
2. Opening Student 360 from Intervention Cases preserves the workspace tabs and provides a close control.
3. Added regression tests for privacy and navigation behavior.

Validation:
- 52 automated Node tests passed; 0 failed.
- src/server.js and public/api-bridge.js syntax checks passed.
- Live PostgreSQL/RLS, live OIDC, and browser end-to-end checks were not run.

See docs/VALIDATION-32.0.md for scope and limitations.

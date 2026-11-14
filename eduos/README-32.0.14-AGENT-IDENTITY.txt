EduOS District Edition 32.0.14 — Agent Identity System

What changed
- Added four original, editable SVG identity illustrations for Christie AI, Helios, Vulcan and Aurora.
- Kept each visual grounded in the existing agent roles already defined in the application:
  - Christie AI — Universal Intelligence Interface / district coordination.
  - Helios — AI Infrastructure.
  - Vulcan — DevOps & Platform Operations.
  - Aurora — Observability & Monitoring.
- Applied a shared visual language: restrained geometric cores, orbit/ring motifs, consistent framing and role-specific accent colors.
- Added subtle vector motion with a static reduced-motion presentation for users who request reduced motion.
- Added descriptive SVG titles/descriptions and HTML alternative text.
- Integrated the full-size artwork into the AI Agents workspace and compact versions into the AI command responsibilities panel.
- Preserved the local deterministic agent contracts, orchestration and disclosure boundaries.
- Updated package version and release assertions to 32.0.14.
- Added automated coverage for the four assets, accessibility metadata, reduced-motion rules and UI attachment.

Standalone application
- `demo/eduos-district-edition-phase32.0.14-standalone.html` embeds the project diagrams, persona illustration and four agent illustrations.
- The standalone snapshot omits the authenticated API bridge and runs as a local synthetic-data demonstration. Use the server-backed public/index.html with the API bridge for authenticated API workflows.

Agent and data boundaries
- These are identity illustrations, not screenshots of deployed agents.
- The agents remain deterministic local demonstrations. They do not call an LLM, access live systems, run commands, deploy software, or make decisions.
- Existing synthetic data and governance disclosures are retained. No student data was added.
- No external companies, customer logos, district endorsements, or third-party integrations were introduced.

Validation summary
- Focused tests: see `docs/VALIDATION-32.0.14.md`.
- Full test suite remains partially blocked by missing `cookie` and `jose` packages in this execution environment; failures are reported, not hidden.
- Source and standalone inline JavaScript syntax checks passed.
- SVG XML parsing passed.
- Browser visual regression and live PostgreSQL/OIDC integration tests were not run.

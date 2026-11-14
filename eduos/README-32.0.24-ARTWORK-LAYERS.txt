EduOS District Edition 32.0.24 — Expanded Artwork Layers
==========================================================

This release follows the project's visual-artwork priority.

New original SVG layers
-----------------------
- eduos-campus-systems-cutaway.svg — isometric campus systems cutaway with
  learning wing, student services, campus operations and infrastructure.
- eduos-learning-evidence-flow.svg — teacher planning, pupil learning,
  evidence, support and family connection pathway.
- eduos-platform-layer-stack.svg — experience, education services, shared
  records/governance, infrastructure and observability layers.

Integration
-----------
The new artwork suite is integrated into the shared persona home composition
and appears alongside the existing command-center and operating-model artwork.
It uses the existing EduOS navy, blue, amber, teal and green visual language.
All previous 15 SVG/PNG project artwork assets are retained.

The SVGs include descriptive titles and accessible descriptions. They are
conceptual explanatory visuals, not live telemetry, surveyed building plans,
automated decisions, or verified deployed integrations.

Validation
----------
- New artwork regression tests: 4 passed.
- SVG XML parsing: 15 passed.
- Inline JavaScript syntax checks: 2 passed.
- Full suite: 121 passed, 14 failed. The failures include dependency-load
  failures because `pg` is not installed in this execution environment and
  additional dependent integration test failures. No claim of full-suite pass.
- No browser screenshot/visual regression was run.

The source package retains the previous deployment hardening changes from
32.0.23. Docker/Caddy runtime behavior remains unverified in this environment.

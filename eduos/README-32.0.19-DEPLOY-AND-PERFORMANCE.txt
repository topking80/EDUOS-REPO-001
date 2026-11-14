EduOS District Edition 32.0.19 — Deployment + database performance (merged)

Merges the deployment automation and database performance work into the
32.0.18 immersive-campus baseline. All 32.0.13–32.0.18 artwork and graphics
(public/assets SVGs, architecture PNGs, campus scenes, agent portraits) are
preserved unchanged.

Added (backend/ops only; no UI, artwork, policy, RLS or auth change)
- Dockerfile (node:22-alpine, production deps only, non-root, /health
  HEALTHCHECK). COPY public ./public ships the public/assets artwork in the image.
- docker-compose.yml (Postgres 16 + one-shot migrate + app, health-gated).
- .dockerignore (excludes tests, docs, demo and local env — NOT public/assets).
- db/005_performance_indexes.sql: attendance_events indexes
  (district_id,event_date DESC) and (district_id,student_id,event_date DESC),
  registered in src/migrate.js. Turns the attendance register and Student 360
  attendance history from sequential scans into bounded index scans.
- Connection pool size configurable via DATABASE_POOL_MAX (default 20).

Validation
- npm test: 124 passed / 0 failed (unchanged).
- docker compose config: VALID.
- Migration 005 applies cleanly; measured ~18x faster attendance register on a
  5,000-student / 60,000-event dataset (23ms seq scan+sort -> 1.3ms index scan).

Artwork
- No asset was modified, moved or removed. public/assets is intact and ships in
  the Docker image.

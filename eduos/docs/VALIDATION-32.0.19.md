# EduOS 32.0.19 Validation — Deployment + performance merged into 32.0.18

## Merge summary
- Base: 32.0.18 (immersive campus explorer + all artwork).
- Added: Dockerfile, docker-compose.yml, .dockerignore, db/005_performance_indexes.sql
  (registered in migrate.js), configurable DATABASE_POOL_MAX.
- Preserved: every public/assets graphic (16 SVG/PNG) and the Interactive Campus.

## Validation
- npm test: 124 passed / 0 failed.
- docker compose config: VALID.
- 005 migration applies; attendance register ~18x faster (EXPLAIN ANALYZE).
- Artwork inventory unchanged (public/assets intact; shipped in the image).

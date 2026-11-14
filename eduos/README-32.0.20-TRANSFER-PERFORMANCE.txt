EduOS District Edition 32.0.20 — Transfer performance & efficiency

Backend efficiency pass focused on how much the server sends over the wire.
No UI, artwork, policy, RLS or auth change.

Added
- Response compression (gzip) via the `compression` middleware. Applies to
  text responses: the HTML app shell, api-bridge.js, JSON API payloads and the
  SVG artwork. Already-compressed binaries (PNG) are not re-compressed.
- Static caching headers: public/assets (SVG/PNG/JS/CSS) now send
  Cache-Control: public, max-age=604800 (7 days) with ETag revalidation; HTML
  sends Cache-Control: no-cache so the app shell is always revalidated.

Measured (gzip -9; on-wire sizes match within a few bytes)
- index.html         267,241 ->  70,212 bytes  (-74%)
- api-bridge.js       34,080 ->   9,703 bytes  (-72%)
- SVG artwork         ~-64% to -66% each
- All text assets    334,524 ->  93,263 bytes  (-72% total)
- PNG artwork: cached (7 days) but not gzipped (already compressed).

Effect
- First load transfers ~72% less text; repeat loads of artwork/scripts come
  from the browser cache (7-day max-age + ETag).
- JSON API responses are also gzipped, reducing bandwidth for record-heavy
  endpoints (student lists, audit, Student 360).

Validation
- npm test: 124 passed / 0 failed.
- node --check src/server.js: passed.
- Verified live: Content-Encoding: gzip on HTML/SVG/JSON; Cache-Control present;
  PNG served uncompressed with cache header.

Dependency
- Adds `compression` (^1.7.5). Run npm install before starting.

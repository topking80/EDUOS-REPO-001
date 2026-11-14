# EduOS 32.0.20 Validation — Transfer performance

## Change
- Added gzip response compression (compression middleware).
- Static assets: Cache-Control public max-age=604800 + ETag; HTML no-cache.

## Measured
| asset | before | after (gzip) | saved |
|---|---|---|---|
| index.html | 267,241 | 70,212 | 74% |
| api-bridge.js | 34,080 | 9,703 | 72% |
| SVG artwork | — | — | ~64–66% |
| all text assets | 334,524 | 93,263 | 72% |

PNG artwork: cached (7 days), not re-compressed.

## Validation
- npm test: 124 passed / 0 failed.
- node --check: passed.
- Live headers verified (Content-Encoding gzip on text; Cache-Control on assets).

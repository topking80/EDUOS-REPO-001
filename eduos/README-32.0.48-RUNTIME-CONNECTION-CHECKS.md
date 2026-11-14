# EduOS 32.0.48 — Runtime Connection Checks

This maintenance release advances the connection-integrity work with a local HTTP smoke test of the packaged frontend assets and a regression assertion for the six-stage Vision Studio journey.

## Verified
- Automated Node test suite.
- Static HTTP GET requests against the packaged `public/` directory for `/`, `/index.html`, `/api-bridge.js`, `/eduos-vision.html`, `/eduos-vision.css`, and `/eduos-vision.js`; each returned HTTP 200.
- Literal local HTML asset/link resolution.
- JavaScript syntax checks in `public/` and `src/`.
- ZIP integrity after packaging.
- Release version metadata consistency.

## Not verified
The smoke test served the static frontend using a local HTTP file server. It did not start the Express application because required database and OIDC environment configuration and a live PostgreSQL service were not provided. Therefore authenticated API calls, database migrations, OIDC callback, live webhook delivery, and end-to-end role navigation are not certified by this release.

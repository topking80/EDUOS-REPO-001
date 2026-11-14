# Validation — Phase 31.1 Integrated

## Source inspected
- Uploaded archive contains a standalone HTML file and README; no backend
  source or test suite was included.
- The HTML contains one inline application script and uses localStorage for
  synthetic demonstration records.
- The supplied README describes cache invalidation and algorithmic improvements
  to district aggregates, enrollment bars, attendance lookups and work-item
  construction. Its timing table is supplied evidence, not an independently
  reproduced benchmark in this integration pass.

## Integration
- Promoted the supplied Phase 31.1 HTML to `public/index.html`.
- Added the existing authenticated `/api-bridge.js` script at the final body
  close, preserving the uploaded application script.
- Preserved the exact standalone uploaded HTML under `demo/`.
- Retained Phase 28 server, API, migrations and authorization code.

## Checks
- Node syntax check for all JavaScript source files and integrated inline app.
- Source-contract tests for API bridge placement, Phase 28 access-request and
  grant routes, permission boundaries, RLS migration registration and Phase 31.1
  optimization markers.
- ZIP integrity check.

## Not run / not claimed
- No live PostgreSQL server/client was available; migrations and RLS were not
  executed against PostgreSQL.
- No OIDC provider credentials were configured; live sign-in was not tested.
- Full browser end-to-end interaction was not run.
- Local demo data is not synchronized with authenticated server records.
- Supplied performance timings were not independently reproduced here.

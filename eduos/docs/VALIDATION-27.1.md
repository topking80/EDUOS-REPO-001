# Validation — EduOS 27.1

## Automated checks
- Inherited Phase 26.1 test suite plus Phase 27.1 integration-boundary tests.
- Phase 27 HTML includes one API bridge script at the final document body.
- Server policy remains independent from browser localStorage grants.
- JavaScript syntax checks are run for server and bridge files; inline application
  script syntax is extracted and checked separately.
- ZIP integrity is checked after packaging.

## Not completed / not claimed
- No live PostgreSQL service was available for migration or row-level-security
  integration testing.
- No OIDC provider was configured for a live sign-in test.
- No full browser end-to-end test is claimed for this integrated package.
- Phase 27 local access grants remain browser-only and do not authorize server APIs.

# Code Improvement Report — 37.4.0

## Fix
Corrected webhook retry classification. Resolver outages (`EAI_AGAIN`, DNS timeout, temporary resolver failure) now enter the transient retry path instead of being treated as a permanent security block. DNS answers that violate address policy remain fail-closed and are not retried or sent.

## Regression tests
- First DNS lookup fails transiently; second lookup succeeds and delivery proceeds.
- A private address remains blocked, with no network send.
- Existing signature, SSRF, redirect, response truncation, outbox and connection-integrity tests continue to pass.

## Results
31 focused tests passed, 0 failed. No full-suite or live infrastructure validation was performed for this patch.

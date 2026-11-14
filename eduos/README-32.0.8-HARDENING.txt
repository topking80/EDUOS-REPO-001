# EduOS 32.0.7 → security hardening pass

Applies the defense-in-depth items from the independent review. These are not
fixes for exploitable bugs (none were found); they are hardening. Behavior is
preserved — verified below.

## 1. Constant-time secret comparison  (APPLIED — code change)
`src/auth.js` compared secrets with `!==`, which can leak match position via
early-exit timing. Replaced with a constant-time helper:

    function safeEqual(a, b) {
      if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
      return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
    }

Used in two places:
- `requireCsrf`: `safeEqual(sha256(supplied), req.actor.csrfTokenHash)` (plus a
  null-guard on the stored hash).
- `completeLogin`: `safeEqual(stateCookie, state)` for the OIDC browser binding.

One source-inspection test that pinned the old literal (`stateCookie !== state`)
was updated to assert the hardened form, keeping its intent (the callback still
binds the state cookie). See `hardening-32.0.8.patch`.

## 2. OIDC `pending` state store  (NO CHANGE — already adequately mitigated)
The in-memory Map is bounded in practice: `/auth/login` is already rate-limited
(30 / 15 min) and expired entries are pruned on each login, so it cannot grow
unboundedly on a single instance. A Map is still per-instance, so a MULTI-
INSTANCE deployment behind a load balancer needs a shared store (Redis). That is
an infrastructure decision and a dependency; it was intentionally NOT added here.
Recommendation: move `pending` behind a small async interface (get/set/delete)
so Redis can be swapped in without touching the flow, when you deploy >1 instance.

## 3. `email_verified` enforcement  (NO CHANGE — already implemented)
`verifyIdToken` already requires `payload.email_verified === true`. This is the
hardened state. The only action is operational: confirm your production IdP
actually emits this claim, or logins will (correctly) be rejected.

## Verification (behavior unchanged)
- `node --check src/auth.js`: passed.
- `npm test`: 81 passed / 0 failed (with the updated assertion).
- Live OIDC end-to-end (mock IdP + live PostgreSQL), 16/16 passed — identical to
  pre-hardening: valid CSRF -> 201, missing CSRF -> 403, tampered state -> 400,
  full login/logout intact.

## Optional, deliberately NOT applied (your call)
- A general rate limiter on `/api/*` (only `/auth/*` is limited today). Useful,
  but it changes runtime behavior and could throttle legitimate bursts — left
  for you to decide thresholds.
- `__Host-` session-cookie prefix in production (anti cookie-tossing). Requires
  a cookie rename + secure + path=/ and is a behavioral change.

## How to apply
From the `eduos-phase27.1` directory:  `git apply hardening-32.0.8.patch`
(or drop in the included `auth.hardened.js` as `src/auth.js`).

-- Native mobile app sign-in (RFC 8252: OAuth for native apps).
--
-- The Flutter app can't use the browser's session cookie, and district
-- identity providers block sign-in inside embedded WebViews. So the app opens
-- the system browser to /auth/login?next=native with a PKCE challenge of its
-- own. After the usual district OIDC sign-in, the server redirects to the
-- app's registered redirect URI with a single-use handoff code. The app
-- redeems code + verifier at POST /auth/native/token for a session token,
-- which it sends as "Authorization: Bearer". Sessions are the same rows as
-- browser sessions (same TTL, idle timeout, revocation and logout).
--
-- Disabled unless NATIVE_APP_REDIRECT_URIS is configured.

ALTER TABLE oidc_pending_logins DROP CONSTRAINT IF EXISTS oidc_pending_logins_return_path_check;
ALTER TABLE oidc_pending_logins ADD CONSTRAINT oidc_pending_logins_return_path_check
  CHECK (return_path IN ('/', '/app/', 'native'));
ALTER TABLE oidc_pending_logins
  ADD COLUMN app_challenge text CHECK (app_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  ADD COLUMN app_redirect text CHECK (length(app_redirect) <= 200),
  ADD CONSTRAINT oidc_pending_native_complete CHECK (
    (return_path = 'native') = (app_challenge IS NOT NULL AND app_redirect IS NOT NULL));

-- One row per completed native sign-in, waiting (at most 60 s) for the app to
-- redeem it. Holds no session secret: the session is created at redemption.
CREATE TABLE native_login_handoffs (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  app_challenge text NOT NULL CHECK (app_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid REFERENCES schools(id) ON DELETE CASCADE,
  role text NOT NULL,
  verified_email text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX native_login_handoffs_expiry ON native_login_handoffs(expires_at);

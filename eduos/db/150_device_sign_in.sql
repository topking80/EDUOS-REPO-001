-- Device sign-in (RFC 8628 device authorization grant) for screens that can't
-- run a browser sign-in: Android TV / Google TV, Fire TV, Roku, and the
-- Windows desktop app (whose browser can't return to an org.eduos.app:
-- redirect, and the server refuses loopback redirects).
--
-- The device asks for a code (POST /auth/device/code) and shows a short user
-- code. The person approves it in the EduOS app or website they are already
-- signed in to (POST /api/device-sign-in/approve). The device polls
-- POST /auth/device/token and, once approved, gets a bearer session.
--
-- Nothing secret is stored: only SHA-256 hashes of the device code and the
-- user code. A request lasts 10 minutes and is single-use. The approval
-- records the approving membership (not a copy of its district/school/role),
-- so redemption re-checks that the membership is still active.
--
-- Numbered 150 to stay clear of the Time Capsule (132/134) and donations
-- (135+) branches; renumber at merge time if needed.
--
-- Disabled unless DEVICE_SIGN_IN_ENABLED=true.

-- Signing in from the /device/ approval page returns there afterwards.
ALTER TABLE oidc_pending_logins DROP CONSTRAINT IF EXISTS oidc_pending_logins_return_path_check;
ALTER TABLE oidc_pending_logins ADD CONSTRAINT oidc_pending_logins_return_path_check
  CHECK (return_path IN ('/', '/app/', '/device/', 'native'));

ALTER TABLE sessions ADD COLUMN client_kind text
  CHECK (client_kind IS NULL OR client_kind IN ('android_tv', 'fire_tv', 'roku', 'windows'));
COMMENT ON COLUMN sessions.client_kind IS
  'Set for sessions opened by device sign-in. TV and Roku sessions are read-only (see src/device-sign-in.js).';

CREATE TABLE device_sign_in_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_hash text NOT NULL UNIQUE CHECK (device_code_hash ~ '^[a-f0-9]{64}$'),
  user_code_hash text NOT NULL UNIQUE CHECK (user_code_hash ~ '^[a-f0-9]{64}$'),
  client_kind text NOT NULL CHECK (client_kind IN ('android_tv', 'fire_tv', 'roku', 'windows')),
  device_label text CHECK (device_label IS NULL OR length(device_label) BETWEEN 1 AND 60),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  membership_id uuid REFERENCES memberships(id) ON DELETE CASCADE,
  verified_email text CHECK (verified_email IS NULL OR length(verified_email) <= 320),
  decided_at timestamptz,
  last_polled_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_sign_in_approved_complete CHECK (
    (status = 'approved') = (user_id IS NOT NULL AND membership_id IS NOT NULL)),
  CONSTRAINT device_sign_in_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX device_sign_in_requests_expiry ON device_sign_in_requests(expires_at);

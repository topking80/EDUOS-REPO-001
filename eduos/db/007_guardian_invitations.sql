-- Phase 32.0.35: one-time, email-bound guardian relationship invitations.
CREATE TABLE guardian_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  invited_by uuid NOT NULL,
  invited_email text NOT NULL CHECK(length(invited_email) BETWEEN 3 AND 320),
  relationship text NOT NULL CHECK(relationship IN ('parent','guardian')),
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  expires_at timestamptz NOT NULL,
  accepted_by uuid,
  accepted_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,invited_by) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,accepted_by) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,revoked_by) REFERENCES memberships(district_id,user_id),
  CHECK(expires_at > created_at),
  CHECK((status='accepted' AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL) OR status<>'accepted'),
  CHECK((status='revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL) OR status<>'revoked')
);
CREATE INDEX guardian_invites_scope ON guardian_invitations(district_id,school_id,status,created_at DESC);
CREATE INDEX guardian_invites_email ON guardian_invitations(district_id,lower(invited_email),status);
ALTER TABLE guardian_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guardian_invitations
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

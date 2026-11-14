-- Phase 28: server-backed access requests and additive, expiring grants.
CREATE TABLE access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  requester_user_id uuid NOT NULL,
  requester_role text NOT NULL CHECK(requester_role IN ('superintendent','principal','teacher')),
  resource text NOT NULL,
  action text NOT NULL,
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 20 AND 1000),
  school_id uuid,
  requested_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','revoked')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,requester_user_id) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  FOREIGN KEY(district_id,reviewed_by) REFERENCES memberships(district_id,user_id),
  CHECK(requested_expires_at > created_at),
  CHECK((status='pending' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
        (status<>'pending' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX access_requests_district_status ON access_requests(district_id,status,created_at DESC);
CREATE INDEX access_requests_requester ON access_requests(district_id,requester_user_id,created_at DESC);

CREATE TABLE permission_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL,
  granted_by uuid NOT NULL,
  resource text NOT NULL,
  action text NOT NULL,
  school_id uuid,
  source_request_id uuid NOT NULL UNIQUE REFERENCES access_requests(id),
  starts_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,user_id) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,granted_by) REFERENCES memberships(district_id,user_id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  CHECK(expires_at > starts_at)
);
CREATE INDEX permission_grants_lookup ON permission_grants(district_id,user_id,resource,action,expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_requests
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

ALTER TABLE permission_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON permission_grants
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

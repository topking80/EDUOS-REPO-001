-- EduOS 37.6.0 (candidate): Credentials Wallet.
-- Learners and their guardians export EDAL-recorded credentials as signed
-- W3C Verifiable Credentials and control who can see them through share links
-- they can revoke. The private signing keys are never stored here: they are
-- derived per school from WALLET_ISSUER_SECRET by the API (src/wallet/vc.js).
-- Numbered 061: 051-057 and 060 are clubs & sports (#47), 058 is the district
-- AI privacy controls (#48), 059 Leo/Edison; the 37.6 branches are 061-064.
-- src/migrate.js applies every numbered file after 050 in name order.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='credentials'::regclass AND conname='credentials_district_id_key') THEN
    ALTER TABLE credentials ADD CONSTRAINT credentials_district_id_key UNIQUE(district_id,id);
  END IF;
END $$;

CREATE TABLE wallet_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  credential_id uuid NOT NULL,
  student_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_role text NOT NULL CHECK(created_role IN ('pupil','parent')),
  -- Only the SHA-256 of the share token is kept; the token is shown once.
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),
  name_display text NOT NULL DEFAULT 'initials' CHECK(name_display IN ('initials','full','none')),
  vc_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_by uuid REFERENCES users(id),
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(expires_at > created_at AND expires_at <= created_at + interval '366 days'),
  FOREIGN KEY(district_id,credential_id) REFERENCES credentials(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id)
);
CREATE INDEX wallet_shares_student ON wallet_shares(district_id,student_id,created_at DESC);
CREATE INDEX wallet_shares_credential ON wallet_shares(district_id,credential_id);

ALTER TABLE wallet_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_shares FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON wallet_shares
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
-- The learner and their linked guardians only. Staff see nothing here: sharing
-- is the holder's decision (FERPA: the family controls disclosure).
CREATE POLICY scope_read ON wallet_shares AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_linked_student(student_id));
CREATE POLICY scope_insert ON wallet_shares AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_is_linked_student(student_id) AND created_by=eduos_ctx_user() AND created_role=eduos_ctx_role()));
CREATE POLICY scope_update ON wallet_shares AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_linked_student(student_id))
  WITH CHECK (eduos_is_table_owner() OR eduos_is_linked_student(student_id));

-- Export inputs for the holder (a pupil or guardian linked to the learner only).
CREATE FUNCTION eduos_wallet_export_inputs(p_credential uuid) RETURNS TABLE(credential_id uuid, school_id uuid, school_name text, student_id uuid,
  learner_name text, kind text, title text, description text, issued_at timestamptz, revoked boolean, edal_entry_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.school_id, sc.name, c.student_id, s.display_name, c.kind, c.title, c.description, c.issued_at, c.revoked_at IS NOT NULL, e.entry_hash
    FROM credentials c JOIN students s ON s.id=c.student_id AND s.district_id=c.district_id
    JOIN schools sc ON sc.id=c.school_id AND sc.district_id=c.district_id
    LEFT JOIN edal_entries e ON e.id=c.edal_entry_id AND e.district_id=c.district_id
   WHERE c.id=p_credential AND c.district_id=eduos_ctx_district() AND eduos_is_linked_student(c.student_id)
$$;

-- Holder's credential list (learner and guardians), without widening the
-- credentials read policy.
CREATE FUNCTION eduos_wallet_credentials() RETURNS TABLE(id uuid, kind text, title text, description text, issued_at timestamptz,
  revoked boolean, student_id uuid, learner_name text, school_name text, on_ledger boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.kind, c.title, c.description, c.issued_at, c.revoked_at IS NOT NULL, c.student_id, s.display_name, sc.name, c.edal_entry_id IS NOT NULL
    FROM credentials c JOIN students s ON s.id=c.student_id AND s.district_id=c.district_id
    JOIN schools sc ON sc.id=c.school_id AND sc.district_id=c.district_id
   WHERE c.district_id=eduos_ctx_district() AND eduos_is_linked_student(c.student_id)
   ORDER BY c.issued_at DESC
$$;

-- Public verification (no session): minimum fields only; each view is counted
-- so the holder can see that a link was used.
CREATE FUNCTION eduos_wallet_share_lookup(p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s wallet_shares; c credentials; sch text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  SELECT * INTO s FROM wallet_shares WHERE token_hash=p_token_hash AND district_id=eduos_ctx_district();
  IF s.id IS NULL THEN RETURN NULL; END IF;
  IF s.revoked_at IS NOT NULL OR s.expires_at < now() THEN
    RETURN jsonb_build_object('state', CASE WHEN s.revoked_at IS NOT NULL THEN 'share_revoked' ELSE 'share_expired' END);
  END IF;
  SELECT * INTO c FROM credentials WHERE id=s.credential_id AND district_id=s.district_id;
  SELECT name INTO sch FROM schools WHERE id=s.school_id AND district_id=s.district_id;
  UPDATE wallet_shares SET view_count=view_count+1, last_viewed_at=now() WHERE id=s.id;
  RETURN jsonb_build_object('state','ok','credential',s.vc_json,'revoked', c.id IS NULL OR c.revoked_at IS NOT NULL,
    'school', sch, 'schoolId', s.school_id, 'nameDisplay', s.name_display, 'expiresAt', s.expires_at);
END; $$;

-- Is this EduOS credential id still valid (for a pasted credential)? Returns
-- only the status and the issuing school.
CREATE FUNCTION eduos_wallet_credential_status(p_credential uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('status', CASE WHEN c.id IS NULL THEN 'unknown' WHEN c.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END,
                            'schoolId', c.school_id, 'school', s.name)
    FROM (SELECT 1) one LEFT JOIN credentials c ON c.id=p_credential AND c.district_id=eduos_ctx_district()
    LEFT JOIN schools s ON s.id=c.school_id AND s.district_id=c.district_id
$$;

-- FERPA purge: share links go before the credentials they point at. Chained
-- under a unique name so it composes with other 37.6 candidates in any order.
ALTER FUNCTION eduos_purge_student(uuid) RENAME TO eduos_purge_student_pre_wallet;
CREATE FUNCTION eduos_purge_student(p_student uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := nullif(current_setting('app.district_id', true), '')::uuid; n int; rest jsonb;
BEGIN
  IF d IS NULL THEN RAISE EXCEPTION 'app.district_id is required'; END IF;
  DELETE FROM wallet_shares WHERE student_id=p_student AND district_id=d; GET DIAGNOSTICS n = ROW_COUNT;
  rest := eduos_purge_student_pre_wallet(p_student);
  IF rest IS NULL THEN RETURN NULL; END IF;
  RETURN rest || jsonb_build_object('wallet_shares', n);
END; $$;
REVOKE ALL ON FUNCTION eduos_purge_student(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_purge_student_pre_wallet(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION eduos_wallet_export_inputs(uuid), eduos_wallet_credentials(), eduos_wallet_share_lookup(text), eduos_wallet_credential_status(uuid) FROM PUBLIC;

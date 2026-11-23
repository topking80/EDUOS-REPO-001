-- TEACH-05: a teacher's portable profile.
--
-- Teachers own their work and take it with them, to another school or to any
-- EduOS district:
--   * A package is a copy of what the teacher wrote (units and lessons in their
--     courses, coaching plans) plus their self-reported licenses. It never holds
--     student information: no rosters, grades or submissions, and anything that
--     may name a student is left out until the teacher edits it. The package's
--     content is hashed and, when the deployment has a key, signed.
--   * The school keeps its copy, unless the teacher holds the copyright or a
--     patent for that work: a claim, with evidence, that the school's principal
--     or the superintendent reviews. Nothing is removed automatically; leaders
--     see which works they don't keep when the teacher leaves.
--   * At a new district the teacher brings the package in; the district reviews
--     it (the previous district's approvals travel with each item, for
--     context). Approved items become the teacher's library there, to copy
--     into their courses.

CREATE TABLE teacher_work_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  item_kind text NOT NULL CHECK (item_kind IN ('unit','lesson','coaching_plan')),
  item_id uuid NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  claim_type text NOT NULL CHECK (claim_type IN ('copyright','patent')),
  registration text CHECK (registration IS NULL OR length(btrim(registration)) BETWEEN 1 AND 80),
  evidence_url text CHECK (evidence_url IS NULL OR (evidence_url ~ '^https://\S+$' AND length(evidence_url) <= 500)),
  statement text NOT NULL CHECK (length(btrim(statement)) BETWEEN 10 AND 1000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','withdrawn')),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- No claim without evidence; no decision without a reviewer (who isn't the claimant).
  CHECK (registration IS NOT NULL OR evidence_url IS NOT NULL),
  CHECK ((status IN ('approved','rejected')) = (reviewed_by IS NOT NULL)),
  CHECK (reviewed_by IS NULL OR reviewed_by <> owner_user_id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX teacher_work_claims_open ON teacher_work_claims(item_kind, item_id) WHERE status IN ('pending','approved');

-- Packages belong to the teacher, not to a district: they follow the teacher
-- into any district on this EduOS (row-level security by owner).
CREATE TABLE portfolio_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  issued_by_district_id uuid NOT NULL REFERENCES districts(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object' AND octet_length(manifest::text) <= 5000000),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  signature text CHECK (signature IS NULL OR length(signature) <= 200),
  signer_public_key text CHECK (signer_public_key IS NULL OR length(signer_public_key) <= 200),
  item_count integer NOT NULL CHECK (item_count >= 0),
  withdrawn_at timestamptz
);
CREATE INDEX portfolio_packages_owner ON portfolio_packages(owner_user_id, issued_at DESC);
ALTER TABLE portfolio_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_only ON portfolio_packages USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user())
  WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user() AND issued_by_district_id = eduos_ctx_district()));

CREATE TABLE portfolio_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  owner_user_id uuid NOT NULL REFERENCES users(id),
  package_id uuid NOT NULL REFERENCES portfolio_packages(id),
  package_sha256 text NOT NULL,
  from_district text NOT NULL,
  signed boolean NOT NULL,
  items jsonb NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  licenses jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(licenses) = 'array'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','reviewed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 500),
  CHECK (reviewed_by IS NULL OR reviewed_by <> owner_user_id),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX portfolio_imports_once ON portfolio_imports(district_id, package_id);

CREATE TABLE teacher_library_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  import_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('unit','lesson','coaching_plan')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 160),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND octet_length(body::text) <= 500000),
  origin text NOT NULL,
  prior_approval jsonb,
  rights jsonb,
  approved_by uuid NOT NULL REFERENCES users(id),
  approved_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (district_id, import_id) REFERENCES portfolio_imports(district_id, id),
  UNIQUE (district_id, id)
);
CREATE INDEX teacher_library_items_owner ON teacher_library_items(district_id, owner_user_id) WHERE archived_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teacher_work_claims','portfolio_imports','teacher_library_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Reviewers: the superintendent, or the principal of the teacher's school.
CREATE FUNCTION eduos_portfolio_reviewer(p_school uuid, p_owner uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p_owner IS DISTINCT FROM eduos_ctx_user() AND (coalesce(eduos_ctx_role(), '') = 'superintendent'
      OR (coalesce(eduos_ctx_role(), '') = 'principal' AND p_school IS NOT NULL AND p_school = eduos_ctx_school()))
$$;

CREATE POLICY scope_read ON teacher_work_claims AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user()
  OR eduos_portfolio_reviewer(school_id, owner_user_id));
CREATE POLICY scope_insert ON teacher_work_claims AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user() AND status = 'pending'));
CREATE POLICY scope_update ON teacher_work_claims AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user() OR eduos_portfolio_reviewer(school_id, owner_user_id))
  WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user() AND status IN ('pending','withdrawn') AND reviewed_by IS NULL)
    OR (eduos_portfolio_reviewer(school_id, owner_user_id) AND status IN ('approved','rejected') AND reviewed_by = eduos_ctx_user()));

CREATE POLICY scope_read ON portfolio_imports AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user() OR eduos_portfolio_reviewer(school_id, owner_user_id));
CREATE POLICY scope_insert ON portfolio_imports AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user() AND status = 'pending'));
CREATE POLICY scope_update ON portfolio_imports AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_portfolio_reviewer(school_id, owner_user_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_portfolio_reviewer(school_id, owner_user_id) AND reviewed_by = eduos_ctx_user()));

CREATE POLICY scope_read ON teacher_library_items AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user()
  OR EXISTS (SELECT 1 FROM portfolio_imports i WHERE i.id = import_id));
-- Created by the reviewer approving an import; the owner archives their own.
CREATE POLICY scope_insert ON teacher_library_items AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (approved_by = eduos_ctx_user()
  AND EXISTS (SELECT 1 FROM portfolio_imports i WHERE i.id = import_id AND i.owner_user_id = teacher_library_items.owner_user_id AND eduos_portfolio_reviewer(i.school_id, i.owner_user_id))));
CREATE POLICY scope_update ON teacher_library_items AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user())
  WITH CHECK (eduos_is_table_owner() OR owner_user_id = eduos_ctx_user());

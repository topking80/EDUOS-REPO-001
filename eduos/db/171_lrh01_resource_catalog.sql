-- LRH-01: the district's digital learning-resource catalog (design:
-- docs/PROJECT-NOMAD-CAPABILITY-EXTRACTION-INTEGRATION-PLAN.md, work item
-- LRH-01; feature doc docs/LEARNING-RESOURCES.md).
--
-- Metadata only, for districts (families and private schools come later):
--   * district catalog managers (the superintendent and district IT) describe
--     a resource: source, licence, language, grades, subjects, type, version,
--     SHA-256 and size; files arrive in LRH-03 (provisioning);
--   * a licence must be reviewed and approved, by someone other than whoever
--     added the resource, before it can be published; the database refuses to
--     publish without an approved licence and a checksum;
--   * the superintendent publishes resources and collections; principals
--     (and vice principals) and librarians choose which published collections
--     their school uses;
--   * teachers, students and families see only published resources in a
--     collection their school chose, within their audience: teacher-only and
--     emergency-staff resources never reach students or families, and a
--     student sees only resources for their grade.
-- No table here holds student records.

CREATE FUNCTION eduos_grade_rank(p text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'pre_k' THEN -1 WHEN 'k' THEN 0 WHEN 'K' THEN 0 ELSE (CASE WHEN p ~ '^[0-9]{1,2}$' THEN p::int END) END
$$;

CREATE TABLE learning_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 2 AND 200),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  resource_type text NOT NULL CHECK (resource_type IN ('reference','pdf','ebook','offline_archive','audio','video','image','map_package','course_package')),
  source_name text NOT NULL CHECK (length(btrim(source_name)) BETWEEN 2 AND 200),
  source_url text NOT NULL CHECK (source_url ~ '^https://[^\s<>"]+$' AND length(source_url) <= 500),
  license_name text NOT NULL CHECK (length(btrim(license_name)) BETWEEN 2 AND 120),
  license_url text CHECK (license_url IS NULL OR (license_url ~ '^https://[^\s<>"]+$' AND length(license_url) <= 500)),
  license_status text NOT NULL DEFAULT 'unreviewed' CHECK (license_status IN ('unreviewed','approved','rejected')),
  license_reviewed_by uuid REFERENCES users(id),
  license_reviewed_at timestamptz,
  license_note text CHECK (license_note IS NULL OR length(btrim(license_note)) BETWEEN 3 AND 1000),
  language text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  grade_min text NOT NULL CHECK (eduos_grade_rank(grade_min) BETWEEN -1 AND 12),
  grade_max text NOT NULL CHECK (eduos_grade_rank(grade_max) BETWEEN -1 AND 12),
  subjects text[] NOT NULL DEFAULT '{}' CHECK (cardinality(subjects) <= 10),
  standards text[] NOT NULL DEFAULT '{}' CHECK (cardinality(standards) <= 30),
  audience text NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone','staff','emergency_staff')),
  version text NOT NULL CHECK (length(btrim(version)) BETWEEN 1 AND 60),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  retired_by uuid REFERENCES users(id),
  retired_at timestamptz,
  retire_reason text CHECK (retire_reason IS NULL OR length(btrim(retire_reason)) BETWEEN 3 AND 300),
  CHECK (eduos_grade_rank(grade_min) <= eduos_grade_rank(grade_max)),
  CHECK ((license_status = 'unreviewed') = (license_reviewed_at IS NULL) AND (license_reviewed_at IS NULL) = (license_reviewed_by IS NULL)),
  CHECK (license_reviewed_by IS NULL OR license_reviewed_by <> created_by),
  -- Nothing is published without an approved licence and a checksum.
  CHECK (status <> 'published' OR (license_status = 'approved' AND sha256 IS NOT NULL AND published_at IS NOT NULL)),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  UNIQUE (district_id, id)
);
CREATE INDEX learning_resources_district ON learning_resources(district_id, status);

CREATE TABLE learning_resource_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  description text CHECK (description IS NULL OR length(description) <= 2000),
  review_by date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users(id),
  published_at timestamptz,
  retired_at timestamptz,
  CHECK (status <> 'published' OR published_at IS NOT NULL),
  CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  UNIQUE (district_id, id)
);

CREATE TABLE learning_resource_collection_items (
  district_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  resource_id uuid NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 1 AND 10000),
  added_by uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, resource_id),
  FOREIGN KEY (district_id, collection_id) REFERENCES learning_resource_collections(district_id, id),
  FOREIGN KEY (district_id, resource_id) REFERENCES learning_resources(district_id, id)
);

CREATE TABLE learning_resource_school_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL,
  school_id uuid NOT NULL,
  collection_id uuid NOT NULL,
  selected_by uuid NOT NULL REFERENCES users(id),
  selected_at timestamptz NOT NULL DEFAULT now(),
  removed_by uuid REFERENCES users(id),
  removed_at timestamptz,
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, collection_id) REFERENCES learning_resource_collections(district_id, id),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE UNIQUE INDEX learning_resource_school_selections_open ON learning_resource_school_selections(school_id, collection_id) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION eduos_lr_manager() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT eduos_ctx_role() IN ('superintendent','it_admin') $$;
CREATE FUNCTION eduos_lr_school_lead() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT eduos_ctx_role() IN ('principal','librarian') AND eduos_ctx_school() IS NOT NULL $$;
-- Grades of the students the signed-in pupil is (a pupil account links to one student).
CREATE FUNCTION eduos_lr_pupil_grade() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT min(eduos_grade_rank(s.grade_level)) FROM student_user_links l JOIN students s ON s.id = l.student_id AND s.district_id = l.district_id
   WHERE l.user_id = eduos_ctx_user() AND l.district_id = eduos_ctx_district() AND l.relationship = 'pupil' AND l.status = 'active'
$$;
-- May the session see this resource?
CREATE FUNCTION eduos_lr_visible(p_resource uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN eduos_lr_manager() THEN EXISTS (SELECT 1 FROM learning_resources r WHERE r.id = p_resource AND r.district_id = eduos_ctx_district())
    ELSE EXISTS (
      SELECT 1 FROM learning_resources r
        JOIN learning_resource_collection_items i ON i.resource_id = r.id
        JOIN learning_resource_collections c ON c.id = i.collection_id AND c.status = 'published'
        JOIN learning_resource_school_selections sel ON sel.collection_id = c.id AND sel.removed_at IS NULL
       WHERE r.id = p_resource AND r.district_id = eduos_ctx_district() AND r.status = 'published'
         AND (eduos_lr_school_lead() AND sel.school_id = eduos_ctx_school()
           OR sel.school_id = eduos_ctx_school() AND (
                (eduos_ctx_role() IN ('principal','teacher','librarian','counselor','nurse','sro','coach') AND r.audience IN ('everyone','staff'))
             OR (eduos_ctx_role() IN ('principal','teacher','librarian','counselor','nurse','sro') AND r.audience = 'emergency_staff')
             OR (eduos_ctx_role() = 'parent' AND r.audience = 'everyone')
             OR (eduos_ctx_role() = 'pupil' AND r.audience = 'everyone'
                 AND coalesce(eduos_lr_pupil_grade() BETWEEN eduos_grade_rank(r.grade_min) AND eduos_grade_rank(r.grade_max), false)))))
  END
$$;

-- ---------------------------------------------------------------- RLS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['learning_resources','learning_resource_collections','learning_resource_collection_items','learning_resource_school_selections'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = eduos_ctx_district())
      WITH CHECK (eduos_is_table_owner() OR district_id = eduos_ctx_district())$p$, t);
  END LOOP;
END $$;
CREATE POLICY resource_read ON learning_resources AS RESTRICTIVE FOR SELECT USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() OR eduos_lr_visible(id) END);
CREATE POLICY resource_write ON learning_resources AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() AND created_by = eduos_ctx_user() AND status = 'draft' END);
CREATE POLICY resource_update ON learning_resources AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() END);
-- Only the superintendent publishes.
CREATE POLICY resource_publish ON learning_resources AS RESTRICTIVE FOR UPDATE
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE status <> 'published' OR eduos_ctx_role() = 'superintendent' END);
CREATE POLICY collection_read ON learning_resource_collections AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() OR (eduos_lr_school_lead() AND status = 'published')
    OR EXISTS (SELECT 1 FROM learning_resource_school_selections s WHERE s.collection_id = learning_resource_collections.id AND s.school_id = eduos_ctx_school() AND s.removed_at IS NULL) END);
CREATE POLICY collection_write ON learning_resource_collections AS RESTRICTIVE FOR INSERT WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() AND created_by = eduos_ctx_user() AND status = 'draft' END);
CREATE POLICY collection_update ON learning_resource_collections AS RESTRICTIVE FOR UPDATE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() END)
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE status <> 'published' OR eduos_ctx_role() = 'superintendent' END);
CREATE POLICY item_read ON learning_resource_collection_items AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE EXISTS (SELECT 1 FROM learning_resource_collections c WHERE c.id = collection_id) END);
CREATE POLICY item_write ON learning_resource_collection_items AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() AND added_by = eduos_ctx_user() END);
CREATE POLICY item_delete ON learning_resource_collection_items AS RESTRICTIVE FOR DELETE USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() END);
CREATE POLICY selection_read ON learning_resource_school_selections AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_manager() OR school_id = eduos_ctx_school() END);
CREATE POLICY selection_write ON learning_resource_school_selections AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_school_lead() AND school_id = eduos_ctx_school() AND selected_by = eduos_ctx_user() END);
CREATE POLICY selection_update ON learning_resource_school_selections AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE eduos_lr_school_lead() AND school_id = eduos_ctx_school() END);

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY['eduos_lr_pupil_grade()','eduos_lr_visible(uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO eduos_app', fn); END IF;
  END LOOP;
END $$;

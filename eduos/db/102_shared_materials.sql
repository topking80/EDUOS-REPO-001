-- TEACH-02: the district's shared materials library. A teacher or principal
-- shares a snapshot of a lesson or unit they manage; colleagues at any school
-- in the district browse it and copy it into their own course as drafts (the
-- school leader still approves a lesson before Christie may use it).
--
-- A snapshot holds curriculum only: titles, objectives, lesson text, standard
-- and primary-source references. Never student data: the API checks the text
-- against the district's student names before sharing (see materials-routes).

CREATE TABLE shared_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('lesson','unit')),
  source_id uuid NOT NULL,                       -- the lesson or unit it was taken from
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 40),
  grade_level text NOT NULL CHECK (length(btrim(grade_level)) BETWEEN 1 AND 4),
  summary text CHECK (summary IS NULL OR length(summary) <= 500),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND length(body::text) <= 200000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status text NOT NULL DEFAULT 'shared' CHECK (status IN ('shared','withdrawn')),
  withdrawn_by uuid REFERENCES users(id),
  withdrawn_at timestamptz,
  withdrawn_reason text CHECK (withdrawn_reason IS NULL OR length(withdrawn_reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL)),
  UNIQUE (district_id, id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id)
);
-- One live share per lesson or unit: sharing again updates it (version + 1).
CREATE UNIQUE INDEX shared_materials_one_live ON shared_materials(district_id, kind, source_id) WHERE status = 'shared';
CREATE INDEX shared_materials_browse ON shared_materials(district_id, status, updated_at DESC);

CREATE TABLE shared_material_copies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  material_id uuid NOT NULL,
  version integer NOT NULL,
  copied_by uuid NOT NULL REFERENCES users(id),
  course_id uuid NOT NULL,
  created_id uuid NOT NULL,                     -- the new lesson or unit
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, material_id) REFERENCES shared_materials(district_id, id),
  FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id)
);
CREATE INDEX shared_material_copies_material ON shared_material_copies(material_id);

-- Attribution on what was copied ("Adapted from …").
ALTER TABLE lessons ADD COLUMN adapted_from uuid;
ALTER TABLE course_units ADD COLUMN adapted_from uuid;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shared_materials','shared_material_copies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Educators in the district browse what is shared; the author and the
-- author's school leaders (and the superintendent) also see withdrawn items.
CREATE POLICY scope_read ON shared_materials AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR (status = 'shared' AND eduos_is_network_educator())
         OR author_user_id = eduos_ctx_user() OR eduos_is_moderator(school_id));
CREATE POLICY scope_insert ON shared_materials AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (author_user_id = eduos_ctx_user() AND school_id = eduos_ctx_school()
    AND eduos_ctx_role() IN ('teacher','principal') AND status = 'shared'));
-- The author updates or withdraws; the school's principal and the
-- superintendent may withdraw (moderation).
CREATE POLICY scope_update ON shared_materials AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR author_user_id = eduos_ctx_user() OR eduos_is_moderator(school_id))
  WITH CHECK (eduos_is_table_owner() OR author_user_id = eduos_ctx_user() OR eduos_is_moderator(school_id));

CREATE POLICY scope_read ON shared_material_copies AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR copied_by = eduos_ctx_user()
         OR EXISTS (SELECT 1 FROM shared_materials m WHERE m.id = material_id AND m.author_user_id = eduos_ctx_user()));
CREATE POLICY scope_insert ON shared_material_copies AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (copied_by = eduos_ctx_user() AND eduos_can_manage_course(course_id)));

-- How many times something was copied (a number only, for everyone who can see it).
CREATE FUNCTION eduos_material_copies(p_material uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::int FROM shared_material_copies c WHERE c.material_id = p_material AND c.district_id = eduos_ctx_district()
$$;

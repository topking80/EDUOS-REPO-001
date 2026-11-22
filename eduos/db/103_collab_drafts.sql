-- TEACH-03: co-writing lessons and units. Colleagues anywhere in the district
-- write a lesson or unit together in a shared draft that lives outside any
-- course (so no course, roster or student is shared). Each editor can copy the
-- draft into their own course or publish it to the library (TEACH-02).
--
-- Saves carry the version the editor started from; the API merges changes to
-- different fields (and different lessons of a unit) and refuses overlapping
-- ones, so nobody's work is overwritten. Every save keeps a revision.

CREATE TABLE collab_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,                        -- where it was started
  kind text NOT NULL CHECK (kind IN ('lesson','unit')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  subject text NOT NULL CHECK (length(btrim(subject)) BETWEEN 1 AND 40),
  grade_level text NOT NULL CHECK (length(btrim(grade_level)) BETWEEN 1 AND 4),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND length(body::text) <= 200000),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (district_id, id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id)
);

CREATE TABLE collab_draft_editors (
  draft_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  added_by uuid NOT NULL REFERENCES users(id),
  added_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  PRIMARY KEY (draft_id, user_id),
  FOREIGN KEY (district_id, draft_id) REFERENCES collab_drafts(district_id, id)
);
CREATE INDEX collab_draft_editors_user ON collab_draft_editors(district_id, user_id) WHERE left_at IS NULL;

CREATE TABLE collab_draft_revisions (
  draft_id uuid NOT NULL,
  district_id uuid NOT NULL REFERENCES districts(id),
  version integer NOT NULL,
  title text NOT NULL,
  body jsonb NOT NULL,
  edited_by uuid NOT NULL REFERENCES users(id),
  edited_at timestamptz NOT NULL DEFAULT now(),
  merged boolean NOT NULL DEFAULT false,          -- saved by merging with someone else's change
  PRIMARY KEY (draft_id, version),
  FOREIGN KEY (district_id, draft_id) REFERENCES collab_drafts(district_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['collab_drafts','collab_draft_editors','collab_draft_revisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

CREATE FUNCTION eduos_is_draft_editor(p_draft uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM collab_draft_editors e WHERE e.draft_id = p_draft AND e.district_id = eduos_ctx_district()
    AND e.user_id = eduos_ctx_user() AND e.left_at IS NULL)
$$;

-- Drafts: editors only (the creator is an editor from the start).
CREATE POLICY scope_read ON collab_drafts AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_draft_editor(id) OR created_by = eduos_ctx_user());
CREATE POLICY scope_insert ON collab_drafts AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (created_by = eduos_ctx_user() AND updated_by = eduos_ctx_user()
    AND school_id = eduos_ctx_school() AND eduos_ctx_role() IN ('teacher','principal')));
CREATE POLICY scope_update ON collab_drafts AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_is_draft_editor(id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_is_draft_editor(id) AND updated_by = eduos_ctx_user()));

-- Editors: editors see who else edits; an editor adds colleagues (the creator
-- adds the first editor, themself); you may leave, a member may re-add someone
-- who left, and nobody removes anyone else.
CREATE POLICY scope_read ON collab_draft_editors AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR eduos_is_draft_editor(draft_id));
CREATE POLICY scope_insert ON collab_draft_editors AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (added_by = eduos_ctx_user() AND eduos_ctx_role() IN ('teacher','principal') AND (eduos_is_draft_editor(draft_id)
    OR EXISTS(SELECT 1 FROM collab_drafts d WHERE d.id = draft_id AND d.created_by = eduos_ctx_user() AND user_id = eduos_ctx_user()))));
CREATE POLICY scope_update ON collab_draft_editors AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR eduos_is_draft_editor(draft_id))
  WITH CHECK (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR left_at IS NULL);

-- Revisions: editors read the history; each save writes one, as its editor.
CREATE POLICY scope_read ON collab_draft_revisions AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_draft_editor(draft_id));
CREATE POLICY scope_insert ON collab_draft_revisions AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (edited_by = eduos_ctx_user() AND eduos_is_draft_editor(draft_id)));

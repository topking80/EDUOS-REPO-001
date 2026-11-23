-- COACH-02: coaching materials. A coach keeps practice plans and playbooks
-- (ordered drills, plays and notes) that belong to them as a person: visible
-- from their teacher profile and any coach profile, and portable with their
-- profile later (TEACH-05). Plans go to the district library alongside
-- lessons (kinds 'practice' and 'playbook'), can be co-written (TEACH-03
-- drafts), and can be attached to a team they coach. No student data: plans
-- name drills, not players, and the library's student-name check applies.

ALTER TABLE shared_materials DROP CONSTRAINT shared_materials_kind_check;
ALTER TABLE shared_materials ADD CONSTRAINT shared_materials_kind_check CHECK (kind IN ('lesson','unit','practice','playbook'));
ALTER TABLE collab_drafts DROP CONSTRAINT collab_drafts_kind_check;
ALTER TABLE collab_drafts ADD CONSTRAINT collab_drafts_kind_check CHECK (kind IN ('lesson','unit','practice','playbook'));

CREATE TABLE coaching_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('practice','playbook')),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  sport text NOT NULL CHECK (length(btrim(sport)) BETWEEN 1 AND 40),
  level text NOT NULL DEFAULT 'All' CHECK (length(btrim(level)) BETWEEN 1 AND 4),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND length(body::text) <= 200000),
  team_id uuid,                                    -- a team (activity) the owner coaches, optional
  adapted_from uuid,                               -- a shared material it was copied from
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (district_id, id)
);
CREATE INDEX coaching_plans_owner ON coaching_plans(district_id, owner_user_id, updated_at DESC);

ALTER TABLE coaching_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE coaching_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON coaching_plans
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
-- The owner, from a teacher, principal or coach profile; nobody else.
CREATE POLICY own_plans ON coaching_plans AS RESTRICTIVE
  USING (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user() AND eduos_ctx_role() IN ('teacher','principal','coach')))
  WITH CHECK (eduos_is_table_owner() OR (owner_user_id = eduos_ctx_user() AND eduos_ctx_role() IN ('teacher','principal','coach')));

-- Coach profiles browse and share coaching kinds in the library (not lessons).
DROP POLICY scope_read ON shared_materials;
CREATE POLICY scope_read ON shared_materials AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR (status = 'shared' AND eduos_is_network_educator())
         OR (status = 'shared' AND kind IN ('practice','playbook') AND eduos_ctx_role() = 'coach')
         OR author_user_id = eduos_ctx_user() OR eduos_is_moderator(school_id));
DROP POLICY scope_insert ON shared_materials;
CREATE POLICY scope_insert ON shared_materials AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (author_user_id = eduos_ctx_user() AND school_id = eduos_ctx_school() AND status = 'shared'
    AND (eduos_ctx_role() IN ('teacher','principal') OR (eduos_ctx_role() = 'coach' AND kind IN ('practice','playbook')))));

-- Copies of coaching kinds go into the coach's own plans, not a course.
ALTER TABLE shared_material_copies ALTER COLUMN course_id DROP NOT NULL;
DROP POLICY scope_insert ON shared_material_copies;
CREATE POLICY scope_insert ON shared_material_copies AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (copied_by = eduos_ctx_user() AND (
    (course_id IS NOT NULL AND eduos_can_manage_course(course_id))
    OR (course_id IS NULL AND EXISTS (SELECT 1 FROM coaching_plans p WHERE p.id = created_id AND p.owner_user_id = eduos_ctx_user())))));

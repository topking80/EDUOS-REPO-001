-- TEACH-04: today's classroom material. A teacher builds a plan for one course
-- (class) on one date: an ordered list of blocks (a lesson or an assignment
-- from that course, instructions, a warm-up question, a timer, a link), each
-- with planned minutes and an optional private note that is never presented.
-- Present mode shows the blocks one at a time (and DEV-03 can send them to a
-- paired classroom display).
--
-- Plans belong to the course: whoever manages it (its teacher, the school's
-- principal) builds and edits them. Students don't read plans here.

CREATE TABLE class_day_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  course_id uuid NOT NULL,
  plan_date date NOT NULL,
  title text CHECK (title IS NULL OR length(title) <= 120),
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blocks) = 'array' AND jsonb_array_length(blocks) <= 30 AND length(blocks::text) <= 100000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, plan_date),
  UNIQUE (district_id, id),
  FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id)
);
CREATE INDEX class_day_plans_date ON class_day_plans(district_id, plan_date);

ALTER TABLE class_day_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_day_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON class_day_plans
  USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
CREATE POLICY scope_read ON class_day_plans AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_manage_course(course_id));
CREATE POLICY scope_insert ON class_day_plans AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id) AND created_by = eduos_ctx_user() AND updated_by = eduos_ctx_user()));
CREATE POLICY scope_update ON class_day_plans AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR eduos_can_manage_course(course_id))
  WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_course(course_id) AND updated_by = eduos_ctx_user()));

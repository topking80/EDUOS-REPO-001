-- 097 (LTI-02): LTI Deep Linking 2.0. A teacher picks content in an approved
-- LTI tool; the tool returns signed resource links, which EduOS places on an
-- assignment. Students open them through the normal governed LTI launch.
--
-- Who can see or remove a link follows the assignment: the same
-- eduos_can_see_assignment / eduos_can_manage_assignment rules the course
-- pages use. Links are never edited in place.
CREATE TABLE lti_content_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  assignment_id uuid NOT NULL,
  app_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  url text NOT NULL CHECK (length(url) BETWEEN 8 AND 2048 AND url ~ '^https?://'),
  custom jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(custom) = 'object' AND octet_length(custom::text) <= 8192),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, assignment_id) REFERENCES assignments(district_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, app_id) REFERENCES apps(district_id, id),
  UNIQUE (district_id, id)
);
CREATE INDEX lti_content_links_assignment ON lti_content_links(district_id, assignment_id);

ALTER TABLE lti_content_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE lti_content_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lti_content_links
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
CREATE POLICY see_assignment ON lti_content_links AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_can_see_assignment(assignment_id));
CREATE POLICY place_on_own_assignment ON lti_content_links AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (eduos_can_manage_assignment(assignment_id)
    AND created_by = nullif(current_setting('app.user_id', true), '')::uuid));
CREATE POLICY remove_from_own_assignment ON lti_content_links AS RESTRICTIVE FOR DELETE
  USING (eduos_is_table_owner() OR eduos_can_manage_assignment(assignment_id));

-- Each Deep Linking request's data token is accepted once.
CREATE TABLE lti_deep_link_returns (
  district_id uuid NOT NULL REFERENCES districts(id),
  data_id uuid NOT NULL,
  app_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (district_id, data_id)
);
ALTER TABLE lti_deep_link_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE lti_deep_link_returns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lti_deep_link_returns
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);

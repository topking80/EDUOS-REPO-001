-- TEACH-01: the district teacher network. Teachers and principals at every
-- school in the district can message each other and keep groups (for example
-- "Grade 4 math") that colleagues find and join. No student data: network
-- threads have no learner, and families and pupils can't take part.
--
-- A network thread keeps the creator's school as its school_id: that school's
-- principal and the superintendent moderate it, as for other threads.

ALTER TABLE comms_threads DROP CONSTRAINT comms_threads_kind_check;
ALTER TABLE comms_threads ADD CONSTRAINT comms_threads_kind_check CHECK (kind IN ('family','staff','network'));
ALTER TABLE comms_threads
  ADD COLUMN discoverable boolean NOT NULL DEFAULT false,
  ADD COLUMN description text CHECK (description IS NULL OR length(description) <= 300),
  ADD CONSTRAINT comms_threads_discoverable_network CHECK (NOT discoverable OR kind = 'network');

-- Leaving a group keeps the row (deletes stay revoked) and ends access.
ALTER TABLE comms_participants ADD COLUMN left_at timestamptz;

CREATE OR REPLACE FUNCTION eduos_is_thread_participant(p_thread uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM comms_participants p WHERE p.thread_id=p_thread AND p.district_id=eduos_ctx_district()
    AND p.user_id=eduos_ctx_user() AND p.left_at IS NULL)
$$;

-- Who belongs to the network: an educator role in this session.
CREATE FUNCTION eduos_is_network_educator() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT eduos_ctx_role() IN ('teacher','principal','superintendent') $$;

-- Open groups are listed to every educator in the district.
DROP POLICY scope_read ON comms_threads;
CREATE POLICY scope_read ON comms_threads AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_thread_participant(id) OR eduos_is_moderator(school_id) OR created_by=eduos_ctx_user()
    OR (kind='network' AND discoverable AND eduos_is_network_educator()));

-- Group members are visible to educators who can see the group.
DROP POLICY scope_read ON comms_participants;
CREATE POLICY scope_read ON comms_participants AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR eduos_is_thread_participant(thread_id)
         OR EXISTS(SELECT 1 FROM comms_threads t WHERE t.id=thread_id AND (t.created_by=eduos_ctx_user() OR eduos_is_moderator(t.school_id)
              OR (t.kind='network' AND t.discoverable AND eduos_is_network_educator()))));

-- Adding people: the creator (as before); in a network thread, any member may
-- add colleagues, and an educator may join an open group themself.
DROP POLICY scope_insert ON comms_participants;
CREATE POLICY scope_insert ON comms_participants AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR EXISTS(SELECT 1 FROM comms_threads t WHERE t.id=thread_id AND (
       t.created_by=eduos_ctx_user()
    OR (t.kind='network' AND eduos_is_network_educator() AND (eduos_is_thread_participant(t.id) OR (t.discoverable AND user_id=eduos_ctx_user()))))));

-- Leaving or rejoining, in network threads only: you may leave or rejoin
-- yourself; a member may re-add someone who left, but never remove anyone.
CREATE POLICY own_membership ON comms_participants AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR (EXISTS(SELECT 1 FROM comms_threads t WHERE t.id=thread_id AND t.kind='network')
         AND (user_id=eduos_ctx_user() OR eduos_is_thread_participant(thread_id))))
  WITH CHECK (eduos_is_table_owner() OR (EXISTS(SELECT 1 FROM comms_threads t WHERE t.id=thread_id AND t.kind='network')
         AND (user_id=eduos_ctx_user() OR left_at IS NULL)));

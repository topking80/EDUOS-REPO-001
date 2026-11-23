-- DEV-03: controlling a room's devices from the teacher's paired device.
--
-- Only the teacher paired with the room now can send a command, only to an
-- approved device in that room that has a key, and only a capability district
-- IT approved for it. Commands wait at most a minute for the device to collect
-- them (a command that arrives late is dropped, not run). The device collects
-- them with its key and reports done or failed.
--
-- Student devices take lock, unlock, open a link and focus mode only. Nothing
-- here can show, capture or stream a student's screen. Commands are kept as
-- the room's history; the school's leaders and IT can read it, nobody edits it.

CREATE TABLE classroom_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  room_id uuid NOT NULL,
  device_id uuid NOT NULL,
  pairing_id uuid NOT NULL,
  issued_by uuid NOT NULL REFERENCES users(id),
  capability text NOT NULL CHECK (capability IN ('show','blank','input','volume','power','lights','lock','unlock','open_link','focus')),
  args jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(args) = 'object' AND octet_length(args::text) <= 1024),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivered','done','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  delivered_at timestamptz,
  finished_at timestamptz,
  result text CHECK (result IS NULL OR length(result) <= 200),
  FOREIGN KEY (district_id, device_id) REFERENCES classroom_devices(district_id, id),
  FOREIGN KEY (district_id, pairing_id) REFERENCES classroom_pairings(district_id, id),
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id)
);
CREATE INDEX classroom_commands_queue ON classroom_commands(device_id, created_at) WHERE status = 'queued';
CREATE INDEX classroom_commands_room ON classroom_commands(district_id, room_id, created_at DESC);

ALTER TABLE classroom_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE classroom_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON classroom_commands
  USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
  WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid);
-- Read: the teacher who sent it; the school's leaders, IT, the superintendent.
-- Write: only the functions below.
CREATE POLICY scope_read ON classroom_commands AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR issued_by = eduos_ctx_user() OR (coalesce(eduos_ctx_role(), '') <> 'teacher' AND eduos_device_scope(school_id)));
CREATE POLICY functions_write ON classroom_commands AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY functions_update ON classroom_commands AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- The paired teacher sends a command. The arguments were checked by the API
-- for the capability; here the rules that grant the command are checked again.
CREATE FUNCTION eduos_classroom_command(p_device uuid, p_capability text, p_args jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE me uuid := eduos_ctx_user(); dist uuid := eduos_ctx_district(); d classroom_devices%ROWTYPE; p classroom_pairings%ROWTYPE; cid uuid;
BEGIN
  IF me IS NULL OR dist IS NULL OR coalesce(eduos_ctx_role(), '') <> 'teacher' THEN RETURN jsonb_build_object('error', 'teachers_only'); END IF;
  SELECT * INTO d FROM classroom_devices WHERE id = p_device AND district_id = dist;
  IF NOT FOUND OR d.school_id IS DISTINCT FROM eduos_ctx_school() THEN RETURN jsonb_build_object('error', 'device_not_found'); END IF;
  IF d.status <> 'approved' OR d.room_id IS NULL OR d.token_hash IS NULL THEN RETURN jsonb_build_object('error', 'device_not_ready'); END IF;
  IF NOT (p_capability = ANY (d.capabilities)) THEN RETURN jsonb_build_object('error', 'not_approved_for_device'); END IF;
  SELECT * INTO p FROM classroom_pairings WHERE room_id = d.room_id AND teacher_user_id = me AND ended_at IS NULL AND expires_at > now()
    ORDER BY paired_at DESC LIMIT 1;
  IF NOT FOUND OR NOT eduos_is_school_teacher(me, d.school_id) THEN RETURN jsonb_build_object('error', 'not_paired'); END IF;
  INSERT INTO classroom_commands(district_id, school_id, room_id, device_id, pairing_id, issued_by, capability, args, expires_at)
    VALUES (dist, d.school_id, d.room_id, d.id, p.id, me, p_capability, coalesce(p_args, '{}'::jsonb), now() + interval '60 seconds') RETURNING id INTO cid;
  RETURN jsonb_build_object('id', cid);
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_command(uuid, text, jsonb) FROM PUBLIC;

-- The device collects its waiting commands (oldest first). Expired ones are
-- marked failed, never delivered. NULL for a bad key.
CREATE FUNCTION eduos_classroom_agent_take(p_device uuid, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d classroom_devices%ROWTYPE; out jsonb;
BEGIN
  IF p_device IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  SELECT * INTO d FROM classroom_devices WHERE id = p_device AND token_hash = p_token_hash AND status = 'approved';
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE classroom_devices SET last_seen_at = now() WHERE id = d.id;
  UPDATE classroom_commands SET status = 'failed', finished_at = now(), result = 'expired before the device collected it'
    WHERE device_id = d.id AND status = 'queued' AND expires_at <= now();
  -- A command whose pairing ended (or whose capability IT has since removed) is dropped too.
  UPDATE classroom_commands c SET status = 'failed', finished_at = now(), result = 'no longer allowed'
    WHERE c.device_id = d.id AND c.status = 'queued' AND (NOT (c.capability = ANY (d.capabilities)) OR c.room_id IS DISTINCT FROM d.room_id
      OR NOT EXISTS (SELECT 1 FROM classroom_pairings p WHERE p.id = c.pairing_id AND p.ended_at IS NULL AND p.expires_at > now()));
  WITH taken AS (
    UPDATE classroom_commands SET status = 'delivered', delivered_at = now()
     WHERE id IN (SELECT id FROM classroom_commands WHERE device_id = d.id AND status = 'queued' ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
    RETURNING id, capability, args, created_at)
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'capability', capability, 'args', args) ORDER BY created_at), '[]'::jsonb) INTO out FROM taken;
  RETURN jsonb_build_object('commands', out);
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_agent_take(uuid, text) FROM PUBLIC;

CREATE FUNCTION eduos_classroom_agent_result(p_device uuid, p_token_hash text, p_command uuid, p_ok boolean, p_message text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_device IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM classroom_devices WHERE id = p_device AND token_hash = p_token_hash AND status = 'approved') THEN RETURN NULL; END IF;
  UPDATE classroom_commands SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, finished_at = now(), result = left(p_message, 200)
   WHERE id = p_command AND device_id = p_device AND status = 'delivered';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_agent_result(uuid, text, uuid, boolean, text) FROM PUBLIC;

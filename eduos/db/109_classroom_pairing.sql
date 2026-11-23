-- DEV-02: pairing a teacher's own device with a classroom.
--
-- 1. The school sets the room timetable: which teacher is in which room, on
--    which weekdays, between which times (in the school's time zone).
-- 2. District IT gives an approved device in a room a device key (shown once,
--    kept only as a SHA-256 hash). With it, the room's display asks for a
--    short pairing code and shows it; a code lasts five minutes and only the
--    newest one works.
-- 3. A teacher timetabled in that room now (from ten minutes before) types the
--    code on their own phone or laptop. That pairs their device with the room
--    until the timetabled period ends. Seeing the code means being in the room.
--
-- Pairing grants control of the room's approved devices only (DEV-03), and
-- only within each device's approved capabilities. Codes are never readable
-- through the app role; the SECURITY DEFINER functions below are the only way
-- to make or use one.

ALTER TABLE classroom_devices ADD COLUMN token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN token_issued_at timestamptz, ADD COLUMN token_issued_by uuid REFERENCES users(id), ADD COLUMN last_seen_at timestamptz;

CREATE TABLE classroom_room_teachers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  room_id uuid NOT NULL,
  teacher_user_id uuid NOT NULL REFERENCES users(id),
  weekdays smallint[] NOT NULL CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  starts time NOT NULL,
  ends time NOT NULL CHECK (ends > starts),
  label text CHECK (label IS NULL OR length(label) <= 80),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_by uuid REFERENCES users(id),
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  UNIQUE (district_id, id)
);
CREATE INDEX classroom_room_teachers_room ON classroom_room_teachers(district_id, room_id) WHERE ended_at IS NULL;
CREATE INDEX classroom_room_teachers_teacher ON classroom_room_teachers(district_id, teacher_user_id) WHERE ended_at IS NULL;

CREATE TABLE classroom_pair_codes (
  id bigserial PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  device_id uuid NOT NULL,
  room_id uuid NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  superseded_at timestamptz,
  FOREIGN KEY (district_id, device_id) REFERENCES classroom_devices(district_id, id)
);
CREATE INDEX classroom_pair_codes_room ON classroom_pair_codes(room_id, expires_at) WHERE used_at IS NULL AND superseded_at IS NULL;

CREATE TABLE classroom_pairings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  room_id uuid NOT NULL,
  teacher_user_id uuid NOT NULL REFERENCES users(id),
  schedule_id uuid NOT NULL,
  via_device_id uuid NOT NULL,
  controller_name text NOT NULL CHECK (length(btrim(controller_name)) BETWEEN 1 AND 60),
  paired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > paired_at),
  ended_at timestamptz,
  ended_by uuid REFERENCES users(id),
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('teacher','school','schedule','replaced')),
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id),
  FOREIGN KEY (district_id, schedule_id) REFERENCES classroom_room_teachers(district_id, id),
  FOREIGN KEY (district_id, via_device_id) REFERENCES classroom_devices(district_id, id),
  UNIQUE (district_id, id)
);
CREATE INDEX classroom_pairings_room ON classroom_pairings(district_id, room_id, expires_at) WHERE ended_at IS NULL;
CREATE INDEX classroom_pairings_teacher ON classroom_pairings(district_id, teacher_user_id, expires_at) WHERE ended_at IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['classroom_room_teachers','classroom_pair_codes','classroom_pairings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- The two functions below run as the table owner (no tenant settings for the
-- room display's request), so the DEV-01 tables let the owner through too.
CREATE POLICY owner_functions ON classroom_devices USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());
CREATE POLICY owner_functions ON classroom_rooms USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- An active teacher at the school (SECURITY DEFINER: memberships are not
-- readable school-wide).
CREATE FUNCTION eduos_is_school_teacher(p_user uuid, p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM memberships m WHERE m.user_id = p_user AND m.district_id = eduos_ctx_district()
    AND m.school_id = p_school AND m.role = 'teacher' AND m.status = 'active')
$$;

-- The timetable: the school's staff read it; its leaders (and IT) set it, for
-- teachers at that school only.
CREATE POLICY scope_read ON classroom_room_teachers AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_device_scope(school_id));
CREATE POLICY scope_insert ON classroom_room_teachers AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner()
  OR (eduos_device_manager(school_id) AND created_by = eduos_ctx_user() AND eduos_is_school_teacher(teacher_user_id, school_id)
      AND EXISTS (SELECT 1 FROM classroom_rooms r WHERE r.id = room_id AND r.school_id = classroom_room_teachers.school_id AND r.archived_at IS NULL)));
CREATE POLICY scope_update ON classroom_room_teachers AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_device_manager(school_id))
  WITH CHECK (eduos_is_table_owner() OR eduos_device_manager(school_id));

-- Codes: nobody but the functions below.
CREATE POLICY functions_only ON classroom_pair_codes AS RESTRICTIVE USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- Pairings: the teacher sees and ends their own; the school's leaders, IT and
-- the superintendent see them and can end them. Only the functions create them.
CREATE POLICY scope_read ON classroom_pairings AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR teacher_user_id = eduos_ctx_user() OR (coalesce(eduos_ctx_role(), '') <> 'teacher' AND eduos_device_scope(school_id)));
CREATE POLICY scope_insert ON classroom_pairings AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY scope_update ON classroom_pairings AS RESTRICTIVE FOR UPDATE
  USING (eduos_is_table_owner() OR teacher_user_id = eduos_ctx_user() OR eduos_device_manager(school_id))
  WITH CHECK (eduos_is_table_owner() OR teacher_user_id = eduos_ctx_user() OR eduos_device_manager(school_id));

-- Device keys are IT's to issue or revoke.
CREATE OR REPLACE FUNCTION eduos_classroom_device_key_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.token_hash, NEW.token_issued_at, NEW.token_issued_by) IS DISTINCT FROM (OLD.token_hash, OLD.token_issued_at, OLD.token_issued_by)
     AND NOT (eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') = 'it_admin' OR (NEW.token_hash IS NULL AND NEW.status IN ('retired','pending'))) THEN
    RAISE EXCEPTION 'only district IT issues a device key' USING ERRCODE = '42501';
  END IF;
  -- A device that is no longer approved loses its key.
  IF NEW.status <> 'approved' THEN NEW.token_hash := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER classroom_devices_key_guard BEFORE UPDATE ON classroom_devices FOR EACH ROW EXECUTE FUNCTION eduos_classroom_device_key_guard();

-- The room display asks for a code. Returns NULL for a bad, revoked or
-- unplaced device key (the API answers 401 without saying which).
CREATE FUNCTION eduos_classroom_agent_code(p_device uuid, p_token_hash text, p_code_hash text, p_ttl_seconds int) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d classroom_devices%ROWTYPE; exp timestamptz;
BEGIN
  IF p_device IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' OR p_code_hash !~ '^[a-f0-9]{64}$' OR p_ttl_seconds NOT BETWEEN 30 AND 600 THEN RETURN NULL; END IF;
  SELECT * INTO d FROM classroom_devices WHERE id = p_device AND token_hash = p_token_hash AND status = 'approved' FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE classroom_devices SET last_seen_at = now() WHERE id = d.id;
  IF d.room_id IS NULL OR d.kind <> 'display' THEN RETURN jsonb_build_object('room', NULL, 'reason', CASE WHEN d.room_id IS NULL THEN 'not_in_a_room' ELSE 'not_a_display' END); END IF;
  UPDATE classroom_pair_codes SET superseded_at = now() WHERE room_id = d.room_id AND device_id = d.id AND used_at IS NULL AND superseded_at IS NULL;
  exp := now() + make_interval(secs => p_ttl_seconds);
  INSERT INTO classroom_pair_codes(district_id, device_id, room_id, code_hash, expires_at) VALUES (d.district_id, d.id, d.room_id, p_code_hash, exp);
  RETURN jsonb_build_object('room', (SELECT name FROM classroom_rooms WHERE id = d.room_id), 'expiresAt', exp,
    'pairedWith', (SELECT jsonb_build_object('teacher', u.display_name, 'until', p.expires_at) FROM classroom_pairings p JOIN users u ON u.id = p.teacher_user_id
      WHERE p.room_id = d.room_id AND p.ended_at IS NULL AND p.expires_at > now() ORDER BY p.paired_at DESC LIMIT 1));
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_agent_code(uuid, text, text, int) FROM PUBLIC;

-- A teacher pairs. Checks, in one step: the teacher is timetabled in this
-- room now (school time zone, from ten minutes before the start), and the
-- code is the newest unexpired, unused one a display in this room is showing.
-- The pairing lasts until the timetabled end. One pairing per room at a time:
-- a new one replaces the last.
CREATE FUNCTION eduos_classroom_pair(p_room uuid, p_code_hash text, p_controller text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE me uuid := eduos_ctx_user(); dist uuid := eduos_ctx_district(); r classroom_rooms%ROWTYPE; tz text; local_now timestamp;
  slot classroom_room_teachers%ROWTYPE; code classroom_pair_codes%ROWTYPE; until timestamptz; pid uuid;
BEGIN
  IF me IS NULL OR dist IS NULL OR coalesce(eduos_ctx_role(), '') <> 'teacher' THEN RETURN jsonb_build_object('error', 'teachers_only'); END IF;
  IF p_code_hash !~ '^[a-f0-9]{64}$' OR length(btrim(coalesce(p_controller, ''))) NOT BETWEEN 1 AND 60 THEN RETURN jsonb_build_object('error', 'invalid'); END IF;
  SELECT * INTO r FROM classroom_rooms WHERE id = p_room AND district_id = dist AND archived_at IS NULL;
  IF NOT FOUND OR r.school_id IS DISTINCT FROM eduos_ctx_school() THEN RETURN jsonb_build_object('error', 'room_not_found'); END IF;
  SELECT s.timezone INTO tz FROM schools s WHERE s.id = r.school_id;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names z WHERE z.name = tz) THEN tz := 'UTC'; END IF;
  local_now := now() AT TIME ZONE tz;
  SELECT * INTO slot FROM classroom_room_teachers t WHERE t.room_id = r.id AND t.teacher_user_id = me AND t.ended_at IS NULL
    AND extract(isodow FROM local_now)::smallint = ANY (t.weekdays)
    AND local_now >= local_now::date + t.starts - interval '10 minutes' AND local_now < local_now::date + t.ends
    ORDER BY t.ends DESC LIMIT 1;
  IF NOT FOUND OR NOT eduos_is_school_teacher(me, r.school_id) THEN RETURN jsonb_build_object('error', 'not_timetabled_now'); END IF;
  SELECT c.* INTO code FROM classroom_pair_codes c JOIN classroom_devices d ON d.id = c.device_id
    WHERE c.room_id = r.id AND c.code_hash = p_code_hash AND c.used_at IS NULL AND c.superseded_at IS NULL AND c.expires_at > now()
      AND d.room_id = r.id AND d.status = 'approved' AND d.token_hash IS NOT NULL
    ORDER BY c.created_at DESC LIMIT 1 FOR UPDATE OF c;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'wrong_code'); END IF;
  UPDATE classroom_pair_codes SET used_at = now() WHERE id = code.id;
  until := (local_now::date + slot.ends) AT TIME ZONE tz;
  UPDATE classroom_pairings SET ended_at = now(), end_reason = 'replaced' WHERE room_id = r.id AND ended_at IS NULL AND expires_at > now();
  INSERT INTO classroom_pairings(district_id, school_id, room_id, teacher_user_id, schedule_id, via_device_id, controller_name, expires_at)
    VALUES (dist, r.school_id, r.id, me, slot.id, code.device_id, btrim(p_controller), until) RETURNING id INTO pid;
  RETURN jsonb_build_object('id', pid, 'room', r.name, 'until', until);
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_pair(uuid, text, text) FROM PUBLIC;

-- The teachers at a school, for the people who set its room timetable.
CREATE FUNCTION eduos_school_teachers(p_school uuid) RETURNS TABLE(user_id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.display_name FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE eduos_device_manager(p_school) AND m.district_id = eduos_ctx_district() AND m.school_id = p_school
     AND m.role = 'teacher' AND m.status = 'active'
   ORDER BY u.display_name
$$;
REVOKE ALL ON FUNCTION eduos_school_teachers(uuid) FROM PUBLIC;

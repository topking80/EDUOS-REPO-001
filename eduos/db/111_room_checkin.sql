-- ROOM-01: scanning into a classroom or the media center.
--
-- Three ways in, all recorded with how the person checked in:
--   display_qr  the room's display shows a QR that changes every 90 seconds
--               (it can't be used from home);
--   door_qr     a printed QR by the door (simple; a photo of it works anywhere,
--               so the roll marks it);
--   kiosk_id    a kiosk device in the room (an approved device, IT key) reads a
--               student's ID card number.
-- Students (their own pupil account) and staff check in. A check-in is a
-- presence record only: the teacher sees "checked in" on the room's roll and
-- confirms attendance through the normal attendance route. Nothing here writes
-- attendance or grades.

ALTER TABLE classroom_rooms ADD COLUMN kind text NOT NULL DEFAULT 'classroom' CHECK (kind IN ('classroom','media_center')),
  ADD COLUMN door_secret_hash text CHECK (door_secret_hash IS NULL OR door_secret_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN door_secret_set_at timestamptz;

-- A timetable slot can name the course taught there (the roll's class list).
ALTER TABLE classroom_room_teachers ADD COLUMN course_id uuid,
  ADD FOREIGN KEY (district_id, course_id) REFERENCES courses(district_id, id);

-- A check-in kiosk joins the device kinds, with one capability: checkin.
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'classroom_devices'::regclass AND contype = 'c'
             AND pg_get_constraintdef(oid) ~ '(student_device|open_link)' LOOP
    EXECUTE format('ALTER TABLE classroom_devices DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE classroom_devices
  ADD CONSTRAINT classroom_devices_kind_111 CHECK (kind IN ('display','student_device','equipment','kiosk')),
  ADD CONSTRAINT classroom_devices_caps_111 CHECK (cardinality(capabilities) BETWEEN 1 AND 12
    AND capabilities <@ ARRAY['show','blank','input','volume','power','lights','lock','unlock','open_link','focus','checkin']::text[]),
  ADD CONSTRAINT classroom_devices_kind_caps_111 CHECK (CASE kind
    WHEN 'display' THEN capabilities <@ ARRAY['show','blank','input','volume','power']::text[]
    WHEN 'student_device' THEN capabilities <@ ARRAY['lock','unlock','open_link','focus']::text[]
    WHEN 'kiosk' THEN capabilities <@ ARRAY['checkin']::text[]
    ELSE capabilities <@ ARRAY['power','volume','input','lights']::text[] END);

-- The librarian reads rooms (the media center) at their school.
CREATE OR REPLACE FUNCTION eduos_device_scope(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') IN ('it_admin','superintendent')
      OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal','teacher','librarian') AND p_school = eduos_ctx_school())
$$;

CREATE TABLE classroom_checkin_codes (
  id bigserial PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  room_id uuid NOT NULL,
  device_id uuid NOT NULL,
  code_hash text NOT NULL CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (district_id, device_id) REFERENCES classroom_devices(district_id, id)
);
CREATE INDEX classroom_checkin_codes_room ON classroom_checkin_codes(room_id, expires_at);

CREATE TABLE room_checkins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  room_id uuid NOT NULL,
  person_kind text NOT NULL CHECK (person_kind IN ('student','staff')),
  user_id uuid REFERENCES users(id),
  student_id uuid,
  method text NOT NULL CHECK (method IN ('display_qr','door_qr','kiosk_id')),
  slot_id uuid,
  local_date date NOT NULL,
  checked_in_at timestamptz NOT NULL DEFAULT now(),
  device_id uuid,
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, slot_id) REFERENCES classroom_room_teachers(district_id, id),
  CHECK ((person_kind = 'student') = (student_id IS NOT NULL)),
  CHECK (person_kind = 'student' OR user_id IS NOT NULL)
);
-- One check-in per person, room, day and timetabled period (repeat scans don't add rows).
CREATE UNIQUE INDEX room_checkins_once ON room_checkins(room_id, local_date, coalesce(slot_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(student_id, user_id));
CREATE INDEX room_checkins_day ON room_checkins(district_id, room_id, local_date);
CREATE INDEX room_checkins_person ON room_checkins(district_id, user_id, local_date);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['classroom_checkin_codes','room_checkins'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;
CREATE POLICY functions_only ON classroom_checkin_codes AS RESTRICTIVE USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- Who reads a room's check-ins: the person; a teacher timetabled in that room;
-- the school's leaders, IT and the superintendent; the librarian for the
-- media center. Only the functions below write them.
CREATE FUNCTION eduos_can_read_room_checkins(p_room uuid, p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (coalesce(eduos_ctx_role(), '') IN ('it_admin','superintendent','principal','vice_principal') AND eduos_device_scope(p_school))
      OR (eduos_ctx_role() = 'teacher' AND p_school = eduos_ctx_school() AND EXISTS (SELECT 1 FROM classroom_room_teachers t
           WHERE t.room_id = p_room AND t.teacher_user_id = eduos_ctx_user() AND t.ended_at IS NULL))
      OR (eduos_ctx_role() = 'librarian' AND p_school = eduos_ctx_school() AND EXISTS (SELECT 1 FROM classroom_rooms r WHERE r.id = p_room AND r.kind = 'media_center'))
$$;
CREATE POLICY scope_read ON room_checkins AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR user_id = eduos_ctx_user() OR eduos_can_read_room_checkins(room_id, school_id));
CREATE POLICY functions_write ON room_checkins AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner());
CREATE POLICY functions_update ON room_checkins AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner()) WITH CHECK (eduos_is_table_owner());

-- The timetabled period in a room now (school time zone, from ten minutes
-- before), if any.
CREATE FUNCTION eduos_room_slot_now(p_room uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH z AS (SELECT r.id, CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = s.timezone) THEN s.timezone ELSE 'UTC' END AS tz
               FROM classroom_rooms r JOIN schools s ON s.id = r.school_id WHERE r.id = p_room)
  SELECT t.id FROM classroom_room_teachers t, z, LATERAL (SELECT now() AT TIME ZONE z.tz AS ln) l
   WHERE t.room_id = z.id AND t.ended_at IS NULL AND extract(isodow FROM l.ln)::smallint = ANY (t.weekdays)
     AND l.ln >= l.ln::date + t.starts - interval '10 minutes' AND l.ln < l.ln::date + t.ends
   ORDER BY t.starts LIMIT 1
$$;
CREATE FUNCTION eduos_room_local_date(p_room uuid) RETURNS date
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT (now() AT TIME ZONE CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = s.timezone) THEN s.timezone ELSE 'UTC' END)::date
    FROM classroom_rooms r JOIN schools s ON s.id = r.school_id WHERE r.id = p_room
$$;

-- The room display asks for a check-in code to show as a QR (90 seconds; any
-- number of people may scan the same one while it lasts).
CREATE FUNCTION eduos_classroom_agent_checkin_code(p_device uuid, p_token_hash text, p_code_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d classroom_devices%ROWTYPE; exp timestamptz := now() + interval '90 seconds';
BEGIN
  IF p_device IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' OR p_code_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  SELECT * INTO d FROM classroom_devices WHERE id = p_device AND token_hash = p_token_hash AND status = 'approved';
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE classroom_devices SET last_seen_at = now() WHERE id = d.id;
  IF d.room_id IS NULL OR d.kind NOT IN ('display','kiosk') THEN RETURN jsonb_build_object('room', NULL); END IF;
  DELETE FROM classroom_checkin_codes WHERE room_id = d.room_id AND expires_at < now() - interval '1 hour';
  INSERT INTO classroom_checkin_codes(district_id, room_id, device_id, code_hash, expires_at) VALUES (d.district_id, d.room_id, d.id, p_code_hash, exp);
  RETURN jsonb_build_object('roomId', d.room_id, 'room', (SELECT name FROM classroom_rooms WHERE id = d.room_id), 'expiresAt', exp);
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_agent_checkin_code(uuid, text, text) FROM PUBLIC;

-- Someone signed in checks in with a code from the display or the door QR.
CREATE FUNCTION eduos_room_checkin(p_room uuid, p_method text, p_secret_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE me uuid := eduos_ctx_user(); dist uuid := eduos_ctx_district(); role text := coalesce(eduos_ctx_role(), '');
  r classroom_rooms%ROWTYPE; stu uuid; kind text; slot uuid; ldate date; row_id uuid; at timestamptz;
BEGIN
  IF me IS NULL OR dist IS NULL OR p_method NOT IN ('display_qr','door_qr') OR p_secret_hash !~ '^[a-f0-9]{64}$' THEN RETURN jsonb_build_object('error', 'invalid'); END IF;
  SELECT * INTO r FROM classroom_rooms WHERE id = p_room AND district_id = dist AND archived_at IS NULL;
  IF NOT FOUND OR r.school_id IS DISTINCT FROM eduos_ctx_school() THEN RETURN jsonb_build_object('error', 'room_not_found'); END IF;
  IF role = 'pupil' THEN
    SELECT l.student_id INTO stu FROM student_user_links l JOIN students s ON s.id = l.student_id
     WHERE l.user_id = me AND l.district_id = dist AND l.relationship = 'pupil' AND l.status = 'active' AND s.school_id = r.school_id LIMIT 1;
    IF stu IS NULL THEN RETURN jsonb_build_object('error', 'not_a_student_here'); END IF;
    kind := 'student';
  ELSIF role IN ('teacher','principal','vice_principal','librarian','counselor','nurse','coach','maintenance','lunch_staff') THEN
    kind := 'staff';
  ELSE RETURN jsonb_build_object('error', 'not_allowed'); END IF;
  IF p_method = 'display_qr' AND NOT EXISTS (SELECT 1 FROM classroom_checkin_codes c WHERE c.room_id = r.id AND c.code_hash = p_secret_hash AND c.expires_at > now()) THEN
    RETURN jsonb_build_object('error', 'code_expired');
  END IF;
  IF p_method = 'door_qr' AND r.door_secret_hash IS DISTINCT FROM p_secret_hash THEN RETURN jsonb_build_object('error', 'code_expired'); END IF;
  slot := eduos_room_slot_now(r.id); ldate := eduos_room_local_date(r.id);
  INSERT INTO room_checkins(district_id, school_id, room_id, person_kind, user_id, student_id, method, slot_id, local_date)
    VALUES (dist, r.school_id, r.id, kind, me, stu, p_method, slot, ldate)
    ON CONFLICT DO NOTHING RETURNING id, checked_in_at INTO row_id, at;
  IF row_id IS NULL THEN
    SELECT checked_in_at INTO at FROM room_checkins WHERE room_id = r.id AND local_date = ldate AND coalesce(slot_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(slot, '00000000-0000-0000-0000-000000000000'::uuid)
      AND coalesce(student_id, user_id) = coalesce(stu, me);
  END IF;
  RETURN jsonb_build_object('room', r.name, 'kind', r.kind, 'checkedInAt', at, 'already', row_id IS NULL,
    'class', (SELECT coalesce(t.label, c.title) FROM classroom_room_teachers t LEFT JOIN courses c ON c.id = t.course_id WHERE t.id = slot));
END $$;
REVOKE ALL ON FUNCTION eduos_room_checkin(uuid, text, text) FROM PUBLIC;

-- A kiosk in the room reads a student's ID card number.
CREATE FUNCTION eduos_classroom_agent_kiosk_checkin(p_device uuid, p_token_hash text, p_student_number text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d classroom_devices%ROWTYPE; st students%ROWTYPE; slot uuid; ldate date; row_id uuid;
BEGIN
  IF p_device IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  SELECT * INTO d FROM classroom_devices WHERE id = p_device AND token_hash = p_token_hash AND status = 'approved';
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE classroom_devices SET last_seen_at = now() WHERE id = d.id;
  IF d.kind <> 'kiosk' OR NOT ('checkin' = ANY (d.capabilities)) OR d.room_id IS NULL THEN RETURN jsonb_build_object('error', 'not_a_checkin_kiosk'); END IF;
  IF length(btrim(coalesce(p_student_number, ''))) NOT BETWEEN 1 AND 40 THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  -- The kiosk's request has no session: act in the kiosk's own district (students are tenant-isolated).
  PERFORM set_config('app.district_id', d.district_id::text, true);
  SELECT * INTO st FROM students WHERE district_id = d.district_id AND school_id = d.school_id AND local_student_number = btrim(p_student_number);
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  slot := eduos_room_slot_now(d.room_id); ldate := eduos_room_local_date(d.room_id);
  INSERT INTO room_checkins(district_id, school_id, room_id, person_kind, student_id, method, slot_id, local_date, device_id)
    VALUES (d.district_id, d.school_id, d.room_id, 'student', st.id, 'kiosk_id', slot, ldate, d.id) ON CONFLICT DO NOTHING RETURNING id INTO row_id;
  -- The kiosk shows a first name only.
  RETURN jsonb_build_object('name', split_part(st.display_name, ' ', 1), 'already', row_id IS NULL);
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_agent_kiosk_checkin(uuid, text, text) FROM PUBLIC;

-- Your own check-ins in the last day, with the room's name (students can't
-- read the rooms table itself).
CREATE FUNCTION eduos_my_room_checkins() RETURNS TABLE(room_id uuid, room text, kind text, method text, checked_in_at timestamptz, class text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT k.room_id, r.name, r.kind, k.method, k.checked_in_at, coalesce(t.label, co.title)
    FROM room_checkins k JOIN classroom_rooms r ON r.id = k.room_id
    LEFT JOIN classroom_room_teachers t ON t.id = k.slot_id LEFT JOIN courses co ON co.id = t.course_id
   WHERE k.district_id = eduos_ctx_district() AND k.user_id = eduos_ctx_user() AND k.checked_in_at > now() - interval '24 hours'
   ORDER BY k.checked_in_at DESC
$$;
REVOKE ALL ON FUNCTION eduos_my_room_checkins() FROM PUBLIC;

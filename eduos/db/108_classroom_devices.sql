-- DEV-01: classroom rooms and the device registry.
--
-- A school lists its rooms. The school (principal) asks for a classroom device
-- (a display, a student device, or room equipment such as a projector,
-- speaker or lights); district IT approves or rejects it. IT can also register
-- a device directly. Only an approved device can be put in a room, and the
-- school decides which room. What a device can be told to do is the approved
-- list of capabilities: changing that list sends the device back for approval.
--
-- Nothing here reads a student's screen: there is no screen-viewing
-- capability, and the check below refuses one. Devices are retired, never
-- deleted; every change is kept in classroom_device_events.

CREATE TABLE classroom_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  building text CHECK (building IS NULL OR length(building) <= 80),
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 1000),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX classroom_rooms_name ON classroom_rooms(district_id, school_id, lower(btrim(name))) WHERE archived_at IS NULL;

CREATE TABLE classroom_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('display','student_device','equipment')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  maker text CHECK (maker IS NULL OR length(maker) <= 80),
  model text CHECK (model IS NULL OR length(model) <= 80),
  serial text CHECK (serial IS NULL OR length(btrim(serial)) BETWEEN 1 AND 80),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) BETWEEN 1 AND 12
    AND capabilities <@ ARRAY['show','blank','input','volume','power','lights','lock','unlock','open_link','focus']::text[]),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','retired')),
  room_id uuid,
  requested_by uuid NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz,
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, room_id) REFERENCES classroom_rooms(district_id, id),
  -- Only approved devices sit in a room.
  CHECK (room_id IS NULL OR status = 'approved'),
  CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL) OR status = 'retired'),
  -- What each kind may be told to do. Student devices: lock, unlock, open a
  -- link, focus mode. Never anything that shows their screen.
  CHECK (CASE kind
    WHEN 'display' THEN capabilities <@ ARRAY['show','blank','input','volume','power']::text[]
    WHEN 'student_device' THEN capabilities <@ ARRAY['lock','unlock','open_link','focus']::text[]
    ELSE capabilities <@ ARRAY['power','volume','input','lights']::text[] END),
  UNIQUE (district_id, id)
);
CREATE UNIQUE INDEX classroom_devices_serial ON classroom_devices(district_id, lower(serial)) WHERE serial IS NOT NULL AND retired_at IS NULL;
CREATE INDEX classroom_devices_school ON classroom_devices(district_id, school_id, status);
CREATE INDEX classroom_devices_room ON classroom_devices(district_id, room_id) WHERE room_id IS NOT NULL;

CREATE TABLE classroom_device_events (
  id bigserial PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id),
  device_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  event text NOT NULL CHECK (event IN ('requested','registered','approved','rejected','changed','placed','removed','retired')),
  detail text CHECK (detail IS NULL OR length(detail) <= 500),
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, device_id) REFERENCES classroom_devices(district_id, id)
);
CREATE INDEX classroom_device_events_device ON classroom_device_events(district_id, device_id, at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['classroom_rooms','classroom_devices','classroom_device_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
      WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- District IT and the superintendent see the whole district; school staff see
-- their own school's rooms and devices.
CREATE FUNCTION eduos_device_scope(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') IN ('it_admin','superintendent')
      OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal','teacher') AND p_school = eduos_ctx_school())
$$;
-- The school's leaders manage rooms and ask for devices; IT may too.
CREATE FUNCTION eduos_device_manager(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(eduos_ctx_role(), '') = 'it_admin'
      OR (coalesce(eduos_ctx_role(), '') IN ('principal','vice_principal') AND p_school = eduos_ctx_school())
$$;

CREATE POLICY scope_read ON classroom_rooms AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_device_scope(school_id));
CREATE POLICY scope_insert ON classroom_rooms AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner() OR (eduos_device_manager(school_id) AND created_by = eduos_ctx_user()));
CREATE POLICY scope_update ON classroom_rooms AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_device_manager(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_device_manager(school_id));

CREATE POLICY scope_read ON classroom_devices AS RESTRICTIVE FOR SELECT USING (eduos_is_table_owner() OR eduos_device_scope(school_id));
-- A school asks (pending); only IT registers a device already approved.
CREATE POLICY scope_insert ON classroom_devices AS RESTRICTIVE FOR INSERT WITH CHECK (eduos_is_table_owner()
  OR (eduos_device_manager(school_id) AND requested_by = eduos_ctx_user() AND (status = 'pending' OR eduos_ctx_role() = 'it_admin')));
CREATE POLICY scope_update ON classroom_devices AS RESTRICTIVE FOR UPDATE USING (eduos_is_table_owner() OR eduos_device_manager(school_id)) WITH CHECK (eduos_is_table_owner() OR eduos_device_manager(school_id));

CREATE POLICY scope_read ON classroom_device_events AS RESTRICTIVE FOR SELECT
  USING (eduos_is_table_owner() OR EXISTS (SELECT 1 FROM classroom_devices d WHERE d.id = device_id));
CREATE POLICY scope_insert ON classroom_device_events AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner() OR (actor_id = eduos_ctx_user() AND EXISTS (SELECT 1 FROM classroom_devices d WHERE d.id = device_id)));

-- Only district IT approves or rejects. A change to what the device is or can
-- do (anything but its name) sends it back for approval and out of its room,
-- unless IT approves the change in the same step. A device moves only
-- between rooms of its own school.
CREATE FUNCTION eduos_classroom_device_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE is_it boolean := eduos_is_table_owner() OR coalesce(eduos_ctx_role(), '') = 'it_admin';
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'retired' THEN RAISE EXCEPTION 'device is retired' USING ERRCODE = '42501'; END IF;
    IF NEW.school_id IS DISTINCT FROM OLD.school_id THEN RAISE EXCEPTION 'a device stays with its school' USING ERRCODE = '42501'; END IF;
    IF (NEW.kind, NEW.maker, NEW.model, NEW.serial, NEW.capabilities) IS DISTINCT FROM (OLD.kind, OLD.maker, OLD.model, OLD.serial, OLD.capabilities)
       AND NEW.status <> 'retired'
       AND NOT (is_it AND NEW.status = 'approved' AND NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
      NEW.status := 'pending'; NEW.decided_by := NULL; NEW.decided_at := NULL; NEW.decision_note := NULL; NEW.room_id := NULL;
    END IF;
    IF NEW.status IN ('approved','rejected') AND (NEW.status, NEW.decided_by, NEW.decided_at) IS DISTINCT FROM (OLD.status, OLD.decided_by, OLD.decided_at) AND NOT is_it THEN
      RAISE EXCEPTION 'only district IT approves a classroom device' USING ERRCODE = '42501';
    END IF;
    NEW.updated_at := now();
  ELSIF NEW.status IN ('approved','rejected') AND NOT is_it THEN
    RAISE EXCEPTION 'only district IT approves a classroom device' USING ERRCODE = '42501';
  END IF;
  IF NEW.room_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM classroom_rooms r WHERE r.id = NEW.room_id AND r.school_id = NEW.school_id AND r.archived_at IS NULL) THEN
    RAISE EXCEPTION 'room is not at this school' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER classroom_devices_guard BEFORE INSERT OR UPDATE ON classroom_devices FOR EACH ROW EXECUTE FUNCTION eduos_classroom_device_guard();

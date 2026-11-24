-- SAFE-02: classroom displays and kiosks follow a safety alert.
--
-- Every classroom device already polls EduOS with its key (DEV-03). While an
-- alert is live at the device's school, each poll also returns what the
-- device should show; at the all clear it returns nothing, and the device goes
-- back to normal. Nothing is pushed, so a device that was off or offline
-- catches up on its next poll.
--
-- What a device shows depends on the alert (src/safety-model.js):
--   lockdown        the screen goes dark and silent (a lit screen can be seen
--                   through a door window; nothing on it says "people here")
--   hold, shelter,  a full-screen notice with the student instructions; the
--   evacuate        volume is muted
-- Student devices get the same message as a notice; they are never locked
-- or opened on a student's screen by this.
--
-- Check-in (display code, door QR, kiosk) pauses while an alert is live:
-- people stay where they are. Leaders see which displays have switched.

ALTER TABLE classroom_devices
  ADD COLUMN safety_incident_id uuid,
  ADD COLUMN safety_seen_at timestamptz;

-- What is live at this device's school, for the device's poll. NULL for a bad
-- key. Records that the device has seen it (for the leaders' display check).
CREATE FUNCTION eduos_classroom_agent_safety(p_device uuid, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d classroom_devices%ROWTYPE; i safety_incidents%ROWTYPE; clear timestamptz;
BEGIN
  IF p_device IS NULL OR p_token_hash !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
  SELECT * INTO d FROM classroom_devices WHERE id = p_device AND token_hash = p_token_hash AND status = 'approved';
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- The device's request has no session: read in the device's own district
  -- (safety incidents are tenant-isolated), as the kiosk check-in does (db/111).
  PERFORM set_config('app.district_id', d.district_id::text, true);
  SELECT * INTO i FROM safety_incidents WHERE district_id = d.district_id AND school_id = d.school_id AND status IN ('active','reunification')
   ORDER BY confirmed_at DESC LIMIT 1;
  IF FOUND THEN
    UPDATE classroom_devices SET safety_incident_id = i.id, safety_seen_at = now(), last_seen_at = now() WHERE id = d.id;
    RETURN jsonb_build_object('incident', jsonb_build_object('id', i.id, 'kind', i.kind, 'isDrill', i.is_drill, 'status', i.status,
      'startedAt', i.confirmed_at, 'reunificationPoint', CASE WHEN i.status = 'reunification' THEN i.reunification_point END), 'deviceKind', d.kind);
  END IF;
  -- An all clear in the last ten minutes, so a device can show it briefly.
  SELECT max(closed_at) INTO clear FROM safety_incidents WHERE district_id = d.district_id AND school_id = d.school_id
    AND status = 'closed' AND closed_at > now() - interval '10 minutes';
  RETURN jsonb_build_object('incident', NULL, 'allClearAt', clear, 'deviceKind', d.kind);
END $$;
REVOKE ALL ON FUNCTION eduos_classroom_agent_safety(uuid, text) FROM PUBLIC;

-- Is an alert live at this school (for pausing check-in from a session)?
CREATE FUNCTION eduos_safety_live_at(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM safety_incidents WHERE district_id = eduos_ctx_district() AND school_id = p_school AND status IN ('active','reunification'))
$$;

-- The school's displays, kiosks and student devices for an incident: which
-- have switched (polled since it started) and when each was last heard from.
-- For whoever may see the incident's room board.
CREATE FUNCTION eduos_safety_displays(p_incident uuid)
RETURNS TABLE(id uuid, name text, kind text, room text, last_seen_at timestamptz, switched boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.name, d.kind, r.name, d.last_seen_at, coalesce(d.safety_incident_id = i.id AND d.safety_seen_at >= i.confirmed_at, false)
    FROM safety_incidents i JOIN classroom_devices d ON d.school_id = i.school_id AND d.district_id = i.district_id
    LEFT JOIN classroom_rooms r ON r.id = d.room_id
   WHERE i.id = p_incident AND i.district_id = eduos_ctx_district() AND eduos_safety_room_viewer(i.school_id)
     AND d.status = 'approved' AND d.token_hash IS NOT NULL AND d.kind IN ('display','kiosk','student_device')
   ORDER BY 6, r.name, d.name
$$;

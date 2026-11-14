-- Audit 37.4.0 item 4: database-level defense in depth for transport check-ins.
--
-- POST /api/transport/runs/:runId/checkins checks that the run is in progress
-- (or the check-in was queued offline between the run's start and completion),
-- the student is an active rider on the run's route, the stop is on that
-- route, and the row carries the run's school. The INSERT policy from 012
-- only checked the recorder, school context and driver/principal role. A
-- statement issued directly as the runtime role could therefore record a
-- check-in for a student who isn't on the route, at a stop on another route,
-- or on a completed run.
--
-- This adds the same conditions as a RESTRICTIVE INSERT policy, so they are
-- ANDed with the existing ones. The table owner (migrations, EDEN restore and
-- sync functions) is exempt, matching every other transport policy.

CREATE FUNCTION eduos_transport_checkin_consistent(
  p_run uuid, p_school uuid, p_student uuid, p_stop uuid, p_observed timestamptz
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM transport_runs x
    WHERE x.id = p_run
      AND x.district_id = eduos_ctx_district()
      AND x.school_id = p_school
      AND (x.status = 'in_progress'
           OR (p_observed IS NOT NULL AND x.completed_at IS NOT NULL
               -- Millisecond precision, matching the API's JavaScript Date comparison.
               AND p_observed >= date_trunc('milliseconds', x.started_at)
               AND p_observed <= x.completed_at))
      AND EXISTS (SELECT 1 FROM transport_rider_assignments a
                  WHERE a.route_id = x.route_id AND a.student_id = p_student
                    AND a.district_id = x.district_id AND a.revoked_at IS NULL)
      AND EXISTS (SELECT 1 FROM transport_stops s
                  WHERE s.id = p_stop AND s.route_id = x.route_id AND s.district_id = x.district_id)
  )
$$;
REVOKE ALL ON FUNCTION eduos_transport_checkin_consistent(uuid, uuid, uuid, uuid, timestamptz) FROM PUBLIC;

CREATE POLICY scope_insert_consistency ON transport_checkins AS RESTRICTIVE FOR INSERT
  WITH CHECK (eduos_is_table_owner()
    OR eduos_transport_checkin_consistent(run_id, school_id, student_id, stop_id, observed_at));

-- SAFE-05: refresh every authoritative NWS field when an existing alert is seen.
-- The alert's identity and human decision remain stable; changed NWS guidance
-- must not leave an old headline, hazard, area, or instruction on screen.

CREATE OR REPLACE FUNCTION eduos_weather_record(p_district uuid, p_school uuid, p_alerts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a jsonb; fresh jsonb := '[]'::jsonb; ids text[] := ARRAY[]::text[]; rid uuid; ins boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_weather_points p JOIN district_weather_settings w ON w.district_id = p.district_id AND w.enabled
                  WHERE p.school_id = p_school AND p.district_id = p_district) THEN RETURN '[]'::jsonb; END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) LOOP
    ids := ids || (a->>'id');
    INSERT INTO school_weather_alerts(district_id, school_id, nws_id, event, level, hazard, severity, headline, area, instruction, onset, expires)
      VALUES (p_district, p_school, left(a->>'id', 300), left(a->>'event', 100), a->>'level', a->>'hazard', left(a->>'severity', 20),
              left(a->>'headline', 300), left(a->>'area', 500), left(a->>'instruction', 1000), (a->>'onset')::timestamptz, (a->>'expires')::timestamptz)
      ON CONFLICT (school_id, nws_id) DO UPDATE SET
        event = EXCLUDED.event,
        level = EXCLUDED.level,
        hazard = EXCLUDED.hazard,
        severity = EXCLUDED.severity,
        headline = EXCLUDED.headline,
        area = EXCLUDED.area,
        instruction = EXCLUDED.instruction,
        onset = EXCLUDED.onset,
        expires = EXCLUDED.expires,
        last_seen_at = now(),
        ended_at = NULL
      RETURNING id, (xmax = 0) INTO rid, ins;
    IF ins AND a->>'level' = 'warning' AND a->>'hazard' IS NOT NULL THEN
      fresh := fresh || jsonb_build_object('id', rid, 'event', a->>'event', 'hazard', a->>'hazard', 'headline', a->>'headline', 'expires', a->>'expires');
    END IF;
  END LOOP;
  UPDATE school_weather_alerts SET ended_at = now()
   WHERE school_id = p_school AND district_id = p_district AND ended_at IS NULL
     AND NOT (nws_id = ANY (ids));
  RETURN fresh;
END $$;
REVOKE ALL ON FUNCTION eduos_weather_record(uuid, uuid, jsonb) FROM PUBLIC;

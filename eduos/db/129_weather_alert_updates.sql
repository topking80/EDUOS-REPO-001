-- 37.7.4 weather safety: NWS Update and Cancel messages, and a full refresh of
-- what NWS says.
--
-- The 124 version of eduos_weather_record refreshed only the headline and
-- expiry when it saw an alert again, so changed instructions, area, severity
-- or hazard stayed stale on screen. It also treated an NWS "Update" (which
-- arrives under a NEW id and lists the messages it replaces in "references")
-- as a brand-new alert: leaders were alerted again, the earlier decision was
-- left on an ended row, and the new row prompted again.
--
-- Now, for each school:
--   * Cancel: the alerts it references (and its own id) end, even if NWS still
--     lists the original in the same answer.
--   * Update: it is folded into the alert it replaces (the most recently seen
--     row with a referenced id): the row takes the new id and every
--     authoritative field (event, level, hazard, severity, headline, area,
--     instruction, onset, expires). Any other referenced rows end.
--   * Seen again (same id): every authoritative field is refreshed.
-- What happens to a leader's decision when guidance changes:
--   * The decision stays and nobody is alerted again, so an update to a
--     warning someone already acted on doesn't nag them.
--   * Except when the change raises the stakes on a DISMISSED warning: it
--     became a prompting warning it wasn't before (watch -> warning, or a
--     different hazard) or its NWS severity went up. Then the dismissal is
--     cleared (the EDAL audit keeps the original dismissal), the prompt
--     returns and leaders are alerted again. A "started" decision always stays:
--     the shelter is already running.
-- Returns the warnings to alert leaders about, as before.

CREATE OR REPLACE FUNCTION eduos_weather_severity_rank(p text) RETURNS int
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p WHEN 'Extreme' THEN 4 WHEN 'Severe' THEN 3 WHEN 'Moderate' THEN 2 WHEN 'Minor' THEN 1 ELSE 0 END
$$;
REVOKE ALL ON FUNCTION eduos_weather_severity_rank(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION eduos_weather_record(p_district uuid, p_school uuid, p_alerts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a jsonb; fresh jsonb := '[]'::jsonb; ids text[] := ARRAY[]::text[]; cancelled text[] := ARRAY[]::text[];
  refs text[]; nid text; rid uuid; old school_weather_alerts%ROWTYPE; prompting boolean; raises boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM school_weather_points p JOIN district_weather_settings w ON w.district_id = p.district_id AND w.enabled
                  WHERE p.school_id = p_school AND p.district_id = p_district) THEN RETURN '[]'::jsonb; END IF;

  -- Cancels first, so an original listed beside its Cancel doesn't reopen.
  FOR a IN SELECT * FROM jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) LOOP
    IF a->>'messageType' = 'Cancel' THEN
      cancelled := cancelled || left(a->>'id', 300)
        || ARRAY(SELECT left(r, 300) FROM jsonb_array_elements_text(coalesce(a->'references', '[]'::jsonb)) r);
    END IF;
  END LOOP;

  FOR a IN SELECT * FROM jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) LOOP
    nid := left(a->>'id', 300);
    CONTINUE WHEN a->>'messageType' = 'Cancel' OR nid IS NULL OR nid = ANY (cancelled);
    refs := ARRAY(SELECT left(r, 300) FROM jsonb_array_elements_text(coalesce(a->'references', '[]'::jsonb)) r);
    ids := ids || nid;
    old := NULL;
    SELECT * INTO old FROM school_weather_alerts
     WHERE school_id = p_school AND district_id = p_district AND nws_id = nid FOR UPDATE;
    IF old.id IS NULL AND cardinality(refs) > 0 THEN
      SELECT * INTO old FROM school_weather_alerts
       WHERE school_id = p_school AND district_id = p_district AND nws_id = ANY (refs)
       ORDER BY last_seen_at DESC, first_seen_at DESC LIMIT 1 FOR UPDATE;
    END IF;
    prompting := a->>'level' = 'warning' AND a->>'hazard' IS NOT NULL;

    IF old.id IS NULL THEN
      INSERT INTO school_weather_alerts(district_id, school_id, nws_id, event, level, hazard, severity, headline, area, instruction, onset, expires)
        VALUES (p_district, p_school, nid, left(a->>'event', 100), a->>'level', a->>'hazard', left(a->>'severity', 20),
                left(a->>'headline', 300), left(a->>'area', 500), left(a->>'instruction', 1000), (a->>'onset')::timestamptz, (a->>'expires')::timestamptz)
        RETURNING id INTO rid;
      IF prompting THEN
        fresh := fresh || jsonb_build_object('id', rid, 'event', a->>'event', 'hazard', a->>'hazard', 'headline', a->>'headline', 'expires', a->>'expires');
      END IF;
    ELSE
      rid := old.id;
      -- Raises the stakes: it now prompts and didn't before (or for another
      -- hazard), or NWS raised its severity.
      raises := prompting AND (old.level <> 'warning' OR old.hazard IS NULL OR old.hazard IS DISTINCT FROM a->>'hazard'
                               OR eduos_weather_severity_rank(a->>'severity') > eduos_weather_severity_rank(old.severity));
      UPDATE school_weather_alerts SET
          nws_id = nid,
          event = left(a->>'event', 100),
          level = a->>'level',
          hazard = a->>'hazard',
          severity = left(a->>'severity', 20),
          headline = left(a->>'headline', 300),
          area = left(a->>'area', 500),
          instruction = left(a->>'instruction', 1000),
          onset = (a->>'onset')::timestamptz,
          expires = (a->>'expires')::timestamptz,
          last_seen_at = now(),
          ended_at = NULL,
          decision = CASE WHEN raises AND decision = 'dismissed' THEN NULL ELSE decision END,
          decided_by = CASE WHEN raises AND decision = 'dismissed' THEN NULL ELSE decided_by END,
          decided_at = CASE WHEN raises AND decision = 'dismissed' THEN NULL ELSE decided_at END,
          decision_note = CASE WHEN raises AND decision = 'dismissed' THEN NULL ELSE decision_note END
        WHERE id = rid;
      IF raises AND old.decision IS DISTINCT FROM 'started' THEN
        fresh := fresh || jsonb_build_object('id', rid, 'event', a->>'event', 'hazard', a->>'hazard', 'headline', a->>'headline', 'expires', a->>'expires');
      END IF;
    END IF;

    -- Anything else this message replaces is over.
    IF cardinality(refs) > 0 THEN
      UPDATE school_weather_alerts SET ended_at = now()
       WHERE school_id = p_school AND district_id = p_district AND ended_at IS NULL AND id <> rid AND nws_id = ANY (refs);
    END IF;
  END LOOP;

  UPDATE school_weather_alerts SET ended_at = now()
   WHERE school_id = p_school AND district_id = p_district AND ended_at IS NULL
     AND (nws_id = ANY (cancelled) OR NOT (nws_id = ANY (ids)));
  RETURN fresh;
END $$;
REVOKE ALL ON FUNCTION eduos_weather_record(uuid, uuid, jsonb) FROM PUBLIC;

-- EduOS 37.6.0 (candidate): Leo lesson drafts and Edison trends, both on the
-- staff AI gateway (src/ai/*, migrations 041/042).
--   * Leo: a teacher or school leader asks for a lesson DRAFT built only from
--     the course's curriculum (district standards, approved lessons in the
--     course, approved primary sources). The draft is saved as an ordinary
--     draft lesson with provenance, and can't be published until a school
--     leader approves it through the existing lesson approval (enforced here).
--   * Edison: operations trends for school leaders computed ONLY from what the
--     EDEN aggregation gate releases (counts, minimum cell size 5, with
--     complementary suppression); the optional AI brief sees only those
--     released numbers.
-- No student is profiled, scored or predicted (p21): no student data is an
-- input to Leo, and Edison sees only gate-released group counts.
-- Numbered 059: right after 058 (district AI privacy controls, #48), which this
-- branch is stacked on. src/migrate.js applies every numbered file after 050 in
-- name order; see MERGE-ORDER for the full 051-064 set.

-- 1. Two more gateway use cases. Order-independent: widen whatever list the
--    constraint already has.
DO $$
DECLARE def text; vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='ai_district_policy'::regclass AND conname='ai_district_policy_enabled_usecases_check';
  vals := ARRAY(SELECT DISTINCT (regexp_matches(def, '''([a-z_]+)''', 'g'))[1] UNION SELECT unnest(ARRAY['leo_lesson','ops_trends']) ORDER BY 1);
  ALTER TABLE ai_district_policy DROP CONSTRAINT ai_district_policy_enabled_usecases_check;
  EXECUTE format('ALTER TABLE ai_district_policy ADD CONSTRAINT ai_district_policy_enabled_usecases_check CHECK(enabled_usecases <@ %L::text[])', vals);
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint WHERE conrelid='ai_usage'::regclass AND conname='ai_usage_usecase_check';
  vals := ARRAY(SELECT DISTINCT (regexp_matches(def, '''([a-z_]+)''', 'g'))[1] UNION SELECT unnest(ARRAY['leo_lesson','ops_trends']) ORDER BY 1);
  ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_usecase_check;
  EXECUTE format('ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_usecase_check CHECK(usecase = ANY(%L::text[]))', vals);
END $$;

-- 2. Leo provenance on lessons. generated_from holds ids of the curriculum
--    rows used (standards, lessons, sources) and the ai_usage row: never
--    student data.
ALTER TABLE lessons
  ADD COLUMN generated_by text CHECK (generated_by IS NULL OR generated_by IN ('leo-local','leo-external')),
  ADD COLUMN generated_from jsonb CHECK (generated_from IS NULL OR (jsonb_typeof(generated_from)='object' AND length(generated_from::text) <= 4000)),
  ADD CONSTRAINT lessons_leo_provenance CHECK ((generated_by IS NULL) = (generated_from IS NULL));

-- A Leo draft is created as a draft, is published only once a school leader
-- has approved it, and its provenance never changes. A content edit by a
-- non-leader clears the approval (lessons_approval_guard, 014); if that
-- lesson was published it goes back to draft until it is approved again.
-- Runs after lessons_approval_guard (trigger names fire in order).
CREATE FUNCTION eduos_leo_lesson_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.generated_by IS NOT NULL AND (NEW.status <> 'draft' OR NEW.approved_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a Leo lesson is created as an unapproved draft' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.generated_by IS DISTINCT FROM OLD.generated_by OR NEW.generated_from IS DISTINCT FROM OLD.generated_from) AND NOT eduos_owner_session() THEN
    RAISE EXCEPTION 'Leo provenance is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.generated_by IS NOT NULL AND NEW.status = 'published' AND NEW.approved_at IS NULL THEN
    IF OLD.status = 'published' THEN NEW.status := 'draft';
    ELSE RAISE EXCEPTION 'a Leo draft is published only after a school leader approves it' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER lessons_zz_leo_guard BEFORE INSERT OR UPDATE ON lessons FOR EACH ROW EXECUTE FUNCTION eduos_leo_lesson_guard();

-- 3. Edison: the same count tables the EDEN node computes for the gate
--    (015 eduos_eden_source), for a school leader in their own scope. Output
--    is raw counts and goes straight into the aggregation gate in the API;
--    nothing else may call it. Superintendent: any school in the district;
--    principal / vice principal: their own school.
CREATE FUNCTION eduos_edison_allowed(p_school uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS(SELECT 1 FROM schools s WHERE s.id=p_school AND s.district_id=eduos_ctx_district() AND (
    eduos_ctx_role()='superintendent' OR (eduos_ctx_role() IN ('principal','vice_principal') AND s.id=eduos_ctx_school())))
$$;

CREATE FUNCTION eduos_edison_source(p_kind text, p_school uuid, p_day date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); cells jsonb;
BEGIN
  IF d IS NULL OR NOT eduos_edison_allowed(p_school) THEN RAISE EXCEPTION 'Edison: school leader scope required' USING ERRCODE = '42501'; END IF;
  IF p_kind = 'enrollment_by_grade' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('grade', g, 'count', n)), '[]') INTO cells FROM (
      SELECT grade_level g, count(*)::int n FROM students WHERE district_id=d AND school_id=p_school AND grade_level ~ '^(PK|K|[0-9]{1,2})$' GROUP BY 1) x;
  ELSIF p_kind = 'attendance_daily' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('date', p_day::text, 'grade', g, 'status', st, 'count', n)), '[]') INTO cells FROM (
      SELECT s.grade_level g, coalesce(l.status, 'not_recorded') st, count(*)::int n
        FROM students s
        LEFT JOIN LATERAL (SELECT e.status FROM attendance_events e WHERE e.student_id=s.id AND e.district_id=d AND e.event_date=p_day
                            ORDER BY e.observed_at DESC, e.id DESC LIMIT 1) l ON true
       WHERE s.district_id=d AND s.school_id=p_school AND s.grade_level ~ '^(PK|K|[0-9]{1,2})$'
       GROUP BY 1, 2) x;
  ELSIF p_kind = 'transport_checkins_daily' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('date', p_day::text, 'route', rl, 'event', ev, 'count', n)), '[]') INTO cells FROM (
      SELECT left(regexp_replace(r.bus_label, '[^A-Za-z0-9 #.&()-]', '', 'g'), 32) || ' ' || upper(r.direction) rl,
             coalesce(l.event, 'no_checkin') ev, count(*)::int n
        FROM transport_rider_assignments a JOIN transport_routes r ON r.id=a.route_id
        LEFT JOIN transport_runs run ON run.route_id=r.id AND run.service_date=p_day
        LEFT JOIN LATERAL (SELECT c.event FROM transport_checkins c WHERE c.run_id=run.id AND c.student_id=a.student_id
                            ORDER BY coalesce(c.observed_at, c.recorded_at) DESC, c.id DESC LIMIT 1) l ON true
       WHERE a.district_id=d AND a.school_id=p_school AND a.revoked_at IS NULL AND r.status='active'
       GROUP BY 1, 2) x;
  ELSE
    RAISE EXCEPTION 'unknown Edison source %', p_kind;
  END IF;
  RETURN jsonb_build_object('cells', cells);
END; $$;

-- What the gate must refuse to release (stays on the server).
CREATE FUNCTION eduos_edison_identifiers() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district();
BEGIN
  IF d IS NULL OR NOT (eduos_ctx_role()='superintendent' OR (eduos_ctx_role() IN ('principal','vice_principal') AND eduos_ctx_school() IS NOT NULL)) THEN
    RAISE EXCEPTION 'Edison: school leader scope required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'ids', (SELECT coalesce(jsonb_agg(id::text), '[]') FROM students WHERE district_id=d),
    'numbers', (SELECT coalesce(jsonb_agg(local_student_number), '[]') FROM students WHERE district_id=d),
    'names', (SELECT coalesce(jsonb_agg(DISTINCT n), '[]') FROM (
       SELECT display_name n FROM students WHERE district_id=d
       UNION SELECT full_name FROM pickup_adults WHERE district_id=d
       UNION SELECT u.display_name FROM student_user_links l JOIN users u ON u.id=l.user_id WHERE l.district_id=d) x));
END; $$;

REVOKE ALL ON FUNCTION eduos_edison_allowed(uuid), eduos_edison_source(text, uuid, date), eduos_edison_identifiers() FROM PUBLIC;

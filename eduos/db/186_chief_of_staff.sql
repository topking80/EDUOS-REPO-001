-- COS-01: the district Chief of Staff (docs/CHIEF-OF-STAFF.md).
-- A district role in the superintendent's office for coordination only:
--   * district-wide counts and status, never student records;
--   * a follow-up tracker: items with an owner, a due date and a status;
--   * a read-only view of how many requests wait for a decision, and for how
--     long. The superintendent keeps every decision.
-- The role holds no school (like the superintendent and district IT). It is not
-- added to eduos_is_district_role() or to any existing policy's role list, so
-- every student, staff and family table stays closed to it. The CASE
-- policies' ELSE branch compares rows with the caller's school, and this role
-- has none, so it matches nothing. Its only reads are this file's tables and
-- definers.

-- ---------------------------------------------------------------- the role
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = 'memberships'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%school_secretary%'
  LOOP EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', r.conname); END LOOP;
  ALTER TABLE memberships ADD CONSTRAINT memberships_role_186_check CHECK (role IN
   ('superintendent','it_admin','chief_of_staff','principal','vice_principal','teacher','parent','pupil','driver','sro','librarian','counselor','nurse','maintenance','lunch_staff','coach','school_secretary'));
END $$;
ALTER TABLE memberships ADD CONSTRAINT memberships_chief_of_staff_no_school CHECK (role <> 'chief_of_staff' OR school_id IS NULL);

-- ------------------------------------------------------ closed by default
-- Many read and write policies let any staff role in (db/180 keeps family
-- links and rosters district-wide for staff; insert and update checks often
-- say "not a pupil or parent"), so a new staff role would inherit them. This
-- role is closed instead: every table with row security gets one more
-- restrictive policy that admits nobody acting as chief of staff, except the
-- reviewed list below. Definers run as the table owner and are unaffected, so
-- the overview's counts still work.
-- Open to the role:
--   cos_followups                 its own tracker (policies below)
--   districts, schools            names, for the overview and follow-ups
--   branding_profiles             the app's look
--   user_preferences              its own display settings
--   notification_outbox           its own notifications (existing per-user policy)
--   users, memberships, district_users   staff only, never families or learners (below)
--   audit_events                  it may write its own audit rows, not read the log
-- A table created later closes itself with eduos_close_to_chief_of_staff('<table>');
-- test/integration/rls-coverage.test.js fails until it does or is reviewed.
CREATE FUNCTION eduos_close_to_chief_of_staff(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DROP POLICY IF EXISTS no_chief_of_staff ON %s', p_table);
  EXECUTE format($p$CREATE POLICY no_chief_of_staff ON %s AS RESTRICTIVE FOR ALL
    USING ((SELECT eduos_is_table_owner()) OR coalesce((SELECT eduos_ctx_role()), '') <> 'chief_of_staff')
    WITH CHECK ((SELECT eduos_is_table_owner()) OR coalesce((SELECT eduos_ctx_role()), '') <> 'chief_of_staff')$p$, p_table);
END $$;
REVOKE ALL ON FUNCTION eduos_close_to_chief_of_staff(regclass) FROM PUBLIC;
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT k.oid::regclass AS rel FROM pg_class k JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
            WHERE k.relkind = 'r' AND k.relrowsecurity
              AND k.relname NOT IN ('districts','schools','branding_profiles','user_preferences','notification_outbox','users','memberships','district_users','audit_events')
  LOOP PERFORM eduos_close_to_chief_of_staff(t.rel); END LOOP;
END $$;

-- Staff only: a user, membership or district-user row is visible to the role
-- only when it is the caller's own or belongs to someone with an active staff
-- membership in the district (never a family or learner account).
CREATE FUNCTION eduos_is_district_staff(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = p_user AND m.district_id = eduos_ctx_district()
                  AND m.status = 'active' AND m.role NOT IN ('parent','pupil'))
$$;
REVOKE ALL ON FUNCTION eduos_is_district_staff(uuid) FROM PUBLIC;
-- users, memberships and district_users had no row security (the API checks
-- them). Row security is enabled, not forced, with one permissive policy that
-- keeps every existing reader and writer as it was; the restrictive policies
-- below then narrow only this role. The table owner (migrations, definers) is
-- unaffected.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','memberships','district_users'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY as_before ON %I USING (true) WITH CHECK (true)', t);
  END LOOP;
END $$;
CREATE POLICY chief_of_staff_staff_only ON users AS RESTRICTIVE FOR SELECT
  USING ((SELECT eduos_is_table_owner()) OR coalesce((SELECT eduos_ctx_role()), '') <> 'chief_of_staff'
         OR id = (SELECT eduos_ctx_user()) OR eduos_is_district_staff(id));
CREATE POLICY chief_of_staff_staff_only ON memberships AS RESTRICTIVE FOR SELECT
  USING ((SELECT eduos_is_table_owner()) OR coalesce((SELECT eduos_ctx_role()), '') <> 'chief_of_staff'
         OR user_id = (SELECT eduos_ctx_user()) OR role NOT IN ('parent','pupil'));
CREATE POLICY chief_of_staff_staff_only ON district_users AS RESTRICTIVE FOR SELECT
  USING ((SELECT eduos_is_table_owner()) OR coalesce((SELECT eduos_ctx_role()), '') <> 'chief_of_staff'
         OR user_id = (SELECT eduos_ctx_user()) OR eduos_is_district_staff(user_id));
CREATE POLICY chief_of_staff_writes_only ON audit_events AS RESTRICTIVE FOR SELECT
  USING ((SELECT eduos_is_table_owner()) OR coalesce((SELECT eduos_ctx_role()), '') <> 'chief_of_staff');
-- Changes to accounts and memberships stay with district administrators.
CREATE POLICY chief_of_staff_no_account_changes ON users AS RESTRICTIVE FOR UPDATE
  USING ((SELECT eduos_is_table_owner()) OR coalesce((SELECT eduos_ctx_role()), '') <> 'chief_of_staff' OR id = (SELECT eduos_ctx_user()));
CREATE POLICY chief_of_staff_no_membership_changes ON memberships AS RESTRICTIVE FOR UPDATE
  USING ((SELECT eduos_is_table_owner()) OR coalesce((SELECT eduos_ctx_role()), '') <> 'chief_of_staff');

-- ------------------------------------------------------------ follow-ups
CREATE TABLE cos_followups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  detail text CHECK (detail IS NULL OR char_length(detail) <= 2000),
  owner_user_id uuid NOT NULL REFERENCES users(id),
  due_on date,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  close_note text CHECK (close_note IS NULL OR char_length(close_note) <= 500),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  CHECK ((status IN ('done','cancelled')) = (closed_at IS NOT NULL)),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id)
);
CREATE INDEX cos_followups_district_status ON cos_followups(district_id, status, due_on);
CREATE INDEX cos_followups_owner ON cos_followups(owner_user_id, status);

-- The superintendent's office: the chief of staff and the superintendent.
CREATE FUNCTION eduos_cos_office() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.role', true), '') IN ('chief_of_staff', 'superintendent')
$$;

ALTER TABLE cos_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE cos_followups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cos_followups
  USING (eduos_is_table_owner() OR district_id = eduos_ctx_district())
  WITH CHECK (eduos_is_table_owner() OR district_id = eduos_ctx_district());
-- The office reads and manages every item; an owner reads and updates their own.
CREATE POLICY followup_read ON cos_followups AS RESTRICTIVE FOR SELECT
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE (SELECT eduos_cos_office()) OR owner_user_id = (SELECT eduos_ctx_user()) END);
CREATE POLICY followup_insert ON cos_followups AS RESTRICTIVE FOR INSERT
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE (SELECT eduos_cos_office()) AND created_by = (SELECT eduos_ctx_user()) END);
CREATE POLICY followup_update ON cos_followups AS RESTRICTIVE FOR UPDATE
  USING (CASE WHEN eduos_is_table_owner() THEN true ELSE (SELECT eduos_cos_office()) OR owner_user_id = (SELECT eduos_ctx_user()) END)
  WITH CHECK (CASE WHEN eduos_is_table_owner() THEN true ELSE (SELECT eduos_cos_office()) OR owner_user_id = (SELECT eduos_ctx_user()) END);

-- An owner outside the office moves only the status and the closing note;
-- the office alone changes what the item is, who owns it and when it's due.
CREATE FUNCTION eduos_cos_followup_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT eduos_is_table_owner() AND NOT eduos_cos_office() AND (
       NEW.title IS DISTINCT FROM OLD.title OR NEW.detail IS DISTINCT FROM OLD.detail OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.due_on IS DISTINCT FROM OLD.due_on OR NEW.school_id IS DISTINCT FROM OLD.school_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.district_id IS DISTINCT FROM OLD.district_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (NEW.status = 'cancelled' AND OLD.status <> 'cancelled')) THEN
    RAISE EXCEPTION 'cos_followup_owner_may_only_update_status' USING ERRCODE = '42501';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER cos_followup_guard BEFORE UPDATE ON cos_followups FOR EACH ROW EXECUTE FUNCTION eduos_cos_followup_guard();

-- ------------------------------------------------- staff the office assigns to
-- Active staff in the caller's district (never families or learners): user,
-- name, role and school, for choosing a follow-up's owner.
CREATE FUNCTION eduos_cos_staff() RETURNS TABLE(user_id uuid, display_name text, role text, school_id uuid, school_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT eduos_cos_office() OR eduos_ctx_district() IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT DISTINCT ON (u.id) u.id, u.display_name, m.role, m.school_id, s.name
    FROM memberships m JOIN users u ON u.id = m.user_id AND u.status = 'active'
    LEFT JOIN schools s ON s.id = m.school_id AND s.district_id = m.district_id
   WHERE m.district_id = eduos_ctx_district() AND m.status = 'active' AND m.role NOT IN ('parent','pupil')
   ORDER BY u.id, (m.school_id IS NULL) DESC, m.role;
END $$;

-- ---------------------------------------------------- the district at a glance
-- Per active school: today's attendance totals (each total under 5 is withheld
-- as null, so a small school's few absences can't point at a child), active
-- safety incidents, open service work, substitute coverage still needed, and
-- how many requests wait for a decision, with the oldest one's age in days.
-- Counts only; no names, no ids of people, no record text.
CREATE FUNCTION eduos_cos_overview() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d uuid := eduos_ctx_district(); out jsonb;
BEGIN
  IF NOT eduos_cos_office() OR d IS NULL THEN RETURN NULL; END IF;
  WITH sc AS (SELECT id, name, eduos_school_today(id) AS today FROM schools WHERE district_id = d AND status = 'active'),
  att AS (
    SELECT s.school_id, ae.status, count(*)::int AS n FROM attendance_events ae
      JOIN students s ON s.id = ae.student_id AND s.district_id = ae.district_id
      JOIN sc ON sc.id = s.school_id
     WHERE ae.district_id = d AND ae.event_date = sc.today GROUP BY 1, 2),
  waiting AS (
    SELECT school_id, kind, count(*)::int AS n, max(now() - created_at) AS oldest FROM (
      SELECT school_id, 'access_request' AS kind, created_at FROM access_requests WHERE district_id = d AND status = 'pending'
      UNION ALL SELECT school_id, 'app_request', created_at FROM app_requests WHERE district_id = d AND status = 'pending'
      UNION ALL SELECT school_id, 'enrollment_review', created_at FROM enrollment_applications WHERE district_id = d AND status = 'review'
      UNION ALL SELECT school_id, 'coverage_request', created_at FROM substitute_coverage_requests WHERE district_id = d AND status = 'pending' AND ends_at >= now()
    ) w GROUP BY 1, 2)
  SELECT jsonb_build_object(
    'generatedAt', now(),
    'schools', coalesce(jsonb_agg(jsonb_build_object(
      'schoolId', sc.id, 'name', sc.name, 'day', sc.today,
      'attendance', jsonb_build_object(
        'marked', (SELECT CASE WHEN sum(n) >= 5 THEN sum(n)::int END FROM att WHERE att.school_id = sc.id),
        'present', (SELECT CASE WHEN n >= 5 THEN n END FROM att WHERE att.school_id = sc.id AND att.status = 'present'),
        'absent', (SELECT CASE WHEN n >= 5 THEN n END FROM att WHERE att.school_id = sc.id AND att.status = 'absent'),
        'tardy', (SELECT CASE WHEN n >= 5 THEN n END FROM att WHERE att.school_id = sc.id AND att.status = 'tardy')),
      'activeSafetyIncidents', (SELECT count(*)::int FROM safety_incidents i WHERE i.district_id = d AND i.school_id = sc.id AND i.status IN ('pending','active','reunification')),
      'openServiceWork', (SELECT count(*)::int FROM school_service_work w WHERE w.district_id = d AND w.school_id = sc.id AND w.status IN ('open','in_progress')),
      'coverageNeeded', (SELECT count(*)::int FROM substitute_coverage_requests c WHERE c.district_id = d AND c.school_id = sc.id AND c.status IN ('pending','approved') AND c.ends_at >= now()),
      'waiting', coalesce((SELECT jsonb_object_agg(kind, jsonb_build_object('count', n, 'oldestDays', floor(extract(epoch FROM oldest) / 86400)::int))
                             FROM waiting WHERE waiting.school_id = sc.id), '{}'::jsonb)
    ) ORDER BY sc.name), '[]'::jsonb),
    'district', jsonb_build_object('waiting', coalesce((SELECT jsonb_object_agg(kind, jsonb_build_object('count', n, 'oldestDays', floor(extract(epoch FROM oldest) / 86400)::int))
                             FROM waiting WHERE waiting.school_id IS NULL), '{}'::jsonb)))
    INTO out FROM sc;
  RETURN out;
END $$;

REVOKE ALL ON FUNCTION eduos_cos_staff(), eduos_cos_overview() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON cos_followups TO eduos_app;
    GRANT EXECUTE ON FUNCTION eduos_cos_office(), eduos_cos_staff(), eduos_cos_overview(), eduos_is_district_staff(uuid) TO eduos_app;
  END IF;
END $$;

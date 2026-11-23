-- COACH-01: a teacher can coach (or advise) a team at another school in the
-- district. The principal of the team's school assigns them; they get a
-- "coach" profile (membership) at that school, which reaches only the teams
-- they are assigned to there (rosters, eligibility and permission slips stay
-- limited to activity staff by db/060). Their own school is unaffected.
--
-- Assignments end (ended_at) rather than being deleted; when a coach's last
-- assignment at a school ends, their coach profile there is disabled.

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='memberships'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%lunch_staff%'
  LOOP EXECUTE format('ALTER TABLE memberships DROP CONSTRAINT %I', r.conname); END LOOP;
  ALTER TABLE memberships ADD CONSTRAINT memberships_role_105_check CHECK(role IN
   ('superintendent','it_admin','principal','vice_principal','teacher','parent','pupil','driver','sro','librarian','counselor','nurse','maintenance','lunch_staff','coach'));
END $$;

ALTER TABLE activity_staff ADD COLUMN ended_at timestamptz, ADD COLUMN ended_by uuid REFERENCES users(id);

-- Activity staff: a teacher at the team's school, or a coach profile there; current assignments only.
CREATE OR REPLACE FUNCTION eduos_is_activity_staff(p_activity uuid, p_roles text[] DEFAULT ARRAY['advisor','coach']) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT eduos_ctx_role() IN ('teacher','coach') AND EXISTS(SELECT 1 FROM activity_staff s WHERE s.district_id=eduos_ctx_district()
    AND s.activity_id=p_activity AND s.user_id=eduos_ctx_user() AND s.school_id=eduos_ctx_school() AND s.staff_role=ANY(p_roles) AND s.ended_at IS NULL)
$$;

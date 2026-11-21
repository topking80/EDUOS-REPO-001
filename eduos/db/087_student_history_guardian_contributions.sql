-- TC-02: guardian-submitted family memories enter a moderated contribution queue.
-- Approval creates a published family-memory history entry; submissions never
-- mutate official records or bypass district-controlled storage policy.

CREATE TABLE student_history_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  guardian_user_id uuid NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 180),
  body text NOT NULL DEFAULT '' CHECK (length(body) <= 12000),
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted','approved','rejected','withdrawn')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_note text CHECK (review_note IS NULL OR length(review_note) <= 1000),
  history_entry_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id, id),
  FOREIGN KEY (district_id, student_id) REFERENCES students(district_id, id),
  FOREIGN KEY (district_id, guardian_user_id) REFERENCES district_users(district_id, user_id),
  FOREIGN KEY (district_id, reviewed_by) REFERENCES district_users(district_id, user_id),
  FOREIGN KEY (district_id, school_id, student_id, history_entry_id)
    REFERENCES student_history_entries(district_id, school_id, student_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'submitted' AND reviewed_by IS NULL AND reviewed_at IS NULL AND history_entry_id IS NULL)
    OR (status = 'withdrawn' AND reviewed_by IS NULL AND reviewed_at IS NULL AND history_entry_id IS NULL)
    OR (status = 'rejected' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND history_entry_id IS NULL)
    OR (status = 'approved' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND history_entry_id IS NOT NULL)
  ),
  UNIQUE (district_id, school_id, student_id, id)
);
CREATE INDEX student_history_contributions_guardian_idx
  ON student_history_contributions(district_id, guardian_user_id, created_at DESC);
CREATE INDEX student_history_contributions_review_queue_idx
  ON student_history_contributions(district_id, school_id, status, created_at)
  WHERE status = 'submitted';

CREATE TABLE student_history_contribution_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid NOT NULL,
  student_id uuid NOT NULL,
  contribution_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('submitted','approved','rejected','withdrawn')),
  detail text CHECK (detail IS NULL OR length(detail) <= 1000),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id, student_id, contribution_id)
    REFERENCES student_history_contributions(district_id, school_id, student_id, id) ON DELETE CASCADE,
  FOREIGN KEY (district_id, actor_user_id) REFERENCES district_users(district_id, user_id)
);
CREATE INDEX student_history_contribution_events_idx
  ON student_history_contribution_events(district_id, contribution_id, occurred_at);

CREATE FUNCTION eduos_history_contribution_event_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'student_history_contribution_events is append-only'
    USING ERRCODE = '55000';
END;
$$;
REVOKE ALL ON FUNCTION eduos_history_contribution_event_immutable() FROM PUBLIC;
CREATE TRIGGER student_history_contribution_events_append_only
  BEFORE UPDATE OR DELETE ON student_history_contribution_events
  FOR EACH ROW EXECUTE FUNCTION eduos_history_contribution_event_immutable();

DO $$
DECLARE t text;
        identity_column text;
BEGIN
  FOREACH t IN ARRAY ARRAY['student_history_contributions','student_history_contribution_events'] LOOP
    identity_column := CASE t WHEN 'student_history_contributions' THEN 'guardian_user_id' ELSE 'actor_user_id' END;
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    -- Reads are school-scoped for staff and limited to the current guardian's
    -- own contributions/events for actively linked children.
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT USING (
      district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
      AND (
        school_id = nullif(current_setting(''app.school_id'', true), '''')::uuid
        OR current_setting(''app.role'', true) = ''superintendent''
        OR (current_setting(''app.role'', true) = ''parent''
          AND %I = nullif(current_setting(''app.user_id'', true), '''')::uuid
          AND EXISTS (
            SELECT 1 FROM student_user_links l
             WHERE l.district_id = %I.district_id
               AND l.student_id = %I.student_id
               AND l.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
               AND l.status = ''active'' AND l.relationship IN (''parent'',''guardian'')
          ))
      )
    )', t || '_read_scope', t, identity_column, t, t);

    IF t = 'student_history_contributions' THEN
      -- Only a linked guardian can create a pending contribution. Review
      -- decisions are a separate UPDATE capability for school leadership.
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
        district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
        AND current_setting(''app.role'', true) = ''parent''
        AND guardian_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
        AND status = ''submitted'' AND reviewed_by IS NULL
        AND reviewed_at IS NULL AND history_entry_id IS NULL AND review_note IS NULL
        AND EXISTS (
          SELECT 1 FROM student_user_links l
           WHERE l.district_id = %I.district_id
             AND l.student_id = %I.student_id
             AND l.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
             AND l.status = ''active'' AND l.relationship IN (''parent'',''guardian'')
        )
      )', t || '_guardian_insert', t, t, t);

      -- Guardians may withdraw only their own still-pending submission.
      -- The column grants and WITH CHECK prevent changing the review decision.
      EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE
        USING (
          district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
          AND current_setting(''app.role'', true) = ''parent''
          AND guardian_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
          AND status = ''submitted''
          AND EXISTS (
            SELECT 1 FROM student_user_links l
             WHERE l.district_id = %I.district_id
               AND l.student_id = %I.student_id
               AND l.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
               AND l.status = ''active'' AND l.relationship IN (''parent'',''guardian'')
          )
        )
        WITH CHECK (
          district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
          AND current_setting(''app.role'', true) = ''parent''
          AND guardian_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
          AND status = ''withdrawn' AND reviewed_by IS NULL
          AND reviewed_at IS NULL AND history_entry_id IS NULL AND review_note IS NULL
          AND EXISTS (
            SELECT 1 FROM student_user_links l
             WHERE l.district_id = %I.district_id
               AND l.student_id = %I.student_id
               AND l.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
               AND l.status = ''active'' AND l.relationship IN (''parent'',''guardian'')
          )
        )', t || '_guardian_withdraw', t, t, t, t, t);

      EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE
        USING (
          district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
          AND (school_id = nullif(current_setting(''app.school_id'', true), '''')::uuid
            OR current_setting(''app.role'', true) = ''superintendent'')
          AND current_setting(''app.role'', true) IN (''principal'',''superintendent'')
          AND status = ''submitted''
          AND guardian_user_id <> nullif(current_setting(''app.user_id'', true), '''')::uuid
        )
        WITH CHECK (
          district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
          AND (school_id = nullif(current_setting(''app.school_id'', true), '''')::uuid
            OR current_setting(''app.role'', true) = ''superintendent'')
          AND current_setting(''app.role'', true) IN (''principal'',''superintendent'')
          AND reviewed_by = nullif(current_setting(''app.user_id'', true), '''')::uuid
          AND status IN (''approved'',''rejected'') AND reviewed_at IS NOT NULL
        )', t || '_review_update', t);
    ELSE
      -- Event inserts are always attributed to the authenticated actor.
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT WITH CHECK (
        district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid
        AND actor_user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
        AND (
          school_id = nullif(current_setting(''app.school_id'', true), '''')::uuid
          OR current_setting(''app.role'', true) = ''superintendent''
          OR (current_setting(''app.role'', true) = ''parent'' AND EXISTS (
            SELECT 1 FROM student_user_links l
             WHERE l.district_id = %I.district_id
               AND l.student_id = %I.student_id
               AND l.user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid
               AND l.status = ''active'' AND l.relationship IN (''parent'',''guardian'')
          ))
        )
      )', t || '_actor_insert', t, t, t);
    END IF;
  END LOOP;
END;
$$;

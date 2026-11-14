-- Phase 32: unified Student 360 intervention cases and append-only case history.
CREATE TABLE student_intervention_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  student_id uuid NOT NULL,
  school_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  owner_user_id uuid REFERENCES users(id),
  category text NOT NULL CHECK(category IN ('academic','attendance','behavior','wellbeing','family_support','other')),
  priority text NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','monitoring','closed')),
  title text NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 180),
  summary text NOT NULL CHECK(length(trim(summary)) BETWEEN 1 AND 4000),
  support_plan text NOT NULL DEFAULT '' CHECK(length(support_plan) <= 8000),
  family_visible boolean NOT NULL DEFAULT false,
  follow_up_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  FOREIGN KEY(district_id,school_id) REFERENCES schools(district_id,id),
  UNIQUE(district_id,id),
  CHECK((status='closed' AND closed_at IS NOT NULL) OR (status<>'closed' AND closed_at IS NULL))
);
CREATE INDEX intervention_cases_student ON student_intervention_cases(district_id,student_id,created_at DESC);
CREATE INDEX intervention_cases_school_status ON student_intervention_cases(district_id,school_id,status,priority);

CREATE TABLE student_case_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  case_id uuid NOT NULL,
  student_id uuid NOT NULL,
  author_user_id uuid NOT NULL REFERENCES users(id),
  note text NOT NULL CHECK(length(trim(note)) BETWEEN 1 AND 4000),
  family_visible boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(district_id,case_id) REFERENCES student_intervention_cases(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id)
);
CREATE INDEX student_case_notes_case ON student_case_notes(district_id,case_id,created_at);

CREATE FUNCTION reject_case_note_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'student_case_notes are append-only'; END; $$;
CREATE TRIGGER case_notes_no_update BEFORE UPDATE OR DELETE ON student_case_notes
FOR EACH ROW EXECUTE FUNCTION reject_case_note_mutation();

ALTER TABLE student_intervention_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_intervention_cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student_intervention_cases
USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
ALTER TABLE student_case_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_case_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON student_case_notes
USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

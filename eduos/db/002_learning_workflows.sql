-- Phase 26.1: assignments and submissions
CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  school_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  instructions text NOT NULL DEFAULT '',
  due_at timestamptz,
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('draft','published','closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (district_id, school_id) REFERENCES schools(district_id,id),
  UNIQUE(district_id,id)
);
CREATE TABLE assignment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id uuid NOT NULL REFERENCES districts(id),
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  response_text text NOT NULL DEFAULT '',
  submitted_at timestamptz NOT NULL DEFAULT now(),
  score numeric(5,2) CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  feedback text,
  graded_by uuid REFERENCES users(id),
  graded_at timestamptz,
  FOREIGN KEY(district_id,assignment_id) REFERENCES assignments(district_id,id),
  FOREIGN KEY(district_id,student_id) REFERENCES students(district_id,id),
  UNIQUE(assignment_id,student_id)
);
CREATE INDEX assignments_school_due ON assignments(district_id,school_id,due_at);
CREATE INDEX submissions_student ON assignment_submissions(district_id,student_id,submitted_at DESC);
ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assignments
USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);
ALTER TABLE assignment_submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_submissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assignment_submissions
USING (district_id = nullif(current_setting('app.district_id', true), '')::uuid)
WITH CHECK (district_id = nullif(current_setting('app.district_id', true), '')::uuid);

-- AI gateway for staff (ported from EdOS app/backend/app/ai, rebuilt on EduOS
-- identity, permissions and tenant boundaries).
--
-- Every staff AI use case (lesson drafts, summaries, writing feedback,
-- operations brief) is OFF until the superintendent turns it on for the
-- district, and each district sets daily token budgets (district-wide and per
-- person). AI never queries student records on its own: a request carries only
-- the text the staff member typed, or, for the operations brief, counts EduOS
-- computes from what that person may already see. Usage is recorded without
-- the prompt or the answer.

CREATE TABLE ai_district_policy (
  district_id uuid PRIMARY KEY REFERENCES districts(id) ON DELETE CASCADE,
  enabled_usecases text[] NOT NULL DEFAULT '{}'
    CHECK (enabled_usecases <@ ARRAY['lesson_draft','resource_summary','writing_feedback','ops_brief']::text[]),
  daily_token_cap integer NOT NULL DEFAULT 200000 CHECK (daily_token_cap BETWEEN 0 AND 100000000),
  user_daily_token_cap integer NOT NULL DEFAULT 20000 CHECK (user_daily_token_cap BETWEEN 0 AND 10000000),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ai_usage (
  id bigserial PRIMARY KEY,
  district_id uuid NOT NULL REFERENCES districts(id) ON DELETE CASCADE,
  school_id uuid,
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL,
  usecase text NOT NULL CHECK (usecase IN ('lesson_draft','resource_summary','writing_feedback','ops_brief')),
  provider text NOT NULL CHECK (provider IN ('local','openai_compatible')),
  outcome text NOT NULL CHECK (outcome IN ('ok','fallback')),
  tokens_in integer NOT NULL CHECK (tokens_in >= 0),
  tokens_out integer NOT NULL CHECK (tokens_out >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_district_day ON ai_usage(district_id, created_at);
CREATE INDEX ai_usage_user_day ON ai_usage(user_id, created_at);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ai_district_policy','ai_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid) '
                   'WITH CHECK (eduos_is_table_owner() OR district_id = nullif(current_setting(''app.district_id'', true), '''')::uuid)', t || '_tenant_scope', t);
  END LOOP;
END $$;

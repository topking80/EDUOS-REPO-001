-- AI budgets are reserved before a model is called (audit, medium): each
-- request first inserts a 'pending' usage row for the most it may use, under a
-- per-district lock, then settles it to what it used ('ok'/'fallback'), or
-- gives it back ('failed'). Simultaneous requests can no longer all pass the
-- same budget check. A 'pending' row older than 15 minutes is a request that
-- never finished and no longer counts.
ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_outcome_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_outcome_check CHECK (outcome IN ('pending','ok','fallback','failed'));

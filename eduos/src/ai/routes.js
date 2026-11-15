// Staff AI gateway routes (src/ai/gateway.js has the rules).
import rateLimit from "express-rate-limit";
import { config } from "../config.js";
import { requireSession, requireCsrf } from "../auth.js";
import { withTenantTransaction } from "../db.js";
import { HttpError, audit, sendError } from "../role-app-util.js";
import { USECASES, POLICY_EDITORS, POLICY_READERS, denial, policyOf, usedToday, opsContext, namesToRedact, estimateTokens } from "./gateway.js";
import { createProvider } from "./providers.js";

export function registerAiRoutes(app, { provider = createProvider(config) } = {}) {
  const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => `ai:${req.actor?.userId}` });
  const external = provider.name !== "local";

  app.get("/api/ai/status", requireSession, async (req, res, next) => {
    const a = req.actor;
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const p = await policyOf(c, a.districtId), used = await usedToday(c, a.districtId, a.userId);
        return { provider: external ? "external" : "local",
          usecases: Object.entries(USECASES).filter(([, u]) => u.roles.includes(a.role))
            .map(([id, u]) => ({ id, label: u.label, enabled: p.enabled_usecases.includes(id), input: u.input })),
          budget: { district: { used: used.district, cap: p.daily_token_cap }, you: { used: used.user, cap: p.user_daily_token_cap } } };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.post("/api/ai/run", requireSession, requireCsrf, limiter, async (req, res, next) => {
    const a = req.actor, usecase = req.body?.usecase, u = USECASES[usecase];
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!u) return res.status(400).json({ error: "unknown_ai_usecase" });
    if (u.input && (text.length < u.input.min || text.length > u.input.max)) return res.status(400).json({ error: "ai_input_length", min: u.input.min, max: u.input.max });
    try {
      // 1. Policy, role, budget and (for the brief) the data, in the caller's own scope.
      const prep = await withTenantTransaction(a, async (c) => {
        const p = await policyOf(c, a.districtId);
        const why = denial({ usecase, role: a.role, enabled: p.enabled_usecases });
        if (why) throw new HttpError(403, why);
        const used = await usedToday(c, a.districtId, a.userId), est = estimateTokens(text) + 300;
        if (used.district + est > p.daily_token_cap) throw new HttpError(429, "ai_district_budget_reached");
        if (used.user + est > p.user_daily_token_cap) throw new HttpError(429, "ai_your_budget_reached");
        const input = usecase === "ops_brief" ? { context: await opsContext(c, a) } : { text };
        const names = external && usecase !== "ops_brief" ? await namesToRedact(c, a) : []; // any pasted text may name a student
        return { input, names };
      });
      // 2. The model (outside any transaction).
      const out = await provider.generate(usecase, prep.input, { names: prep.names });
      const tokensIn = out.usage?.prompt_tokens ?? estimateTokens(prep.input.text ?? JSON.stringify(prep.input.context));
      const tokensOut = out.usage?.completion_tokens ?? estimateTokens(out.text);
      // 3. Usage (no prompt, no answer) and audit.
      await withTenantTransaction(a, async (c) => {
        await c.query(`INSERT INTO ai_usage(district_id, school_id, user_id, role, usecase, provider, outcome, tokens_in, tokens_out)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [a.districtId, a.schoolId || null, a.userId, a.role, usecase, out.fallback || !external ? "local" : "openai_compatible",
          out.fallback ? "fallback" : "ok", tokensIn, tokensOut]);
        await audit(c, req, `ai_${usecase}`, "ai_usage", null, `tokens=${tokensIn}+${tokensOut}; provider=${external && !out.fallback ? "external" : "local"}`);
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data: { usecase, text: out.text, source: external && !out.fallback ? "external" : "local", tokens: tokensIn + tokensOut,
        ...(usecase === "ops_brief" ? { basis: prep.input.context } : {}) } });
    } catch (e) {
      if (e.status === 403 && e.message === "school_scope_required") return res.status(403).json({ error: "school_scope_required" });
      sendError(res, next, e);
    }
  });

  app.get("/api/ai/policy", requireSession, async (req, res, next) => {
    if (!POLICY_READERS.includes(req.actor.role)) return res.status(403).json({ error: "ai_policy_access_denied" });
    try {
      const data = await withTenantTransaction(req.actor, async (c) => {
        const p = await policyOf(c, req.actor.districtId);
        const usage = (await c.query(`SELECT usecase, count(*)::int AS calls, sum(tokens_in + tokens_out)::int AS tokens
            FROM ai_usage WHERE district_id = $1 AND created_at >= now() - interval '30 days' GROUP BY usecase ORDER BY usecase`, [req.actor.districtId])).rows;
        return { policy: p, usecases: Object.entries(USECASES).map(([id, u]) => ({ id, label: u.label, roles: u.roles })),
          usage30d: usage, provider: external ? "external" : "local", canEdit: POLICY_EDITORS.includes(req.actor.role) };
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.put("/api/ai/policy", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!POLICY_EDITORS.includes(a.role)) return res.status(403).json({ error: "ai_policy_edit_denied" });
    const ok = Array.isArray(b.enabledUsecases) && b.enabledUsecases.every(x => USECASES[x]) && new Set(b.enabledUsecases).size === b.enabledUsecases.length
      && Number.isInteger(b.dailyTokenCap) && b.dailyTokenCap >= 0 && b.dailyTokenCap <= 100000000
      && Number.isInteger(b.userDailyTokenCap) && b.userDailyTokenCap >= 0 && b.userDailyTokenCap <= 10000000;
    if (!ok) return res.status(400).json({ error: "invalid_ai_policy" });
    try {
      const data = await withTenantTransaction(a, async (c) => {
        const r = (await c.query(`INSERT INTO ai_district_policy(district_id, enabled_usecases, daily_token_cap, user_daily_token_cap, updated_by, updated_at)
            VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (district_id) DO UPDATE SET enabled_usecases=EXCLUDED.enabled_usecases,
              daily_token_cap=EXCLUDED.daily_token_cap, user_daily_token_cap=EXCLUDED.user_daily_token_cap, updated_by=EXCLUDED.updated_by, updated_at=now()
            RETURNING enabled_usecases, daily_token_cap, user_daily_token_cap, updated_at`, [a.districtId, b.enabledUsecases, b.dailyTokenCap, b.userDailyTokenCap, a.userId])).rows[0];
        await audit(c, req, "update", "ai_district_policy", null, `enabled=${b.enabledUsecases.join(",") || "none"}; caps=${b.dailyTokenCap}/${b.userDailyTokenCap}`);
        return r;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });
}

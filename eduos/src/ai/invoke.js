// One staff-AI call through the gateway: policy and role, redaction list,
// atomic budget reservation, the model with a deadline, settled usage and an
// audit row. Moved here unchanged from /api/ai/run (src/ai/routes.js) in
// 37.6.0 so Leo (src/ai/leo.js) and Edison (src/ai/edison.js) go through
// exactly the same path. Prompts and answers are never stored by the gateway.
import { config } from "../config.js";
import { withTenantTransaction } from "../db.js";
import { HttpError, audit } from "../role-app-util.js";
import { denial, policyOf, reserveBudget } from "./gateway.js";
import { externalRequestBody, maxTokensFor, localProvider, capLocalOutput, localUnits, OUTPUT_MAX_TOKENS } from "./providers.js";

/** Runs the model, but never longer than the deadline: then the local answer. */
export function withDeadline(work, ms, fallback) {
  let timer;
  return Promise.race([work, new Promise(resolve => { timer = setTimeout(() => resolve(fallback()), ms); timer.unref?.(); })])
    .finally(() => clearTimeout(timer));
}

/**
 * prepare(c) runs in the caller's tenant transaction after the policy check
 * and returns { input, identifiers }. settle(c, out, info) (optional) runs in
 * the same transaction that settles the usage row; its result is returned as
 * `extra`. If settle throws, usage is handled as for any other failure.
 * Returns { out, tokensIn, tokensOut, input, usageId, extra, source }.
 */
export async function invokeAi(req, { provider, usecase, prepare, settle }) {
  const a = req.actor, external = provider.name !== "local";
  let reservation = null, reserved = 0, sentOut = false;
  try {
    // 1. Policy, role, the data and the redaction list, in the caller's own
    //    scope; then reserve budget atomically.
    const prep = await withTenantTransaction(a, async (c) => {
      const p = await policyOf(c, a.districtId);
      const why = denial({ usecase, role: a.role, enabled: p.enabled_usecases });
      if (why) throw new HttpError(403, why);
      const { input, identifiers = { names: [], numbers: [] } } = await prepare(c, { external });
      // Reserve a hard upper bound for exactly what would be sent (system
      // prompt, redacted text, output cap), whatever the tokenizer.
      const reserve = maxTokensFor(externalRequestBody({ model: "", usecase, input, identifiers }));
      const id = await reserveBudget(c, a, usecase, reserve).catch(e => { if (e.status === 429 || e.status === 403) throw new HttpError(e.status, e.message); throw e; });
      return { input, identifiers, id, reserve };
    });
    reservation = prep.id; reserved = prep.reserve;
    // 2. The model (outside any transaction). From here an external
    //    provider may have received, processed and billed the request,
    //    whatever happens next.
    sentOut = external;
    const out = await withDeadline(provider.generate(usecase, prep.input, { identifiers: prep.identifiers }), config.aiProviderTimeoutMs + 5000,
      async () => ({ text: capLocalOutput(await localProvider.generate(usecase, prep.input)), fallback: true }));
    // 3. Settle the reservation (no prompt, no answer) and audit. Never
    //    settle below what may really have been used:
    //    - reported: the provider's own usage numbers;
    //    - reserved: an external provider was called but gave no usable
    //      usage report, failed or timed out (it may still have processed
    //      and billed the request): the full reservation stands;
    //    - local: no external provider; EduOS's own meter (4 bytes a unit).
    let tokensIn, tokensOut, basis;
    if (!external) { basis = "local"; tokensIn = localUnits(prep.input.text ?? JSON.stringify(prep.input.context)); tokensOut = localUnits(out.text); }
    else if (!out.fallback && out.usage) { basis = "reported"; tokensIn = out.usage.prompt_tokens; tokensOut = out.usage.completion_tokens; }
    else { basis = "reserved"; tokensIn = prep.reserve - OUTPUT_MAX_TOKENS; tokensOut = OUTPUT_MAX_TOKENS; }
    // The reservation is a proven upper bound, so usage above it means the
    // provider reported more than it could have used: record what it
    // reported (that is what it will bill) and flag it.
    const over = tokensIn + tokensOut > prep.reserve;
    if (over) console.error(`ai usage ${tokensIn + tokensOut} exceeded its reservation ${prep.reserve} (district ${a.districtId})`);
    const source = external && !out.fallback ? "external" : "local";
    const extra = await withTenantTransaction(a, async (c) => {
      await c.query(`UPDATE ai_usage SET provider=$2, outcome=$3, tokens_in=$4, tokens_out=$5 WHERE id=$1 AND outcome='pending'`,
        [reservation, out.fallback || !external ? "local" : "openai_compatible", out.fallback ? "fallback" : "ok", tokensIn, tokensOut]);
      await audit(c, req, `ai_${usecase}`, "ai_usage", null, `tokens=${tokensIn}+${tokensOut}; usage=${basis}; reserved=${prep.reserve}; provider=${source}${over ? "; over_reservation" : ""}`);
      return settle ? settle(c, out, { source, usageId: prep.id }) : undefined;
    });
    const usageId = reservation;
    reservation = null;
    return { out, tokensIn, tokensOut, input: prep.input, usageId, extra, source };
  } catch (e) {
    if (reservation && !sentOut) {
      // Nothing left the server: the reservation is given back.
      await withTenantTransaction(a, (c) => c.query("UPDATE ai_usage SET outcome='failed', tokens_in=0, tokens_out=0 WHERE id=$1 AND outcome='pending'", [reservation])).catch(() => {});
    } else if (reservation) {
      // The provider was called and then our bookkeeping failed. Never give
      // that budget back: record the full reservation as used. If even this
      // fails, the row stays 'pending', which counts in full all day.
      console.error(`ai accounting failed after a provider call (district ${a.districtId}); keeping the reservation of ${reserved}: ${e.message}`);
      await withTenantTransaction(a, async (c) => {
        await c.query("UPDATE ai_usage SET provider='openai_compatible', outcome='fallback', tokens_in=$2, tokens_out=$3 WHERE id=$1 AND outcome='pending'", [reservation, reserved - OUTPUT_MAX_TOKENS, OUTPUT_MAX_TOKENS]);
        await audit(c, req, `ai_${usecase}`, "ai_usage", null, `tokens=${reserved}; usage=reserved; reserved=${reserved}; accounting_failed_after_provider_call`, "failure");
      }).catch(() => {});
    }
    throw e;
  }
}

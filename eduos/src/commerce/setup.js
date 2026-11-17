// EduOS 37.7.1 commerce: each district's payment setup. District
// administrators (superintendent, district IT) connect processors and choose
// what families are offered; checkout resolves the method to a processor and
// builds its adapter with the district's sealed credentials.
//
// Fail-closed rules, in order:
//   method not offered by the district        -> 409 payment_method_not_available
//   Visa/Mastercard with no card processor     -> 503 card_processor_not_chosen
//   adapter not built yet (e.g. Venmo)         -> 503 payment_adapter_not_available
//   processor not connected or switched off    -> 503 district_payment_provider_not_connected
//   live mode while COMMERCE_LIVE_PAYMENTS_ENABLED isn't "true"
//                                              -> 503 live_payments_disabled
//   no COMMERCE_SECRETS_KEY to open credentials-> 503 commerce_secrets_key_missing
//   a required credential missing              -> 503 provider_credentials_missing
import { config } from "../config.js";
import { request } from "../integrations/http.js";
import { validateWebhookUrl } from "../webhooks.js";
import { PROCESSORS, METHODS, CHECKOUT_METHODS, MODES, processorFor, adapterState } from "./catalog.js";
import { ADAPTERS, ProviderError } from "./adapters.js";
import { sandboxProvider } from "./payments.js";
import { sealSecrets, openSecrets } from "./secrets.js";
import { audit, one, HttpError } from "../role-app-util.js";

let transportOverride = null;
/** Unit tests only: replace the network with a mock. */
export function useTransportForTests(t) { transportOverride = t; }
async function defaultTransport(url, { method, headers, body, allowedHosts }) {
  const loop = Boolean(config.commerceTestApiBase);
  return request(url, { method, headers, body, options: { allowedHosts: loop ? [] : allowedHosts, allowInsecureLoopback: loop, timeoutMs: 15_000 } });
}

const SECRET_KEYS = p => PROCESSORS[p].fields.filter(x => x.secret).map(x => x.key);
const PLAIN_KEYS = p => PROCESSORS[p].fields.filter(x => !x.secret).map(x => x.key);
const REQUIRED = p => PROCESSORS[p].fields.filter(x => x.required).map(x => x.key);
const isProcessor = p => typeof p === "string" && Object.hasOwn(PROCESSORS, p) && p !== "sandbox";

/** Which required fields are still missing on an account row. */
export function missingFields(processor, row) {
  if (!row) return REQUIRED(processor);
  const have = new Set([...Object.keys(row.config || {}).filter(k => row.config[k]), ...(row.secret_fields || [])]);
  return REQUIRED(processor).filter(k => !have.has(k));
}
export const liveAllowed = () => config.commerceLivePaymentsEnabled === true;
/** not_set_up | test | live | live_blocked */
export function accountStatus(processor, row) {
  if (!row || missingFields(processor, row).length) return "not_set_up";
  if (row.mode === "live") return liveAllowed() ? "live" : "live_blocked";
  return "test";
}
export function accountOut(processor, row) {
  const p = PROCESSORS[processor];
  return { processor, label: p.label, enabled: Boolean(row?.enabled), mode: row?.mode || "test", status: accountStatus(processor, row),
    config: Object.fromEntries(PLAIN_KEYS(processor).map(k => [k, row?.config?.[k] ?? null])),
    // Write-only: only whether each secret is set, never its value.
    secretsSet: Object.fromEntries(SECRET_KEYS(processor).map(k => [k, Boolean(row?.secret_fields?.includes(k))])),
    missing: missingFields(processor, row),
    fee: { bps: row?.fee_bps ?? p.defaultFee.bps, fixedCents: row?.fee_fixed_cents ?? p.defaultFee.fixedCents },
    lastTest: row?.last_test_at ? { at: row.last_test_at, ok: row.last_test_ok, detail: row.last_test_detail } : null,
    updatedAt: row?.updated_at || null };
}

function endpoint(processor, mode, cfg) {
  if (config.commerceTestApiBase) return { base: `${config.commerceTestApiBase}/${processor}`, allowedHosts: [] };
  if (processor === "btcpay") {
    if (!config.commerceAllowedHosts.length) throw new ProviderError("provider_host_not_allowed", "btcpay: COMMERCE_ALLOWED_HOSTS is empty");
    const v = validateWebhookUrl(String(cfg.serverUrl || ""), { allowedHosts: config.commerceAllowedHosts });
    if (!v.ok || v.url.protocol !== "https:") throw new ProviderError("provider_host_not_allowed", `btcpay: ${v.reason || "https_required"}`);
    return { base: v.url.origin + v.url.pathname.replace(/\/+$/, ""), allowedHosts: config.commerceAllowedHosts };
  }
  const host = PROCESSORS[processor].hosts[mode];
  return { base: `https://${host}`, allowedHosts: [host] };
}

const fail = (status, code, extra = {}) => { throw new HttpError(status, code, extra); };

/** Build the adapter for a processor in this district (inside the caller's RLS transaction). */
export async function adapterFor(c, districtId, processor, opts = {}) {
  if (processor === "sandbox") return { adapter: sandboxProvider(), mode: "test" };
  if (!isProcessor(processor)) fail(400, "unknown_processor");
  const acct = await one(c, "SELECT * FROM eduos_commerce_checkout_account($1)", [processor]);
  if (!acct || (opts.forCheckout !== false && !acct.enabled)) fail(503, "paid_ticketing_not_configured", { checkoutEnabled: false, reason: "district_payment_provider_not_connected", processor });
  if (acct.mode === "live" && !liveAllowed()) fail(503, "live_payments_disabled", { reason: "Live payments are switched off on this server (COMMERCE_LIVE_PAYMENTS_ENABLED)." });
  let secrets;
  try { secrets = openSecrets(config.commerceSecretsKey, districtId, processor, acct.secrets_enc); }
  catch (e) { fail(503, e.code === "commerce_secrets_key_missing" ? "commerce_secrets_key_missing" : "provider_credentials_unreadable"); }
  const missing = REQUIRED(processor).filter(k => !(acct.config?.[k] || secrets[k]));
  if (missing.length) fail(503, "provider_credentials_missing", { processor, missing });
  try {
    const { base, allowedHosts } = endpoint(processor, acct.mode, acct.config);
    const adapter = ADAPTERS[processor]({ mode: acct.mode, ...acct.config, ...secrets, fee: { bps: acct.fee_bps, fixedCents: acct.fee_fixed_cents },
      transport: opts.transport || transportOverride || defaultTransport, base, allowedHosts });
    return { adapter, mode: acct.mode };
  } catch (e) {
    if (e instanceof ProviderError) fail(503, e.code, { processor });
    throw e;
  }
}

export async function loadSetup(c, districtId) {
  return (await one(c, "SELECT * FROM commerce_payment_setup WHERE district_id=$1", [districtId])) || { enabled_methods: [], default_method: null, card_processor: null, updated_at: null };
}

/** The checkout methods families can use right now (for the status screen). */
export async function checkoutMethods(c, districtId) {
  const setup = await loadSetup(c, districtId);
  const out = [];
  for (const m of setup.enabled_methods) {
    const processor = processorFor(m, setup);
    let ready = Boolean(processor) && adapterState(m, processor) === "ready", mode = "test", reason = null;
    if (!processor) reason = "card_processor_not_chosen";
    else if (!ready) reason = "payment_adapter_not_available";
    else if (processor !== "sandbox") {
      const a = await one(c, "SELECT enabled, mode, secrets_enc IS NOT NULL AS sealed FROM eduos_commerce_checkout_account($1)", [processor]);
      mode = a?.mode || "test";
      if (!a || !a.enabled || !a.sealed) { ready = false; reason = "district_payment_provider_not_connected"; }
      else if (a.mode === "live" && !liveAllowed()) { ready = false; reason = "live_payments_disabled"; }
    }
    out.push({ method: m, label: METHODS[m].label, processor, ready, mode, reason, default: setup.default_method === m });
  }
  return { methods: out, defaultMethod: setup.default_method, setup };
}

/** Resolve a family's (or superintendent's) choice to a working adapter. */
export async function resolveCheckout(c, districtId, requested) {
  const setup = await loadSetup(c, districtId);
  const enabled = setup.enabled_methods || [];
  const method = requested ?? setup.default_method ?? (enabled.length === 1 ? enabled[0] : null);
  if (!method || !enabled.includes(method)) fail(409, "payment_method_not_available", { available: enabled });
  const processor = processorFor(method, setup);
  if (!processor) fail(503, "card_processor_not_chosen", { reason: "The district hasn't chosen which processor takes cards." });
  if (adapterState(method, processor) !== "ready") fail(503, "payment_adapter_not_available", { method, processor, reason: METHODS[method].comingReason || "Not available yet." });
  const { adapter, mode } = await adapterFor(c, districtId, processor, { forCheckout: true });
  return { adapter, method, processor, mode };
}

// ---------------- district administration ----------------

export async function providersOverview(c, districtId) {
  const accounts = new Map((await c.query("SELECT * FROM commerce_provider_accounts WHERE district_id=$1", [districtId])).rows.map(r => [r.processor, r]));
  const setup = await loadSetup(c, districtId);
  return {
    liveSwitch: liveAllowed(), secretsKeyConfigured: Boolean(config.commerceSecretsKey), btcpayAllowedHosts: config.commerceAllowedHosts,
    setup: { enabledMethods: setup.enabled_methods, defaultMethod: setup.default_method, cardProcessor: setup.card_processor, updatedAt: setup.updated_at },
    processors: Object.fromEntries(Object.keys(PROCESSORS).filter(isProcessor).map(p => [p, { ...accountOut(p, accounts.get(p)),
      fields: PROCESSORS[p].fields, description: PROCESSORS[p].description }])),
    methods: Object.values(METHODS).map(m => ({ id: m.id, label: m.label, description: m.description, processors: m.processors, setupProcessor: m.setupProcessor,
      checkout: !m.methodless, signup: m.signup || null, developer: m.developer || null, docs: m.docs || [], notes: m.notes || [], otherLinks: m.otherLinks || [],
      adapter: m.adapter, comingReason: m.comingReason || null }))
  };
}

const str = (v, max) => typeof v === "string" && v.trim() && v.length <= max && !/[\u0000-\u001f]/.test(v);
export async function saveAccount(c, req, processor, b = {}) {
  if (!isProcessor(processor)) fail(404, "unknown_processor");
  const d = req.actor.districtId, spec = PROCESSORS[processor];
  const cur = await one(c, "SELECT * FROM commerce_provider_accounts WHERE district_id=$1 AND processor=$2 FOR UPDATE", [d, processor]);
  const cfg = { ...(cur?.config || {}) }, changed = [], secretChanges = [];
  for (const [k, v] of Object.entries(b.config || {})) {
    const fdef = spec.fields.find(x => x.key === k && !x.secret);
    if (!fdef) fail(400, "unknown_field", { field: k });
    if (v === null || v === "") { delete cfg[k]; changed.push(k); continue; }
    if (!str(v, fdef.max) || (fdef.pattern && !new RegExp(fdef.pattern).test(v))) fail(400, "invalid_field", { field: k });
    cfg[k] = v.trim(); changed.push(k);
  }
  if (processor === "btcpay" && cfg.serverUrl) {
    const v = validateWebhookUrl(cfg.serverUrl, { allowedHosts: config.commerceAllowedHosts });
    if (!v.ok || v.url.protocol !== "https:") fail(400, "invalid_field", { field: "serverUrl", reason: v.reason || "https_required" });
    if (!config.commerceAllowedHosts.length) fail(400, "btcpay_host_not_allowed", { reason: "Ask district IT to add this server's host to COMMERCE_ALLOWED_HOSTS." });
  }
  const newSecrets = {}, clear = b.clearSecrets === true ? SECRET_KEYS(processor) : Array.isArray(b.clearSecrets) ? b.clearSecrets : [];
  for (const [k, v] of Object.entries(b.secrets || {})) {
    const fdef = spec.fields.find(x => x.key === k && x.secret);
    if (!fdef) fail(400, "unknown_field", { field: k });
    if (v === "" || v === null || v === undefined) continue; // blank = keep what's saved
    if (!str(v, fdef.max)) fail(400, "invalid_field", { field: k });
    newSecrets[k] = v.trim(); secretChanges.push(k);
  }
  for (const k of clear) if (!SECRET_KEYS(processor).includes(k)) fail(400, "unknown_field", { field: k });
  let secretsEnc = cur?.secrets_enc || null, secretFields = cur?.secret_fields || [];
  if (secretChanges.length || clear.length) {
    if (!config.commerceSecretsKey) fail(503, "commerce_secrets_key_missing", { reason: "District IT must set COMMERCE_SECRETS_KEY on the server before credentials can be saved." });
    let merged = {};
    try { merged = openSecrets(config.commerceSecretsKey, d, processor, secretsEnc); } catch { merged = {}; }
    for (const k of clear) delete merged[k];
    Object.assign(merged, newSecrets);
    secretsEnc = sealSecrets(config.commerceSecretsKey, d, processor, merged);
    secretFields = Object.keys(merged).filter(k => merged[k]).sort();
    for (const k of clear) if (!secretChanges.includes(k)) secretChanges.push(`${k}(cleared)`);
  }
  const mode = b.mode ?? cur?.mode ?? "test", enabled = b.enabled ?? cur?.enabled ?? false;
  if (!MODES.includes(mode) || typeof enabled !== "boolean") fail(400, "invalid_value");
  const feeBps = b.feeBps ?? cur?.fee_bps ?? spec.defaultFee.bps, feeFixed = b.feeFixedCents ?? cur?.fee_fixed_cents ?? spec.defaultFee.fixedCents;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1500 || !Number.isInteger(feeFixed) || feeFixed < 0 || feeFixed > 1000) fail(400, "invalid_rate");
  const missing = missingFields(processor, { config: cfg, secret_fields: secretFields });
  if (enabled && missing.length) fail(409, "provider_incomplete", { missing });
  if (mode === "live" && missing.length) fail(409, "live_requires_credentials", { missing });
  const r = await one(c, `INSERT INTO commerce_provider_accounts(district_id,processor,enabled,mode,config,secrets_enc,secret_fields,fee_bps,fee_fixed_cents,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,now())
    ON CONFLICT(district_id,processor) DO UPDATE SET enabled=EXCLUDED.enabled, mode=EXCLUDED.mode, config=EXCLUDED.config, secrets_enc=EXCLUDED.secrets_enc,
      secret_fields=EXCLUDED.secret_fields, fee_bps=EXCLUDED.fee_bps, fee_fixed_cents=EXCLUDED.fee_fixed_cents, updated_by=EXCLUDED.updated_by, updated_at=now(),
      last_test_at=CASE WHEN commerce_provider_accounts.mode<>EXCLUDED.mode OR $11 THEN NULL ELSE commerce_provider_accounts.last_test_at END,
      last_test_ok=CASE WHEN commerce_provider_accounts.mode<>EXCLUDED.mode OR $11 THEN NULL ELSE commerce_provider_accounts.last_test_ok END,
      last_test_detail=CASE WHEN commerce_provider_accounts.mode<>EXCLUDED.mode OR $11 THEN NULL ELSE commerce_provider_accounts.last_test_detail END
    RETURNING *`, [d, processor, enabled, mode, JSON.stringify(cfg), secretsEnc, secretFields, feeBps, feeFixed, req.actor.userId, Boolean(secretChanges.length || changed.length)]);
  // Field names only: never a value, secret or not.
  await audit(c, req, "provider_saved", "commerce_provider", null,
    `processor=${processor};enabled=${r.enabled};mode=${r.mode};fields=${changed.join(",") || "-"};secrets=${secretChanges.join(",") || "-"};fee=${r.fee_bps}+${r.fee_fixed_cents}`);
  return accountOut(processor, r);
}

export async function testAccount(c, req, processor, opts = {}) {
  if (!isProcessor(processor)) fail(404, "unknown_processor");
  const { adapter, mode } = await adapterFor(c, req.actor.districtId, processor, { forCheckout: false, transport: opts.transport });
  let ok = false, detail;
  try { const r = await adapter.testConnection(); ok = r.ok === true; detail = r.detail; }
  catch (e) { detail = e instanceof ProviderError ? e.code : "provider_error"; }
  detail = String(detail || "unknown").toLowerCase().replace(/[^a-z_]/g, "_").slice(0, 60);
  await c.query("UPDATE commerce_provider_accounts SET last_test_at=now(), last_test_ok=$3, last_test_detail=$4, updated_by=$5 WHERE district_id=$1 AND processor=$2",
    [req.actor.districtId, processor, ok, detail, req.actor.userId]);
  await audit(c, req, "provider_tested", "commerce_provider", null, `processor=${processor};mode=${mode};ok=${ok};detail=${detail}`, ok ? "success" : "failure");
  return { processor, mode, ok, detail };
}

export async function saveSetup(c, req, b = {}) {
  const d = req.actor.districtId, cur = await loadSetup(c, d);
  const methods = b.enabledMethods ?? cur.enabled_methods, def = b.defaultMethod === undefined ? cur.default_method : b.defaultMethod,
    card = b.cardProcessor === undefined ? cur.card_processor : b.cardProcessor;
  if (!Array.isArray(methods) || methods.some(m => !CHECKOUT_METHODS.includes(m)) || new Set(methods).size !== methods.length) fail(400, "invalid_payment_methods", { allowed: CHECKOUT_METHODS });
  if (card !== null && !METHODS.card.processors.includes(card)) fail(400, "invalid_card_processor", { allowed: METHODS.card.processors });
  if (methods.includes("card") && !card) fail(409, "card_processor_not_chosen");
  if (def !== null && !methods.includes(def)) fail(409, "default_method_not_enabled");
  const r = await one(c, `INSERT INTO commerce_payment_setup(district_id,enabled_methods,default_method,card_processor,updated_by,updated_at) VALUES($1,$2,$3,$4,$5,now())
    ON CONFLICT(district_id) DO UPDATE SET enabled_methods=EXCLUDED.enabled_methods, default_method=EXCLUDED.default_method, card_processor=EXCLUDED.card_processor,
      updated_by=EXCLUDED.updated_by, updated_at=now() RETURNING *`, [d, methods, def, card, req.actor.userId]);
  await audit(c, req, "payment_methods", "commerce", null, `methods=${r.enabled_methods.join(",") || "-"};default=${r.default_method || "-"};cards=${r.card_processor || "-"}`);
  return { enabledMethods: r.enabled_methods, defaultMethod: r.default_method, cardProcessor: r.card_processor, updatedAt: r.updated_at };
}

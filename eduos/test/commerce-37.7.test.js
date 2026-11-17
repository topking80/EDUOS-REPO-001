// 37.7.0 commerce (sandbox): fee engine, split, provider, and static guards.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pctOf, allocate, ticketSettlement, marketplaceSettlement, summarize, formatCents, DEFAULT_RATES, SPLIT_ORDER } from "../src/commerce/split.js";
import { sandboxProvider, createPaymentProvider, SANDBOX_OUTCOMES, PROVIDERS } from "../src/commerce/payments.js";
import { ROLE_PERMISSIONS } from "../src/policy.js";

const root = new URL("../", import.meta.url);
const read = p => readFile(new URL(p, root), "utf8");
const line = (lines, name) => lines.find(l => l.line === name)?.amount ?? 0;

test("the deck's worked example (p40) splits to the cent: $7,233.50 / $851.00 / $425.50", () => {
  // Gross $10,000, processing $290, sales tax 9%, network fee 3% -> net $8,510.
  const lines = ticketSettlement({ grossCents: 1_000_000, processingFeeCents: 29_000, salesTaxBps: 900 });
  assert.equal(line(lines, "gross"), 1_000_000);
  assert.equal(line(lines, "sales_tax"), 90_000);
  assert.equal(line(lines, "network_fee"), 30_000);
  assert.equal(line(lines, "school_share"), 723_350);
  assert.equal(line(lines, "district_share"), 85_100);
  assert.equal(line(lines, "state_share"), 42_550);
  assert.equal(lines.filter(l => l.line !== "gross").reduce((n, l) => n + l.amount, 0), 1_000_000);
});

test("defaults are the deck's rates: 3% network, 5% marketplace, 85/10/5 split, no sales tax unless set", () => {
  assert.equal(DEFAULT_RATES.networkFeeBps, 300);
  assert.equal(DEFAULT_RATES.marketplaceFeeBps, 500);
  assert.deepEqual({ ...DEFAULT_RATES.split }, { school: 8500, district: 1000, state: 500 });
  assert.equal(DEFAULT_RATES.salesTaxBps, 0);
  assert.deepEqual([...SPLIT_ORDER], ["school", "district", "state"]);
});

test("percentages round half up in integers", () => {
  assert.equal(pctOf(1, 5000), 1);      // 0.5 -> 1
  assert.equal(pctOf(1, 4999), 0);
  assert.equal(pctOf(150, 300), 5);     // 4.5 -> 5
  assert.equal(pctOf(149, 300), 4);     // 4.47 -> 4
  assert.equal(pctOf(0, 300), 0);
  assert.throws(() => pctOf(1.5, 300), RangeError);
  assert.throws(() => pctOf(100, -1), RangeError);
  assert.throws(() => pctOf(100, 10001), RangeError);
});

test("allocation always adds up exactly, and leftover cents go by largest remainder then fixed order", () => {
  const s = { school: 8500, district: 1000, state: 500 };
  for (let total = 0; total <= 25_000; total++) {
    const a = allocate(total, s, SPLIT_ORDER);
    assert.equal(a.school + a.district + a.state, total, `total ${total}`);
    for (const k of SPLIT_ORDER) {
      const exact = total * s[k] / 10000;
      assert.ok(a[k] >= Math.floor(exact) && a[k] <= Math.ceil(exact), `${k} for ${total}`);
    }
  }
  assert.deepEqual(allocate(1, s, SPLIT_ORDER), { school: 1, district: 0, state: 0 });
  assert.deepEqual(allocate(19, s, SPLIT_ORDER), { school: 16, district: 2, state: 1 });
  // Equal remainders: the fixed order decides (deterministic, no randomness).
  assert.deepEqual(allocate(1, { a: 5000, b: 5000 }, ["a", "b"]), { a: 1, b: 0 });
  assert.deepEqual(allocate(1, { a: 5000, b: 5000 }, ["b", "a"]), { b: 1, a: 0 });
  assert.deepEqual(allocate(10, { x: 3333, y: 3333, z: 3334 }, ["x", "y", "z"]), { x: 3, y: 3, z: 4 });
  assert.throws(() => allocate(100, { a: 9000, b: 900 }), /10000/);
  assert.throws(() => allocate(-1, s), RangeError);
});

test("ticket settlements balance for every small price and refuse fees above the price", () => {
  const fee = sandboxProvider();
  for (let gross = 50; gross <= 20_000; gross += 7) {
    const lines = ticketSettlement({ grossCents: gross, processingFeeCents: fee.feeFor(gross), salesTaxBps: 725 });
    assert.equal(lines.filter(l => l.line !== "gross").reduce((n, l) => n + l.amount, 0), gross);
    assert.ok(lines.every(l => Number.isInteger(l.amount) && l.amount >= 0));
  }
  assert.throws(() => ticketSettlement({ grossCents: 25, processingFeeCents: fee.feeFor(25) }), e => e.code === "fees_exceed_price");
  // Zero-amount lines are left out; gross always stays.
  const free = ticketSettlement({ grossCents: 100, processingFeeCents: 0, networkFeeBps: 0 });
  assert.deepEqual(free.map(l => l.line), ["gross", "school_share", "district_share", "state_share"]);
  const custom = ticketSettlement({ grossCents: 10_000, processingFeeCents: 0, networkFeeBps: 0, split: { school: 10000, district: 0, state: 0 } });
  assert.equal(line(custom, "school_share"), 10_000);
});

test("marketplace: 5% to the platform, processor fee, the vendor gets the rest", () => {
  const lines = marketplaceSettlement({ grossCents: 250_000, processingFeeCents: 7_280, vendorId: "v1" });
  assert.equal(line(lines, "marketplace_fee"), 12_500);
  assert.equal(line(lines, "vendor_payable"), 230_220);
  assert.equal(lines.find(l => l.line === "vendor_payable").recipientId, "v1");
  assert.throws(() => marketplaceSettlement({ grossCents: 10, processingFeeCents: 31 }), e => e.code === "fees_exceed_price");
});

test("report totals sum signed lines; money formats from cents", () => {
  const t = summarize([{ line: "school_share", amount: 500 }, { line: "school_share", amount_cents: "-500" }, { line: "gross", amount: 7 }]);
  assert.deepEqual(t, { school_share: 0, gross: 7 });
  assert.equal(formatCents(723_350), "$7,233.50");
  assert.equal(formatCents(-5), "-$0.05");
  assert.throws(() => formatCents(1.5), RangeError);
});

test("sandbox provider: fee 2.9% + 30c, test outcomes only, never live", async () => {
  const p = sandboxProvider();
  assert.equal(p.name, "sandbox");
  assert.equal(p.live, false);
  assert.equal(p.feeFor(1000), 59);         // 29 + 30
  assert.equal(p.feeFor(1_000_000), 29_030);
  const c = await p.createPayment({ amountCents: 1500, currency: "USD" });
  assert.equal(c.status, "requires_confirmation");
  assert.match(c.providerRef, /^pay_sandbox_[0-9a-f]{24}$/);
  assert.equal((await p.confirmPayment(c.providerRef, { testOutcome: "sandbox_success" })).status, "succeeded");
  const d = await p.confirmPayment(c.providerRef, { testOutcome: "sandbox_decline" });
  assert.equal(d.status, "declined");
  assert.equal(d.declineCode, "sandbox_card_declined");
  await assert.rejects(p.confirmPayment(c.providerRef, { testOutcome: "4242424242424242" }), RangeError);
  await assert.rejects(p.confirmPayment("pi_live_123", {}), /not a sandbox payment/);
  const r = await p.refundPayment(c.providerRef, 1500);
  assert.match(r.refundRef, /^re_sandbox_[0-9a-f]{24}$/);
  await assert.rejects(p.createPayment({ amountCents: 0 }), RangeError);
  assert.deepEqual([...SANDBOX_OUTCOMES], ["sandbox_success", "sandbox_decline"]);
});

test("built-in providers are 'none' and 'sandbox'; real processors are per district (37.7.1)", () => {
  assert.deepEqual([...PROVIDERS], ["none", "sandbox"]);
  assert.equal(createPaymentProvider("none"), null);
  assert.equal(createPaymentProvider(undefined), null);
  assert.equal(createPaymentProvider("sandbox").name, "sandbox");
  for (const name of ["stripe", "square", "paypal", "braintree", "live"]) assert.throws(() => createPaymentProvider(name), /set up per district/);
});

test("commerce code holds no keys; only the adapters' injected transport reaches a network", async () => {
  for (const f of ["src/commerce/payments.js", "src/commerce/split.js", "src/commerce/service.js", "src/commerce-routes.js", "src/commerce/adapters.js", "src/commerce/catalog.js"]) {
    const src = await read(f);
    assert.doesNotMatch(src, /from\s+["'](node:)?(https?|net|tls|dgram|http2)["']/, `${f} imports a network module`);
    assert.doesNotMatch(src, /\bfetch\s*\(|undici|axios|XMLHttpRequest/, `${f} calls the network`);
    assert.doesNotMatch(src, /sk_(live|test)_|EAAA[A-Za-z0-9]{10}|access_token=\w|client_secret=\w/i, `${f} holds a key`);
  }
  const env = await read(".env.example");
  assert.match(env, /^COMMERCE_LIVE_PAYMENTS_ENABLED=false$/m);
  assert.doesNotMatch(env, /^COMMERCE_PAYMENT_PROVIDER=/m);
});

test("roles: guardians pay, pupils never; leaders report and refund; settings are the superintendent's", () => {
  assert.deepEqual(ROLE_PERMISSIONS.parent.commerce, ["pay"]);
  assert.equal(ROLE_PERMISSIONS.pupil.commerce, undefined);
  assert.deepEqual(ROLE_PERMISSIONS.principal.commerce, ["report", "refund"]);
  assert.deepEqual(ROLE_PERMISSIONS.superintendent.commerce, ["settings", "report", "refund", "purchase", "providers"]);
  assert.deepEqual(ROLE_PERMISSIONS.it_admin.commerce, ["providers"], "37.7.1: district IT connects processors, nothing else");
  for (const r of ["teacher", "driver", "sro"]) assert.equal(ROLE_PERMISSIONS[r]?.commerce, undefined, r);
});

test("migration 065: append-only ledger, EDAL kinds, guarded transitions, RLS, no student data", async () => {
  const sql = await read("db/065_commerce_sandbox.sql");
  for (const t of ["commerce_settings", "commerce_payments", "commerce_ledger_entries", "commerce_receipts", "marketplace_purchases"]) {
    assert.match(sql, new RegExp(`CREATE TABLE ${t}`));
  }
  assert.match(sql, /commerce_ledger_append_only BEFORE UPDATE OR DELETE ON commerce_ledger_entries/);
  assert.match(sql, /commerce_receipts_append_only BEFORE UPDATE OR DELETE ON commerce_receipts/);
  assert.match(sql, /'commerce_settlement','commerce_refund'/);
  assert.match(sql, /CHECK\(school_share_bps \+ district_share_bps \+ state_share_bps = 10000\)/);
  assert.match(sql, /provider IN \('sandbox'\)/);
  assert.match(sql, /scope_insert ON commerce_ledger_entries AS RESTRICTIVE FOR INSERT WITH CHECK \(eduos_is_table_owner\(\)\)/);
  assert.match(sql, /purpose='event_tickets' AND eduos_ctx_role\(\)='parent'/);
  assert.match(sql, /eduos_retention_feature_commerce/);
  assert.doesNotMatch(sql, /student_id uuid/, "commerce tables must not store student ids");
  assert.doesNotMatch(sql, /latitude|longitude|geolocation|face|threat|risk_score|predict/i);
  const grants = await read("db/runtime_grants.template.sql");
  assert.match(grants, /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commerce_ledger_entries, commerce_receipts FROM eduos_app/);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION eduos_commerce_record\(uuid, text, uuid, jsonb, text\), eduos_commerce_expire_holds\(\) TO eduos_app/);
  // Column grants come after the clubs block's table-level REVOKE UPDATE (which would remove them).
  assert.ok(grants.indexOf("GRANT UPDATE (status, checked_in_at") > grants.indexOf("REVOKE UPDATE, DELETE, TRUNCATE ON event_ticket_orders, event_tickets"));
});

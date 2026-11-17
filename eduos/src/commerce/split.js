// EduOS 37.7.0 commerce (sandbox): the fee engine and the 85/10/5 revenue
// split, in integer cents only. Pure functions: no I/O, no floating point in
// any amount.
//
// The deck's model (p39, p40, p44):
//  - EdOS network fee: 3% of eligible commerce (event tickets).
//  - Marketplace vendor fee: 5% of apps & content sold through the marketplace.
//  - Net school commerce splits 85% school / 10% district / 5% state.
// Worked example (p40, Friday Night Football): gross $10,000.00, processing
// $290.00, sales tax 9% $900.00, network fee 3% $300.00, net $8,510.00 ->
// school $7,233.50, district $851.00, state $425.50.
//
// Rounding is deterministic: a percentage of an amount rounds half up to the
// cent; a split hands the leftover cents (at most one per recipient) to the
// recipients with the largest fractional remainders, ties broken by the fixed
// recipient order (school, district, state). The parts always add up exactly.

export const DEFAULT_RATES = Object.freeze({
  networkFeeBps: 300, salesTaxBps: 0, marketplaceFeeBps: 500,
  split: Object.freeze({ school: 8500, district: 1000, state: 500 })
});
export const SPLIT_ORDER = Object.freeze(["school", "district", "state"]);
export const MAX_CENTS = 100_000_000; // $1,000,000.00 per payment

const isCents = v => Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTS;
const isBps = (v, max = 10_000) => Number.isInteger(v) && v >= 0 && v <= max;
function assertCents(v, name) { if (!isCents(v)) throw new RangeError(`${name} must be whole cents from 0 to ${MAX_CENTS}`); }
function assertBps(v, name, max) { if (!isBps(v, max)) throw new RangeError(`${name} must be whole basis points from 0 to ${max ?? 10000}`); }

/** bps of an amount, rounded half up to the cent (exact in integers). */
export function pctOf(amountCents, bps) {
  assertCents(amountCents, "amount"); assertBps(bps, "rate");
  return Math.floor((amountCents * bps + 5000) / 10000);
}

/** Split an amount by basis points that sum to 10,000; parts sum exactly. */
export function allocate(totalCents, shares, order = Object.keys(shares)) {
  assertCents(totalCents, "total");
  const keys = order.filter(k => shares[k] !== undefined);
  let sum = 0;
  for (const k of keys) { assertBps(shares[k], `${k} share`); sum += shares[k]; }
  if (sum !== 10000 || keys.length !== Object.keys(shares).length) throw new RangeError("shares must add up to 10000 basis points");
  const parts = keys.map((k, i) => { const raw = totalCents * shares[k]; return { k, i, cents: Math.floor(raw / 10000), frac: raw % 10000 }; });
  let left = totalCents - parts.reduce((n, p) => n + p.cents, 0);
  for (const p of [...parts].sort((a, b) => b.frac - a.frac || a.i - b.i)) { if (left <= 0) break; if (p.frac > 0) { p.cents++; left--; } }
  if (left !== 0) throw new Error("allocation did not balance"); // unreachable: left < number of non-zero fractions
  return Object.fromEntries(parts.map(p => [p.k, p.cents]));
}

/** The lines every settlement carries: amounts out of `gross` that add up to it exactly. */
function finish(lines, gross) {
  const out = lines.filter(l => l.amount > 0 || l.line === "gross");
  const paid = out.filter(l => l.line !== "gross").reduce((n, l) => n + l.amount, 0);
  if (paid !== gross) throw new Error(`settlement does not balance: ${paid} != ${gross}`);
  return out;
}

/**
 * School commerce (event tickets): gross -> processor, sales tax, network fee,
 * then the net 85/10/5. Refuses a sale whose fees would exceed its price.
 */
export function ticketSettlement({ grossCents, processingFeeCents, salesTaxBps = DEFAULT_RATES.salesTaxBps,
  networkFeeBps = DEFAULT_RATES.networkFeeBps, split = DEFAULT_RATES.split, schoolId = null }) {
  assertCents(grossCents, "gross"); assertCents(processingFeeCents, "processing fee");
  assertBps(salesTaxBps, "sales tax", 3000); assertBps(networkFeeBps, "network fee", 1000);
  const tax = pctOf(grossCents, salesTaxBps), network = pctOf(grossCents, networkFeeBps);
  const net = grossCents - processingFeeCents - tax - network;
  if (net < 0) { const e = new RangeError("fees exceed the price"); e.code = "fees_exceed_price"; throw e; }
  const s = allocate(net, { school: split.school, district: split.district, state: split.state }, SPLIT_ORDER);
  return finish([
    { line: "gross", recipient: "payer", amount: grossCents },
    { line: "processing_fee", recipient: "processor", amount: processingFeeCents },
    { line: "sales_tax", recipient: "tax_authority", amount: tax },
    { line: "network_fee", recipient: "platform", amount: network },
    { line: "school_share", recipient: "school", recipientId: schoolId, amount: s.school },
    { line: "district_share", recipient: "district", amount: s.district },
    { line: "state_share", recipient: "state_fund", amount: s.state }
  ], grossCents);
}

/**
 * Marketplace (district buys an app/content license): the 5% vendor fee goes
 * to the platform, the processor keeps its fee, the vendor gets the rest.
 */
export function marketplaceSettlement({ grossCents, processingFeeCents, marketplaceFeeBps = DEFAULT_RATES.marketplaceFeeBps, vendorId = null }) {
  assertCents(grossCents, "gross"); assertCents(processingFeeCents, "processing fee"); assertBps(marketplaceFeeBps, "marketplace fee", 3000);
  const fee = pctOf(grossCents, marketplaceFeeBps), vendor = grossCents - processingFeeCents - fee;
  if (vendor < 0) { const e = new RangeError("fees exceed the price"); e.code = "fees_exceed_price"; throw e; }
  return finish([
    { line: "gross", recipient: "payer", amount: grossCents },
    { line: "processing_fee", recipient: "processor", amount: processingFeeCents },
    { line: "marketplace_fee", recipient: "platform", amount: fee },
    { line: "vendor_payable", recipient: "vendor", recipientId: vendorId, amount: vendor }
  ], grossCents);
}

/** Totals by line for a report: sums signed amounts (refunds are negative). */
export function summarize(entries) {
  const t = {};
  for (const e of entries) { const k = e.line; t[k] = (t[k] || 0) + Number(e.amount_cents ?? e.amount); }
  return t;
}
export const formatCents = (c, currency = "USD") => {
  if (!Number.isSafeInteger(c)) throw new RangeError("cents must be an integer");
  const sign = c < 0 ? "-" : "", a = Math.abs(c);
  return `${sign}${currency === "USD" ? "$" : currency + " "}${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
};

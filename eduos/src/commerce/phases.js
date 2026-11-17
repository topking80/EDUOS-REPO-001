// 37.7.1 two-phase processor calls. A route's transaction returns
// afterCommit(fn) when the rest of the work must call a payment processor:
// the transaction commits first (releasing its row locks and its pooled
// connection), then fn runs, and fn opens its own short transaction to
// record what the processor answered. No processor call ever runs while a
// database transaction is open.
const AFTER = Symbol.for("eduos.commerce.afterCommit");
export const afterCommit = fn => ({ [AFTER]: fn });
export const isAfterCommit = v => Boolean(v && typeof v === "object" && typeof v[AFTER] === "function");
/** Run a deferred continuation (repeatedly, if it defers again); plain values pass through. */
export async function runAfterCommit(v) {
  while (isAfterCommit(v)) v = await v[AFTER]();
  return v;
}

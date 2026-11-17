// EduOS 37.7.0 commerce: the built-in "sandbox" adapter. No processor, no
// keys, no network calls. 37.7.1: the choice of processor is per district
// (src/commerce/catalog.js, db/066); the real processors' adapters are in
// adapters.js and share this interface (see the header there). The old
// global COMMERCE_PAYMENT_PROVIDER switch is gone.
//
// The sandbox confirms instantly with a chosen test outcome:
//   confirmPayment(providerRef, {testOutcome}) -> { status: "succeeded" | "declined", declineCode? }
import { randomBytes } from "node:crypto";
import { pctOf, MAX_CENTS } from "./split.js";

export const PROVIDERS = Object.freeze(["none", "sandbox"]);
// Sandbox test outcomes (like a processor's test cards). Nothing is charged.
export const SANDBOX_OUTCOMES = Object.freeze(["sandbox_success", "sandbox_decline"]);

export function sandboxProvider({ feeBps = 290, feeFixedCents = 30 } = {}) {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new RangeError("sandbox fee bps out of range");
  if (!Number.isInteger(feeFixedCents) || feeFixedCents < 0 || feeFixedCents > 500) throw new RangeError("sandbox fixed fee out of range");
  const ref = p => `${p}_sandbox_${randomBytes(12).toString("hex")}`;
  const amountOk = a => Number.isSafeInteger(a) && a > 0 && a <= MAX_CENTS;
  return Object.freeze({
    name: "sandbox", live: false, checkout: true,
    async testConnection() { return { ok: true, detail: "sandbox" }; },
    feeFor(amountCents) { if (!amountOk(amountCents)) throw new RangeError("amount out of range"); return pctOf(amountCents, feeBps) + feeFixedCents; },
    async createPayment({ amountCents, currency = "USD" }) {
      if (!amountOk(amountCents) || !/^[A-Z]{3}$/.test(currency)) throw new RangeError("invalid payment");
      return { providerRef: ref("pay"), status: "requires_confirmation" };
    },
    async confirmPayment(providerRef, { testOutcome = "sandbox_success" } = {}) {
      if (typeof providerRef !== "string" || !providerRef.startsWith("pay_sandbox_")) throw new Error("not a sandbox payment");
      if (!SANDBOX_OUTCOMES.includes(testOutcome)) throw new RangeError("unknown sandbox outcome");
      return testOutcome === "sandbox_success" ? { status: "succeeded", captureRef: null } : { status: "declined", declineCode: "sandbox_card_declined" };
    },
    async refundPayment(providerRef, amountCents) {
      if (typeof providerRef !== "string" || !providerRef.startsWith("pay_sandbox_") || !amountOk(amountCents)) throw new Error("invalid sandbox refund");
      return { status: "refunded", refundRef: ref("re") };
    }
  });
}

/** "none" -> null, "sandbox" -> the sandbox adapter. Real processors are built per district by the service. */
export function createPaymentProvider(name = "none", opts = {}) {
  if (name === "none" || name === "" || name == null) return null;
  if (name === "sandbox") return sandboxProvider(opts);
  throw new Error(`"${name}" is not a built-in provider: real processors are set up per district (Ticketing & revenue > Payment providers).`);
}

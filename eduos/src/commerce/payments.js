// EduOS 37.7.0 commerce: the PaymentProvider interface and its only adapter,
// "sandbox". No real processor, no keys, no network calls. Real payments stay
// disabled until the district picks a processor and a new adapter is reviewed.
//
// COMMERCE_PAYMENT_PROVIDER = "none" (default: paid checkout off) | "sandbox".
// Any other value stops the server at startup.
//
// Interface (every adapter):
//   name                          "sandbox"
//   live                          false (true only for a real processor)
//   feeFor(amountCents)           -> processing fee in cents (integer)
//   createPayment({amountCents, currency, reference})
//                                 -> { providerRef, status: "requires_confirmation" }
//   confirmPayment(providerRef, {testOutcome})
//                                 -> { status: "succeeded" | "declined", declineCode? }
//   refundPayment(providerRef, amountCents)
//                                 -> { status: "refunded", refundRef }
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
    name: "sandbox", live: false,
    feeFor(amountCents) { if (!amountOk(amountCents)) throw new RangeError("amount out of range"); return pctOf(amountCents, feeBps) + feeFixedCents; },
    async createPayment({ amountCents, currency = "USD" }) {
      if (!amountOk(amountCents) || !/^[A-Z]{3}$/.test(currency)) throw new RangeError("invalid payment");
      return { providerRef: ref("pay"), status: "requires_confirmation" };
    },
    async confirmPayment(providerRef, { testOutcome = "sandbox_success" } = {}) {
      if (typeof providerRef !== "string" || !providerRef.startsWith("pay_sandbox_")) throw new Error("not a sandbox payment");
      if (!SANDBOX_OUTCOMES.includes(testOutcome)) throw new RangeError("unknown sandbox outcome");
      return testOutcome === "sandbox_success" ? { status: "succeeded" } : { status: "declined", declineCode: "sandbox_card_declined" };
    },
    async refundPayment(providerRef, amountCents) {
      if (typeof providerRef !== "string" || !providerRef.startsWith("pay_sandbox_") || !amountOk(amountCents)) throw new Error("invalid sandbox refund");
      return { status: "refunded", refundRef: ref("re") };
    }
  });
}

/** The configured provider, or null when paid checkout is off. */
export function createPaymentProvider(name = "none", opts = {}) {
  if (name === "none" || name === "" || name == null) return null;
  if (name === "sandbox") return sandboxProvider(opts);
  throw new Error(`COMMERCE_PAYMENT_PROVIDER=${name} is not available: only "sandbox" exists. Real payment processors are disabled until one is chosen and reviewed.`);
}

const envProvider = (process.env.COMMERCE_PAYMENT_PROVIDER || "none").trim();
if (!PROVIDERS.includes(envProvider)) createPaymentProvider(envProvider); // throws at startup with the reason
export const paymentProvider = createPaymentProvider(envProvider);

// TC-13: the recurring-gift job (db/139). SANDBOX ONLY.
//
//   npm run donations:charge                (cron, e.g. daily; runs as the runtime role)
//   DONATION_SCHEDULE_INTERVAL_SECONDS      (or let the API run it on a timer; 0 = off)
//
// For each active monthly or yearly gift that is due it makes the charge
// through the built-in sandbox processor (nothing moves) and records it: a
// successful charge becomes its own gift with its own acknowledgement and
// ledger lines; a declined one is kept as a declined gift, and three declines
// in a row stop the schedule. While a district has donations, recurring gifts
// or fund collection off, its charges wait and nobody is charged.
//
// Every schedule's provider is the sandbox (db/139 allows nothing else), so
// the job never uses a real processor, whatever the live switch says.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, assertSafeRuntimeRole, assertSchemaReady } from "./db.js";
import { config } from "./config.js";
import { sandboxProvider } from "./commerce/payments.js";

const today = () => new Date().toISOString().slice(0, 10);

export async function runDonationSchedules({ db = pool, asOf = today(), limit = 200, outcomeFor = () => "sandbox_success" } = {}) {
  const out = { due: 0, succeeded: 0, declined: 0, stopped: 0, held: 0, skipped: 0, errors: 0 };
  const due = (await db.query("SELECT * FROM eduos_history_donation_schedules_due($1::date,$2)", [asOf, limit])).rows;
  out.due = due.length;
  const sandbox = sandboxProvider();
  for (const d of due) {
    try {
      const p = await sandbox.createPayment({ amountCents: d.amount_cents, currency: "USD" });
      const r = await sandbox.confirmPayment(p.providerRef, { testOutcome: outcomeFor(d) });
      const ok = r.status === "succeeded";
      const res = (await db.query("SELECT eduos_history_donation_schedule_charge($1,$2,$3,$4::date,$5,$6,$7,$8) AS r",
        [d.district_id, d.schedule_id, d.installment, asOf, p.providerRef, sandbox.feeFor(d.amount_cents), ok ? "succeeded" : "declined", ok ? null : (r.declineCode || "declined")])).rows[0].r;
      out[res] = (out[res] || 0) + 1;
    } catch (e) {
      out.errors++;
      console.error("donation schedules: charge failed", { schedule: d.schedule_id, message: e.message });
    }
  }
  return out;
}

let running = false;
export function startDonationScheduleSweep() {
  if (!config.donationScheduleIntervalSeconds) return null;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runDonationSchedules().catch(e => console.error("donation schedule sweep failed", { message: e.message })).finally(() => { running = false; });
  }, config.donationScheduleIntervalSeconds * 1000);
  timer.unref?.();
  return timer;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  (async () => {
    await assertSafeRuntimeRole();
    await assertSchemaReady();
    const asOf = process.env.DONATION_SCHEDULE_AS_OF || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error("DONATION_SCHEDULE_AS_OF must be YYYY-MM-DD");
    const outcome = process.env.DONATION_SCHEDULE_TEST_OUTCOME || "sandbox_success";
    const result = await runDonationSchedules({ asOf, limit: Number(process.env.DONATION_SCHEDULE_LIMIT || 500), outcomeFor: () => outcome });
    console.log(JSON.stringify(result));
  })().catch(error => { console.error(`Donation schedules failed: ${error.message}`); process.exitCode = 1; })
    .finally(() => pool.end());
}

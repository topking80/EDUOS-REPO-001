// TC-12: open the district preservation fund for tests that take gifts.
// Collection stays closed until the fund is enabled and its legal, finance and
// governance approvals are documented (db/137).
import assert from "node:assert/strict";

export const FUND_SETTINGS = { enabled: true, governanceText: "The district finance committee reviews every request.",
  allocationRules: "Unrestricted gifts pay district-wide costs; school gifts pay that school's share.", refundPolicy: "Ask the district office within 30 days for a full refund." };

export async function openFund(supt, extra = {}) {
  const r = await supt("PUT", "/api/preservation-fund/settings", { ...FUND_SETTINGS, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const kind of ["legal", "finance", "governance"]) {
    const g = await supt("POST", "/api/preservation-fund/governance", { kind, reference: `Board minutes item ${kind}`, approvedOn: "2026-11-01" });
    assert.equal(g.status, 200, JSON.stringify(g.body));
  }
}

// EduOS 37.6.0 marketplace vendor fee hook: PLACEHOLDER. It only records THAT
// a billable event happened (no amounts, no payment processing, nothing sent
// anywhere). Fee accounting is a later release; replace this module then.
export const FEES_STATUS = "deferred";
export async function recordVendorFee(client, { districtId, listingId, licenseId = null, userId, event = "license_approved" }) {
  await client.query(`INSERT INTO marketplace_fee_events(district_id,listing_id,license_id,event,created_by) VALUES($1,$2,$3,$4,$5)`,
    [districtId, listingId, licenseId, event, userId]);
  return { status: FEES_STATUS, event };
}

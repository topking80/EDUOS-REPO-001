# District marketplace (37.6.0 candidate)

The 32.2 app catalog grows vendor listings with a district privacy review.
Schools ask for a reviewed app, and the district approves it through the
**existing** licensing: `apps` → `app_licenses` (a district-purchased license,
`purchased_by_school_id` NULL) → `app_assignments`, recorded in the existing
`app_requests` queue.

## Flow

1. **Vendor and listing.** The district office (superintendent or IT admin,
   `apps:manage`) adds a vendor and a listing. A listing records the launch URL
   (https only), integration type, the data it shares, and a pricing note.
2. **Privacy review.** Every checklist item must be ticked to approve:
   - DPA (or SDPC) signed;
   - COPPA;
   - FERPA school official;
   - data minimized;
   - no ads or profiling;
   - no location tracking, facial recognition or biometrics;
   - deletion on request;
   - security review.

   "Changes requested" and "rejected" need a note. Every decision is kept in
   `marketplace_privacy_reviews` (append-only). The DPA expiry date is recorded.
3. **Request.** Principals and teachers (`apps:request`) see only listed,
   privacy-approved listings (RLS) and ask for one with a reason and optional
   seats. A principal can ask for the whole district. The request lands in
   `app_requests` with `listing_id`, and district deciders are notified.
4. **Approve.** `POST /api/marketplace/requests/:id/approve` (`apps:decide`)
   does four things:
   - creates the catalog app from the listing once (DPA signed, COPPA and
     FERPA true, the same data scope);
   - adds a district license (seats, end date);
   - assigns the app to the school (or the district);
   - marks the request approved, records a fee event and notifies the
     requester.

   Deny through the existing `PATCH /api/app-requests/:id`. Approving a
   marketplace request through that generic route returns
   `409 use_marketplace_approval`.
5. **Guards.** A trigger on `app_requests` refuses to approve a marketplace
   request whose listing is not privacy-approved, or whose DPA has expired,
   whichever route tries.

## Fee hook (placeholder)

`src/marketplace/fees.js` `recordVendorFee()` writes a `marketplace_fee_events`
row (`license_approved`, status `deferred`). It records no amounts, does no
payment processing and sends nothing anywhere. Replace the module when fee
accounting is designed.

## Screens

The mobile web app (`/app/`) has a **Marketplace** card on the principal and
superintendent overview and on the teacher Classes tab. The screen shows
listings, requests, approve and deny, and, for the district, vendor and
listing forms and the privacy review.

**Not included:**
- a Marketplace tab on the full site (`public/eduos-mesh.js`), where IT admins
  work today;
- Flutter screens.

Both are follow-ups.

# EduOS 35.8.0 — Library Assistant & District Resource Network

## Capability
The Library Assistant introduces a district-scoped catalogue intake and inventory service. It accepts normalized records from CSV/JSON exports and common catalogue sources (including MARC-derived exports and Destiny, Follett, and Alexandria exports after field mapping). This is an import pipeline, not a live vendor API connector: each source export must be supplied by an authorized school user.

### Inventory and intake
- Import up to 5,000 catalogue records per batch.
- Map title, author/creator, ISBN, publisher, year, subject, call number, barcode, copy count, and available count.
- Barcode records are upserted within the same district and school to avoid duplicate copy records on repeat imports.
- Records without a barcode are appended and should be deduplicated/reconciled before repeated import.
- Search inventory and summarize titles, copies, availability, out-of-stock titles, and school totals.

### Connected district resource management
- Create transfer requests between district schools.
- Create purchase, repair, withdrawal, and review requests.
- Track requests through open, approved, in-transit, completed, declined, or cancelled.
- District superintendent and IT roles can view cross-school inventory and requests; principals are school-scoped; teachers can read inventory and submit requests.
- All operations are district-scoped, audited, and protected by PostgreSQL RLS.

## API
- `GET /api/library/inventory?q=...`
- `GET /api/library/summary`
- `POST /api/library/catalogues/import` — `{sourceName, sourceType, schoolId?, records:[...]}`
- `GET /api/library/requests`
- `POST /api/library/requests` — `{requestType,title,quantity?,schoolId?,fromSchoolId?,toSchoolId?,itemId?,note?}`
- `POST /api/library/requests/:id/status` — `{status}`

`sourceType`: `csv`, `json`, `marc`, `destiny`, `follett`, `alexandria`, `other`.

## Important boundaries
- No circulation/check-out/check-in, fines, patron histories, student reading profiles, or vendor credentials are created by this release.
- This version does not claim direct API connectivity to commercial catalogue platforms. Export/import mapping is required.
- Purchase requests are workflow records, not purchase orders or financial commitments.
- Barcode-less imports are append-only and may create duplicates across repeated loads.

## Deployment
Apply migration `022_library_services.sql` using `npm run db:migrate`, then deploy the application. Verify the runtime database role has the required table grants through the standard runtime-grants generation process.

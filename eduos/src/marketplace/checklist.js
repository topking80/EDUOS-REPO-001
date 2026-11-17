// EduOS 37.6.0 marketplace privacy checklist (pure; no I/O). Every item must
// be true before a listing can be privacy-approved.
export const CHECKLIST = Object.freeze([
  ["dpa_signed", "Data privacy agreement signed (or SDPC)"],
  ["coppa", "COPPA: no data from under-13s without school consent"],
  ["ferpa_school_official", "Vendor acts as a FERPA school official"],
  ["data_minimized", "Only the data the tool needs (scope matches)"],
  ["no_ads_or_profiling", "No ads, selling, or profiling of students"],
  ["no_tracking_or_biometrics", "No location tracking, facial recognition or biometric data"],
  ["deletion_on_request", "Deletes data on request and at contract end"],
  ["security_reviewed", "Security review done (SSO, encryption, breach notice)"]
]);

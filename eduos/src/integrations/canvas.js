// Canvas LMS API connector identity. OAuth authorization is implemented in
// canvas-oauth.js; roster/course sync is deliberately unavailable until the
// separately reviewed CANVAS-API-02 adapter exists.
import { IntegrationError } from "./http.js";

export async function fetchRoster() {
  throw new IntegrationError("canvas_sync_not_implemented", "Canvas course and enrollment sync is not enabled yet");
}

// Safe, human-readable classifications for server-recorded operational audit
// events. The classifier deliberately returns only fixed labels/categories;
// it never forwards audit detail, record IDs, names, or student information.
const CATALOG = Object.freeze({
  attendance_recorded: Object.freeze({ type: "attendance.recorded", label: "Attendance recorded", severity: "info" }),
  transportation_checkin: Object.freeze({ type: "transportation.rider_checkin", label: "Transportation check-in recorded", severity: "info" }),
  transportation_run_started: Object.freeze({ type: "transportation.run_started", label: "Transportation run started", severity: "info" }),
  transportation_run_completed: Object.freeze({ type: "transportation.run_completed", label: "Transportation run completed", severity: "success" }),
  dismissal_release: Object.freeze({ type: "dismissal.student_released", label: "Authorized student release recorded", severity: "info" }),
  dismissal_denied: Object.freeze({ type: "dismissal.release_denied", label: "Student release was denied", severity: "warning" }),
  dismissal_verification_failed: Object.freeze({ type: "dismissal.pass_verification_failed", label: "Pick-up pass verification failed", severity: "warning" }),
  agent_run: Object.freeze({ type: "ai.agent_run_recorded", label: "AI agent run recorded", severity: "info" }),
  pickup_authorization: Object.freeze({ type: "dismissal.authorization_updated", label: "Pick-up authorization updated", severity: "info" }),
  transport_configuration: Object.freeze({ type: "transportation.configuration_updated", label: "Transportation configuration updated", severity: "info" }),
  general: Object.freeze({ type: "operations.audit_event", label: "Operational record updated", severity: "info" })
});

export function classifyOperationalEvent({ action, resourceType, outcome } = {}) {
  const actionKey = typeof action === "string" ? action : "";
  const resourceKey = typeof resourceType === "string" ? resourceType : "";
  let key = "general";
  if (resourceKey === "attendance" && actionKey === "record") key = "attendance_recorded";
  else if (resourceKey === "transport_checkin" && actionKey === "checkin") key = "transportation_checkin";
  else if (resourceKey === "transport_run" && actionKey === "create") key = "transportation_run_started";
  else if (resourceKey === "transport_run" && actionKey === "complete") key = "transportation_run_completed";
  else if (resourceKey === "pickup_event" && actionKey === "release") key = "dismissal_release";
  else if (resourceKey === "pickup_tag" && actionKey === "deny") key = "dismissal_denied";
  else if (resourceKey === "pickup_tag" && actionKey === "verify" && outcome === "failure") key = "dismissal_verification_failed";
  else if (resourceKey === "agent_orchestration" && actionKey === "agent_orchestration") key = "agent_run";
  else if (resourceKey === "pickup_adult" && ["create", "approve", "reject", "revoke"].includes(actionKey)) key = "pickup_authorization";
  else if (["transport_route", "transport_rider_assignment"].includes(resourceKey) && ["create", "revoke"].includes(actionKey)) key = "transport_configuration";
  const item = CATALOG[key];
  // Failed outcomes are visibly distinguished even for otherwise generic events.
  return Object.freeze({ ...item, severity: outcome === "failure" && item.severity === "info" ? "warning" : item.severity });
}

export const OPERATIONAL_EVENT_CATALOG = CATALOG;

// 32.5.0 SafetyOS and car pick-up: pure rules shared by the API and tests.
import { createHash, randomInt } from "node:crypto";

export const INCIDENT_KINDS = ["lockdown", "shelter", "evacuate", "hold"];
export const ROLLCALL_STATUSES = ["present", "missing", "extra", "injured"];
export const LIVE = ["active", "reunification"];

export const KIND_LABEL = { lockdown: "Lockdown", shelter: "Shelter in place", evacuate: "Evacuate", hold: "Hold in rooms" };

// What each audience is told. Families get generic text only: no student,
// staff or room details, and never the reason for the incident.
const STAFF = {
  lockdown: "Lock doors, lights off, out of sight. Stay quiet. Do not open the door until the all-clear. Take roll call in the app.",
  shelter: "Move to your shelter area and follow the hazard plan. Take roll call in the app.",
  evacuate: "Leave the building by your route to the assembly point. Bring your class. Take roll call in the app.",
  hold: "Stay in your room and clear the halls. Class continues. Take roll call in the app."
};
const STUDENT = {
  lockdown: "Stay with your teacher. Be very quiet and stay out of sight. Wait for an adult to tell you it's safe.",
  shelter: "Go with your teacher to the safe area and listen for instructions.",
  evacuate: "Walk with your teacher to the meeting place outside. Stay with your class.",
  hold: "Stay in your classroom with your teacher. Keep learning while the halls are cleared."
};
const DRIVER = {
  lockdown: "Do not drive to or unload at the school. Hold at a safe place and follow dispatch.",
  shelter: "Keep riders on the bus and follow dispatch instructions.",
  evacuate: "Do not approach the building. Follow dispatch for where to stage.",
  hold: "Keep to your schedule unless dispatch tells you otherwise."
};
const FAMILY = {
  lockdown: "The school is in a lockdown. Please do not come to the school or call it; staff are following their plan. We will update you here.",
  shelter: "The school is sheltering in place. Students are with staff. Please do not come to the school. We will update you here.",
  evacuate: "The school has moved students out of the building. Students are with staff. Please wait for instructions here before coming.",
  hold: "The school is holding students in classrooms. Students are with staff. No action is needed."
};

export function audienceFor(role) {
  if (role === "parent") return "family";
  if (role === "pupil") return "student";
  if (role === "driver") return "driver";
  return "staff";
}

/** Text shown on the full-screen state for one role. */
export function incidentMessage(kind, status, audience, { reunificationPoint = null } = {}) {
  if (status === "reunification") {
    if (audience === "family") return `Reunification has started${reunificationPoint ? ` at ${reunificationPoint}` : ""}. Bring photo ID and your EduOS pick-up pass. Students are released only to approved adults.`;
    if (audience === "student") return "You're safe. Stay with your teacher. An adult will take you to your family.";
    if (audience === "driver") return "Reunification has started. Follow dispatch instructions.";
    return `Reunification has started${reunificationPoint ? ` at ${reunificationPoint}` : ""}. Release students only through pick-up verification.`;
  }
  const table = { staff: STAFF, student: STUDENT, driver: DRIVER, family: FAMILY }[audience] || STAFF;
  return table[kind] || "";
}

export function familyTitle(kind, isDrill, schoolName, status = "active", hazard = null) {
  const drill = isDrill ? " (drill)" : "";
  if (status === "reunification") return `${schoolName}: reunification has started${drill}`;
  if (status === "closed") return `${schoolName}: all clear${drill}`;
  return `${schoolName}: ${alertTitle(kind, hazard, "family")} in effect${drill}`;
}

/** Two-step confirm: the second request must repeat the kind and drill flag. */
export function confirmMatches(incident, body) {
  return Boolean(body && body.kind === incident.kind && body.isDrill === incident.is_drill && (body.hazard ?? null) === (incident.hazard ?? null));
}

/** Roll-call totals across the latest entry per learner. */
export function accountability(enrolled, latest) {
  const by = new Map(latest.map(e => [e.student_id, e.status]));
  const out = { enrolled, present: 0, missing: 0, extra: 0, injured: 0, accounted: 0 };
  for (const status of by.values()) { out[status]++; if (status !== "missing") out.accounted++; }
  out.unaccounted = Math.max(0, enrolled - by.size);  // nobody has reported on them yet
  return out;
}

// ---- pick-up passes ----
// Crockford base32 without I, L, O, U: 10 characters = 50 bits.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function newPassCode() {
  let c = "";
  for (let i = 0; i < 10; i++) c += ALPHABET[randomInt(ALPHABET.length)];
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}
/** Normalise what staff type or a scanner sends: case, spaces, dashes, O/I/L lookalikes. */
export function normalizePassCode(input) {
  if (typeof input !== "string") return null;
  const c = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{10}$/.test(c) ? c : null;
}
export const hashPassCode = normalized => createHash("sha256").update(`eduos-pickup:${normalized}`).digest("hex");

/** Can this adult take this learner right now? Pure decision over the lookup row. */
export function releaseDecision(row, { incidentStatus = null } = {}) {
  if (!row) return { ok: false, reason: "unknown_pass" };
  if (row.tag_state !== "valid") return { ok: false, reason: `pass_${row.tag_state}` };
  if (row.adult_status !== "approved") return { ok: false, reason: "adult_not_approved" };
  if (row.do_not_release) return { ok: false, reason: "do_not_release", blocked: true };
  if (incidentStatus === "active") return { ok: false, reason: "safety_incident_live" };
  return { ok: true, custodyOrder: Boolean(row.custody_order) };
}

// ---- SAFE-02: what a classroom device shows during an alert ----
// Displays and kiosks: a lockdown turns the screen dark and silent (a lit
// screen through a door window gives the room away); any other alert shows a
// full-screen notice with the student instructions, muted. Student devices:
// a lockdown is a quiet, dim notice; otherwise the same notice. Nothing here
// locks a student device or opens anything on it.
export function deviceSafetyView(s) {
  if (!s) return null;
  const quiet = s.deviceKind === "student_device";
  if (!s.incident) return s.allClearAt ? { mode: "all_clear", title: "All clear", message: "Normal school operations resume.", volume: null, at: s.allClearAt } : { mode: "normal" };
  const i = s.incident, drill = i.isDrill ? " (drill)" : "";
  const title = i.status === "reunification" ? `Reunification${drill}` : `${alertTitle(i.kind, i.hazard, "student")}${drill}`;
  let message = (i.status !== "reunification" && hazardMessage(i.hazard, "student")) || incidentMessage(i.kind, i.status, "student", { reunificationPoint: i.reunificationPoint });
  if (i.status !== "reunification" && i.shelterArea) message += ` Shelter area: ${i.shelterArea}.`;
  if (i.kind === "lockdown" && i.status === "active")
    return quiet ? { mode: "quiet", title, message: "Silence this device and stay out of sight.", volume: 0, incidentId: i.id }
      : { mode: "dark", title, message: null, volume: 0, incidentId: i.id };
  return { mode: "alert", title, message, volume: 0, incidentId: i.id };
}

// ---- SAFE-03: severe weather and other hazards ----
// A shelter or hold can name its hazard. Staff, students and screens get the
// hazard's instructions; each room has a shelter area for it (db/123).
// Families are told the weather hazard (it's public); a hazardous-materials
// release stays generic.
export const HAZARDS = ["tornado", "severe_thunderstorm", "lightning", "hurricane", "flood", "winter_storm", "extreme_heat", "earthquake", "hazmat"];
export const HAZARD_LABEL = { tornado: "Tornado warning", severe_thunderstorm: "Severe thunderstorm", lightning: "Lightning", hurricane: "Hurricane",
  flood: "Flooding", winter_storm: "Winter storm", extreme_heat: "Extreme heat", earthquake: "Earthquake", hazmat: "Hazardous materials" };
/** The alert each hazard usually calls for (the person starting it can choose). */
export const HAZARD_KIND = { tornado: "shelter", severe_thunderstorm: "shelter", lightning: "hold", hurricane: "shelter", flood: "shelter",
  winter_storm: "hold", extreme_heat: "hold", earthquake: "shelter", hazmat: "shelter" };
const HAZARD_STAFF = {
  tornado: "Take everyone to your room's tornado shelter area: an interior hallway or room on the lowest floor, away from windows, doors and large open rooms. Crouch low and cover heads. Take roll call there.",
  severe_thunderstorm: "Bring everyone indoors and away from windows. Suspend outdoor activities. Take roll call.",
  lightning: "Everyone indoors now: end recess, practices and outdoor classes. Wait 30 minutes after the last thunder before anyone goes back out.",
  hurricane: "Move everyone to your shelter area, away from windows. Follow the district's hurricane plan. Take roll call.",
  flood: "Move everyone to your shelter area on a higher floor. Keep away from flooded areas and doors. Take roll call.",
  winter_storm: "Keep everyone indoors. Buses and dismissal follow the district's plan; wait for instructions here.",
  extreme_heat: "Keep everyone indoors in cooled rooms; no outdoor activity. Make water available.",
  earthquake: "Drop, cover and hold on until the shaking stops. Then wait for instructions here; evacuate only if told to.",
  hazmat: "Close windows and doors and turn off fans; the office shuts down ventilation. Stay inside. Take roll call."
};
const HAZARD_STUDENT = {
  tornado: "Go with your teacher to the shelter area. Crouch low and cover your head.",
  severe_thunderstorm: "Stay inside with your teacher, away from windows.",
  lightning: "Stay inside. Outdoor activities are stopped for now.",
  hurricane: "Go with your teacher to the shelter area, away from windows.",
  flood: "Go with your teacher to the shelter area.",
  winter_storm: "Stay inside with your teacher and wait for instructions.",
  extreme_heat: "Stay inside where it's cool, and drink water.",
  earthquake: "Drop, cover and hold on. Stay with your teacher.",
  hazmat: "Stay inside with your teacher. Keep doors and windows closed."
};
const WEATHER = new Set(["tornado", "severe_thunderstorm", "lightning", "hurricane", "flood", "winter_storm", "extreme_heat", "earthquake"]);
/** Hazard instructions for an audience, or null (no hazard, or none for families). */
export function hazardMessage(hazard, audience) {
  if (!hazard || !HAZARDS.includes(hazard)) return null;
  if (audience === "student") return HAZARD_STUDENT[hazard];
  if (audience === "family") return WEATHER.has(hazard) ? `The school is sheltering for ${HAZARD_LABEL[hazard].toLowerCase()}. Students are with staff in safe areas. Please don't come to the school until it's safe; we'll update you here.` : null;
  if (audience === "driver") return WEATHER.has(hazard) ? `${HAZARD_LABEL[hazard]}: follow dispatch; don't unload at the school until it's safe.` : null;
  return HAZARD_STAFF[hazard];
}
/** The heading for an alert with its hazard, e.g. "Shelter in place: Tornado warning". Families never see a non-weather hazard. */
export function alertTitle(kind, hazard, audience = "staff") {
  const base = KIND_LABEL[kind];
  if (!hazard || (audience === "family" && !WEATHER.has(hazard))) return base;
  return `${base}: ${HAZARD_LABEL[hazard]}`;
}

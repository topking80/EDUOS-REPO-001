// Cross-profile flow events.
//
// A flow event is a small, allow-listed notification that something done in
// one role's workspace is relevant to other roles (for example a teacher
// enrolling a pupil is relevant to the principal, the superintendent and the
// family). Events never carry free text or personal names: only an event type,
// opaque record references and bounded counters. That keeps the event store
// and any outbound webhook payload free of student-identifying content.

export const FLOW_ROLES = Object.freeze(["superintendent", "it_admin", "principal", "teacher", "parent", "pupil", "driver", "sro", "librarian"]);
const DISTRICT = Object.freeze(["superintendent", "it_admin"]);
const STAFF = Object.freeze(["superintendent", "principal", "teacher"]);

// emitters: roles allowed to raise the event.
// audience: roles whose workspaces should surface it.
// client:   true when the browser may report it (demo staffing actions);
//           false when only the server may raise it from an authoritative write.
export const FLOW_EVENT_TYPES = Object.freeze({
  "teacher.hired": Object.freeze({ emitters: ["principal"], audience: ["superintendent", "teacher"], client: true }),
  "teacher.removed": Object.freeze({ emitters: ["principal"], audience: ["superintendent"], client: true }),
  "section.created": Object.freeze({ emitters: ["principal"], audience: ["superintendent", "teacher"], client: true }),
  "pupil.enrolled": Object.freeze({ emitters: ["teacher"], audience: ["principal", "superintendent", "parent", "pupil"], client: true }),
  "pupil.unenrolled": Object.freeze({ emitters: ["teacher"], audience: ["principal", "superintendent"], client: true }),
  "section.full": Object.freeze({ emitters: ["teacher"], audience: ["principal", "superintendent"], client: true }),
  "assignment.created": Object.freeze({ emitters: STAFF, audience: ["pupil", "parent", "principal"], client: false }),
  "attendance.recorded": Object.freeze({ emitters: STAFF, audience: ["parent", "principal"], client: false }),
  // 32.2.0 district resource mesh (refs.resource is the app id; no names).
  "app.registered": Object.freeze({ emitters: [...DISTRICT, "principal"], audience: ["superintendent", "it_admin", "principal"], client: false }),
  "app.licensed": Object.freeze({ emitters: [...DISTRICT, "principal"], audience: ["superintendent", "it_admin", "principal"], client: false }),
  "app.assigned": Object.freeze({ emitters: [...DISTRICT, "principal"], audience: ["superintendent", "it_admin", "principal", "teacher", "parent", "pupil"], client: false }),
  "app.unassigned": Object.freeze({ emitters: [...DISTRICT, "principal"], audience: ["superintendent", "it_admin", "principal", "teacher"], client: false }),
  "app.retired": Object.freeze({ emitters: [...DISTRICT, "principal"], audience: ["superintendent", "it_admin", "principal", "teacher"], client: false }),
  "app.requested": Object.freeze({ emitters: ["principal", "teacher"], audience: ["superintendent", "it_admin"], client: false }),
  "app.request.decided": Object.freeze({ emitters: DISTRICT, audience: ["principal", "it_admin"], client: false }),
  // 32.3.0: a school (or the district default) published new branding (refs.resource = profile id).
  "branding.published": Object.freeze({ emitters: [...DISTRICT, "principal"], audience: ["superintendent", "it_admin", "principal", "teacher", "parent", "pupil"], client: false }),
  "webhook.test": Object.freeze({ emitters: DISTRICT, audience: ["superintendent", "it_admin"], client: false })
});

const CLIENT_REF_KEYS = Object.freeze(["section", "teacher", "school"]);
const COUNT_KEYS = Object.freeze(["enrolled", "capacity", "teachers"]);
const CLIENT_REF = /^[A-Z]{3}-[A-Z0-9-]{3,24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Counters describe sizes (enrolled, capacity); 32.2.0 raised the bound from
// 100,000 so very large districts are not rejected. It only rejects nonsense.
const MAX_COUNT = 1_000_000_000;

const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function isFlowEventType(type) {
  return typeof type === "string" && Object.hasOwn(FLOW_EVENT_TYPES, type);
}

/**
 * Validate a browser-reported flow event. Returns a frozen event or null.
 * Anything outside the allow-list (unknown keys, free text, wrong role,
 * out-of-range counters) is rejected rather than cleaned.
 */
export function normalizeFlowEvent(input, actorRole) {
  if (!plainObject(input)) return null;
  if (Object.keys(input).some(key => !["type", "refs", "counts"].includes(key))) return null;
  if (!isFlowEventType(input.type)) return null;
  const def = FLOW_EVENT_TYPES[input.type];
  if (!def.client || !def.emitters.includes(actorRole)) return null;

  const refsIn = input.refs === undefined ? {} : input.refs;
  const countsIn = input.counts === undefined ? {} : input.counts;
  if (!plainObject(refsIn) || !plainObject(countsIn)) return null;

  const refs = {};
  for (const [key, value] of Object.entries(refsIn)) {
    if (!CLIENT_REF_KEYS.includes(key) || typeof value !== "string" || !CLIENT_REF.test(value)) return null;
    refs[key] = value;
  }
  const counts = {};
  for (const [key, value] of Object.entries(countsIn)) {
    if (!COUNT_KEYS.includes(key) || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) return null;
    counts[key] = value;
  }
  if (counts.enrolled !== undefined && counts.capacity !== undefined && counts.enrolled > counts.capacity) return null;

  return Object.freeze({
    type: input.type, audience: [...def.audience], source: "client-reported",
    refs: Object.freeze(refs), counts: Object.freeze(counts)
  });
}

/** Build an event raised by the server after an authoritative write. */
export function serverFlowEvent(type, actorRole, resourceId) {
  if (!isFlowEventType(type)) return null;
  const def = FLOW_EVENT_TYPES[type];
  if (def.client || !def.emitters.includes(actorRole)) return null;
  if (resourceId !== undefined && (typeof resourceId !== "string" || !UUID.test(resourceId))) return null;
  return Object.freeze({
    type, audience: [...def.audience], source: "server",
    refs: Object.freeze(resourceId ? { resource: resourceId } : {}), counts: Object.freeze({})
  });
}

/** The exact JSON body sent to webhook receivers. No names, no user ids. */
export function webhookPayload(event) {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    source: event.source,
    actorRole: event.actorRole,
    audience: [...event.audience],
    districtId: event.districtId,
    refs: { ...event.refs },
    counts: { ...event.counts }
  };
}

// Shared, side-effect-free policy for the authoritative morning arrival lifecycle.
// Database tenant/school predicates remain mandatory; these checks are not a substitute for RLS.
export function arrivalInitiationDenial({ role, method, routeRunId }) {
  if (!['bus', 'car_rider', 'walk_in'].includes(method)) return 'invalid_arrival_method';
  if (method === 'bus' && role !== 'driver') return 'assigned_driver_required';
  if (method !== 'bus' && role !== 'principal') return 'principal_required';
  if (method === 'bus' && !routeRunId) return 'transport_run_required';
  if (method !== 'bus' && routeRunId) return 'unexpected_transport_run';
  return null;
}

export function arrivalReceiptDenial({ role, actorUserId, initiatorUserId, actorSchoolId, handoffSchoolId, status, assignedTeacherUserId, isRostered }) {
  if (!['principal', 'teacher'].includes(role)) return 'school_staff_only';
  if (actorSchoolId !== handoffSchoolId) return 'school_scope_denied';
  if (actorUserId === initiatorUserId) return 'independent_receipt_required';
  if (role === 'teacher' && assignedTeacherUserId !== actorUserId && !isRostered) return 'student_not_on_roster';
  if (status === 'received') return null; // idempotent confirmation
  if (status !== 'pending') return 'handoff_not_pending';
  return null;
}

// First attendance is recorded by the staff member who physically received the
// student. A principal at the same school may record it for someone else only
// as an explicit override with a reason (overrideReason, 3-300 characters),
// which the route records in the append-only handoff log and the audit log.
export const OVERRIDE_REASON_MIN = 3, OVERRIDE_REASON_MAX = 300;
export function firstAttendanceDenial({ role, actorUserId, actorSchoolId, handoffSchoolId, status, assignedTeacherUserId, isRostered, receivedByUserId, overrideReason = null }) {
  if (!['teacher', 'principal'].includes(role)) return 'school_staff_only';
  if (actorSchoolId !== handoffSchoolId) return 'school_scope_denied';
  if (status !== 'received') return 'attendance_requires_received_handoff';
  if (role === 'teacher' && assignedTeacherUserId !== actorUserId && !isRostered) return 'student_not_on_roster';
  if (actorUserId === receivedByUserId) return null;
  if (role === 'teacher') return 'receiving_staff_required';
  const reason = typeof overrideReason === 'string' ? overrideReason.trim() : '';
  if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) return 'override_reason_required';
  return null;
}

/** True when this first-attendance request is a principal override (actor isn't the receiver). */
export const isFirstAttendanceOverride = ({ actorUserId, receivedByUserId }) => actorUserId !== receivedByUserId;

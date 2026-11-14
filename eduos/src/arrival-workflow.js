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

export function firstAttendanceDenial({ role, actorUserId, actorSchoolId, handoffSchoolId, status, assignedTeacherUserId, isRostered }) {
  if (!['teacher', 'principal'].includes(role)) return 'school_staff_only';
  if (actorSchoolId !== handoffSchoolId) return 'school_scope_denied';
  if (status !== 'received') return 'attendance_requires_received_handoff';
  if (role === 'teacher' && assignedTeacherUserId !== actorUserId && !isRostered) return 'student_not_on_roster';
  return null;
}

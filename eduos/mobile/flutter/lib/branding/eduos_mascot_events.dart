/// Privacy-safe semantic outcomes that may drive mascot feedback.
/// Emit only after the host app has received a successful, authorized result;
/// never put student identifiers, names, notes, or API payloads in this stream.
enum EduOsMascotSignal {
  welcomeUser,
  attendanceRecorded,
  riderArrivalConfirmed,
  staffHandoffConfirmed,
  taskCompleted,
  safetyAttentionRequired,
  workflowNeedsHelp,
}

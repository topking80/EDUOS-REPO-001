import 'dart:async';

import 'eduos_mascot_events.dart';

/// Allowlisted server-confirmed outcomes. Do not add arbitrary endpoint strings
/// or response payloads here; this is intentionally a tiny privacy boundary.
enum EduOsConfirmedOperation {
  attendanceRecorded,
  riderArrivalConfirmed,
  staffHandoffConfirmed,
  taskCompleted,
  safetyAttentionRequired,
  workflowNeedsHelp,
  welcomeUser,
}

/// Converts a completed API operation into a mascot-only semantic signal.
/// The caller must invoke this only after validating the authenticated API
/// response and its business-level success condition (HTTP 2xx alone is not
/// sufficient for APIs that return partial or rejected outcomes).
class EduOsMascotEventGateway {
  EduOsMascotEventGateway() : _controller = StreamController<EduOsMascotSignal>.broadcast();

  final StreamController<EduOsMascotSignal> _controller;
  bool _closed = false;

  Stream<EduOsMascotSignal> get signals => _controller.stream;

  bool publishConfirmed({
    required EduOsConfirmedOperation operation,
    required int statusCode,
    required bool serverConfirmed,
  }) {
    if (_closed || !serverConfirmed || statusCode < 200 || statusCode >= 300) {
      return false;
    }
    final signal = switch (operation) {
      EduOsConfirmedOperation.attendanceRecorded => EduOsMascotSignal.attendanceRecorded,
      EduOsConfirmedOperation.riderArrivalConfirmed => EduOsMascotSignal.riderArrivalConfirmed,
      EduOsConfirmedOperation.staffHandoffConfirmed => EduOsMascotSignal.staffHandoffConfirmed,
      EduOsConfirmedOperation.taskCompleted => EduOsMascotSignal.taskCompleted,
      EduOsConfirmedOperation.safetyAttentionRequired => EduOsMascotSignal.safetyAttentionRequired,
      EduOsConfirmedOperation.workflowNeedsHelp => EduOsMascotSignal.workflowNeedsHelp,
      EduOsConfirmedOperation.welcomeUser => EduOsMascotSignal.welcomeUser,
    };
    _controller.add(signal);
    return true;
  }

  Future<void> dispose() async {
    if (_closed) return;
    _closed = true;
    await _controller.close();
  }
}

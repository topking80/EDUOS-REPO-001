import 'package:flutter_test/flutter_test.dart';
import 'package:eduos_mobile_branding/branding/eduos_mascot_event_gateway.dart';
import 'package:eduos_mobile_branding/branding/eduos_mascot_events.dart';

void main() {
  group('EduOsMascotEventGateway', () {
    late EduOsMascotEventGateway gateway;
    setUp(() => gateway = EduOsMascotEventGateway());
    tearDown(() => gateway.dispose());

    test('publishes only a server-confirmed successful operation', () async {
      final received = expectLater(
        gateway.signals,
        emits(EduOsMascotSignal.staffHandoffConfirmed),
      );
      expect(gateway.publishConfirmed(
        operation: EduOsConfirmedOperation.staffHandoffConfirmed,
        statusCode: 200,
        serverConfirmed: true,
      ), isTrue);
      await received;
    });

    test('rejects non-2xx responses', () {
      expect(gateway.publishConfirmed(
        operation: EduOsConfirmedOperation.attendanceRecorded,
        statusCode: 409,
        serverConfirmed: true,
      ), isFalse);
    });

    test('rejects business-level unconfirmed responses even when HTTP succeeds', () {
      expect(gateway.publishConfirmed(
        operation: EduOsConfirmedOperation.riderArrivalConfirmed,
        statusCode: 200,
        serverConfirmed: false,
      ), isFalse);
    });

    test('does not publish after disposal', () async {
      await gateway.dispose();
      expect(gateway.publishConfirmed(
        operation: EduOsConfirmedOperation.taskCompleted,
        statusCode: 204,
        serverConfirmed: true,
      ), isFalse);
    });
  });
}

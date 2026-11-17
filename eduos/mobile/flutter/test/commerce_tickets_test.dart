// 37.7.0 commerce (sandbox): the native tickets screen. Guardians pay with
// the sandbox adapter and get their codes once; learners can't pay.
import 'dart:convert';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/app/app_scope.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:eduos_mobile_branding/ui/screens/tickets_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'operations_screens_test.dart' show FakeServer, Handler, server;

final future = DateTime.now().add(const Duration(days: 2)).toIso8601String();
Map<String, Handler> routes({required bool enabled, required bool canPay}) => {
      'GET /api/commerce/status': (_) => {'data': {'provider': 'sandbox', 'enabled': enabled, 'live': false, 'canPay': canPay}},
      'GET /api/commerce/shop': (_) => {'data': {'events': [
        {'id': 'e1', 'title': 'Friday Night Football', 'startsAt': future, 'venue': 'Main field', 'school': 'Maple High', 'ticketTypes': [
          {'id': 'adult', 'name': 'Adult', 'priceCents': 1000, 'currency': 'USD', 'available': 3},
          {'id': 'student', 'name': 'Student', 'priceCents': 0, 'currency': 'USD', 'available': 50},
        ]},
      ]}},
      'GET /api/my/tickets': (_) => {'data': []},
      'GET /api/commerce/my': (_) => {'data': {'payments': []}},
    };

Future<FakeServer> pumpTickets(WidgetTester tester, String role, Map<String, Handler> extra, {required bool enabled}) async {
  tester.view.physicalSize = const Size(800, 2000);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final fake = FakeServer({...routes(enabled: enabled, canPay: role == 'parent'), ...extra}, role: role);
  final kv = MemoryKeyValueStore();
  final sessions = SessionStore(kv);
  await sessions.saveServer(server);
  await sessions.save(Session(serverUrl: server, token: 'tok', csrfToken: 'csrf', expiresAt: DateTime.now().add(const Duration(hours: 8))));
  final app = AppController(store: kv, httpClientFactory: fake.client, safetyPollInterval: null);
  addTearDown(app.dispose);
  await app.start();
  await tester.pumpWidget(AppScope(controller: app, child: const MaterialApp(home: TicketsScreen())));
  await tester.pumpAndSettle();
  return fake;
}

void main() {
  testWidgets('a guardian buys a paid ticket in the sandbox and sees the code once', (tester) async {
    final fake = await pumpTickets(tester, 'parent', {
      'POST /api/events/e1/tickets': (_) => {'data': {'order': {'id': 'o1', 'status': 'payment_pending'}, 'tickets': [], 'replayed': false,
        'payment': {'id': 'p1', 'status': 'requires_confirmation', 'amountCents': 1000, 'currency': 'USD', 'holdExpiresAt': future}}},
      'POST /api/commerce/payments/p1/confirm': (_) => {'data': {'status': 'succeeded', 'receipt': {'id': 'r1', 'number': 'R-20261117-ABCDEF0123'},
        'tickets': [{'id': 't1', 'code': 'CODE-ONE-abcdefghijklmnopqrstuvwxyz', 'qr': ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']}]}},
    }, enabled: true);
    expect(find.text('Sandbox payments: no real money moves and no card is charged.'), findsOneWidget);
    expect(find.text('Adult · \$10.00'), findsOneWidget);
    expect(find.text('Student · Free'), findsOneWidget);
    await tester.tap(find.text('Buy'));
    await tester.pumpAndSettle();
    final order = jsonDecode(fake.sent('POST', '/api/events/e1/tickets').single.body) as Map<String, Object?>;
    expect(order['ticketTypeId'], 'adult');
    expect(order['quantity'], 1);
    expect((order['idempotencyKey'] as String).length, 32);
    expect(find.text('Pay \$10.00'), findsOneWidget);
    await tester.tap(find.text('Pay (sandbox)'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/commerce/payments/p1/confirm').single.body), {'testOutcome': 'sandbox_success'});
    expect(find.text('Your tickets'), findsOneWidget);
    expect(find.text('CODE-ONE-abcdefghijklmnopqrstuvwxyz'), findsOneWidget);
  });

  testWidgets('a decline releases the seats and charges nothing', (tester) async {
    final fake = await pumpTickets(tester, 'parent', {
      'POST /api/events/e1/tickets': (_) => {'data': {'order': {'id': 'o1'}, 'tickets': [], 'payment': {'id': 'p1', 'amountCents': 1000, 'currency': 'USD'}}},
      'POST /api/commerce/payments/p1/confirm': (_) => {'data': {'status': 'declined', 'declineCode': 'sandbox_card_declined'}},
    }, enabled: true);
    await tester.tap(find.text('Buy'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Simulate a decline'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/commerce/payments/p1/confirm').single.body), {'testOutcome': 'sandbox_decline'});
    expect(find.textContaining('Nothing was charged'), findsOneWidget);
  });

  testWidgets('learners never see a Buy button; free tickets still work', (tester) async {
    final fake = await pumpTickets(tester, 'pupil', {
      'POST /api/events/e1/tickets': (_) => {'data': {'order': {'id': 'o2', 'status': 'complimentary'}, 'tickets': [{'id': 't2', 'code': 'FREE-CODE-abcdefghijklmnopqrstuv'}]}},
    }, enabled: true);
    expect(find.text('Ask a parent or guardian to buy this.'), findsOneWidget);
    expect(find.text('Buy'), findsNothing);
    expect(fake.sent('GET', '/api/commerce/my'), isEmpty, reason: 'learners have no payments');
    await tester.tap(find.text('Get'));
    await tester.pumpAndSettle();
    expect(find.text('FREE-CODE-abcdefghijklmnopqrstuv'), findsOneWidget);
  });

  testWidgets('when commerce is off, paid tickets say so and nothing can be bought', (tester) async {
    await pumpTickets(tester, 'parent', {}, enabled: false);
    expect(find.text('Paid tickets are off. No payment is collected here.'), findsOneWidget);
    expect(find.text('Paid tickets are off'), findsOneWidget);
    expect(find.text('Buy'), findsNothing);
  });
}

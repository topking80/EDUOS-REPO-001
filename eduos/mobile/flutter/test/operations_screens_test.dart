import 'dart:convert';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/app/role_tabs.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:eduos_mobile_branding/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final server = Uri.parse('https://eduos.example.test');
const incident = '99999999-0000-4000-8000-000000000001';
final now = DateTime.now().toIso8601String();
String today() => DateTime.now().toIso8601String().substring(0, 10);

typedef Handler = Object? Function(http.Request r);

class FakeServer {
  FakeServer(this.routes, {required this.role, this.incidents = const [], this.canLead = false});
  final Map<String, Handler> routes;
  final String role;
  final List<Map<String, Object?>> incidents;
  final bool canLead;
  final List<http.Request> requests = [];

  List<http.Request> sent(String method, String path) => requests.where((r) => r.method == method && r.url.path == path).toList();

  http.Client client() => MockClient((r) async {
        requests.add(r);
        final key = '${r.method} ${r.url.path}';
        final common = <String, Handler>{
          'GET /api/me': (_) => {'userId': 'u1', 'displayName': 'Staff Member', 'role': role, 'districtId': 'd1', 'schoolId': 's1'},
          'GET /api/branding/current': (_) => {'data': {'school': {'name': 'Maple Elementary'}, 'branding': {}}},
          'GET /api/safety/status': (_) => {'data': {'incidents': incidents, 'canInitiate': false, 'canLead': canLead}},
          'GET /api/notifications': (_) => {'data': {'unread': 0, 'items': []}},
          'GET /api/school-operations/command-center': (_) => {'data': {
            'summary': [{'domain': 'health_office', 'status': 'open', 'priority': 'urgent', 'count': 2, 'urgent': 2, 'overdue': 1},
                        {'domain': 'facilities', 'status': 'open', 'priority': 'normal', 'count': 3, 'urgent': 0, 'overdue': 0}],
            'work': [{'id': 'w9', 'domain': 'facilities', 'kind': 'repair', 'status': 'open', 'priority': 'high', 'summary': 'Gym door sticks', 'escalation_level': 1, 'created_at': now}]}},
          'GET /api/school-operations/health_office': (_) => {'data': [{'id': 'w1', 'domain': 'health_office', 'kind': 'supply', 'status': 'open', 'priority': 'urgent', 'summary': 'Restock first-aid kits', 'created_at': now}]},
        };
        final handler = routes[key] ?? common[key];
        final body = handler?.call(r);
        if (body == null) return http.Response('{"error":"not_found"}', 404);
        if (body is http.Response) return body;
        return http.Response(jsonEncode(body), r.method == 'POST' ? 201 : 200);
      });
}

Future<AppController> launch(WidgetTester tester, FakeServer fake) async {
  tester.view.physicalSize = const Size(800, 2600);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final kv = MemoryKeyValueStore();
  final sessions = SessionStore(kv);
  await sessions.saveServer(server);
  await sessions.save(Session(serverUrl: server, token: 'tok', csrfToken: 'csrf', expiresAt: DateTime.now().add(const Duration(hours: 8))));
  final app = AppController(store: kv, httpClientFactory: fake.client, safetyPollInterval: null);
  addTearDown(app.dispose);
  await app.start();
  await tester.pumpWidget(EduOsApp(controller: app));
  await tester.pumpAndSettle();
  return app;
}

Future<void> openTab(WidgetTester tester, String label) async {
  if (find.descendant(of: find.byType(NavigationBar), matching: find.text(label)).evaluate().isEmpty) {
    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
  }
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

void main() {
  test('every role tab is native now', () {
    final web = [for (final e in roleTabs.entries) for (final t in e.value) if (!t.native) '${e.key}/${t.id}'];
    expect(web, isEmpty);
  });

  testWidgets('nurse: health-office queue never sends free-text details; completes a task', (tester) async {
    final fake = FakeServer({
      'POST /api/school-operations/health_office': (_) => {'data': {'id': 'w2'}},
      'POST /api/school-operations/health_office/w1/status': (_) => {'data': {'ok': true}},
    }, role: 'nurse');
    await launch(tester, fake);
    expect(find.text('School Nurse Console'), findsOneWidget);
    expect(find.text('Restock first-aid kits'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Details (optional)'), findsNothing);
    expect(find.text('Escalate'), findsNothing, reason: 'only leaders escalate');
    await tester.enterText(find.widgetWithText(TextField, 'Summary'), 'Vision screening room setup');
    await tester.tap(find.text('Add work item'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/school-operations/health_office').single.body),
        {'kind': 'supply', 'priority': 'normal', 'summary': 'Vision screening room setup'});
    await tester.tap(find.text('Complete'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/school-operations/health_office/w1/status').single.body), {'status': 'completed'});
  });

  testWidgets('vice principal: operations across domains, escalate; attendance today', (tester) async {
    final fake = FakeServer({
      'POST /api/school-operations/facilities/w9/escalate': (_) => {'data': {'ok': true}},
      'POST /api/school-operations/meal_service': (_) => {'data': {'id': 'w3'}},
      'GET /api/attendance': (_) => {'data': [
        {'id': 'e1', 'event_date': today(), 'status': 'absent', 'display_name': 'Bob B'},
        {'id': 'e2', 'event_date': today(), 'status': 'present', 'display_name': 'Ana C'},
        {'id': 'e3', 'event_date': '2020-01-01', 'status': 'tardy', 'display_name': 'Old Mark'},
      ]},
    }, role: 'vice_principal');
    await launch(tester, fake);
    expect(find.text('Vice Principal Operations'), findsOneWidget);
    expect(find.textContaining('Facilities · repair · high · escalated ×1'), findsOneWidget);
    await tester.tap(find.text('Escalate'));
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/school-operations/facilities/w9/escalate'), hasLength(1));

    await tester.tap(find.text('Facilities').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Meal service').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'Summary'), 'Dish machine leaking');
    await tester.enterText(find.widgetWithText(TextField, 'Details (optional)'), 'Back left corner');
    await tester.tap(find.text('Add work item'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/school-operations/meal_service').single.body),
        {'kind': 'supply', 'priority': 'normal', 'summary': 'Dish machine leaking', 'details': 'Back left corner'});

    await openTab(tester, 'Attendance');
    expect(find.text('Bob B'), findsOneWidget);
    expect(find.text('Old Mark'), findsNothing, reason: 'only today\'s marks');
    expect(find.text('No tardies marked today.'), findsOneWidget);
  });

  testWidgets('librarian: scanner check-in returns the active loan; checkout looks up the borrower card', (tester) async {
    final fake = FakeServer({
      'GET /api/library/inventory': (_) => {'data': [
        {'id': 'i1', 'barcode': '3900001', 'title': 'Charlotte\'s Web'},
        {'id': 'i2', 'barcode': '3900002', 'title': 'Holes'},
      ]},
      'GET /api/library/loans': (_) => {'data': [{'id': 'l1', 'item_id': 'i1', 'title': 'Charlotte\'s Web', 'barcode': '3900001', 'due_at': now, 'returned_at': null, 'overdue': true}]},
      'GET /api/library/summary': (_) => {'data': {'totals': {'titles': 2, 'copies': 2, 'available': 1}}},
      'POST /api/library/loans/l1/return': (_) => {'data': {'ok': true}},
      'POST /api/library/borrower-cards/lookup': (_) => {'data': {'borrowerUserId': 'aaaaaaaa-0000-4000-8000-000000000001'}},
      'POST /api/library/loans/checkout': (_) => {'data': {'id': 'l2'}},
    }, role: 'librarian');
    await launch(tester, fake);
    expect(find.text('Overdue'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'Book barcode for check-in'), '0000000');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text('No matching book barcode in this school\'s inventory.'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'Book barcode for check-in'), '3900001');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/library/loans/l1/return').single.body), {'disposition': 'returned'});
    expect(find.text('Returned: Charlotte\'s Web'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'Book barcode for checkout'), '3900002');
    await tester.enterText(find.widgetWithText(TextField, 'Borrower card or account ID'), 'CARD-7781');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/library/borrower-cards/lookup').single.body), {'barcode': 'CARD-7781'});
    final out = jsonDecode(fake.sent('POST', '/api/library/loans/checkout').single.body) as Map;
    expect(out['itemId'], 'i2');
    expect(out['borrowerUserId'], 'aaaaaaaa-0000-4000-8000-000000000001');
    final due = DateTime.parse(out['dueAt'] as String).toLocal();
    expect(due.difference(DateUtils.dateOnly(DateTime.now())).inDays, 14);
    expect(find.text('Checked out: Holes'), findsOneWidget);
  });

  testWidgets('SRO: limited workspace during an incident records their status', (tester) async {
    final fake = FakeServer({
      'GET /api/safety/incidents/$incident/sro-status': (_) => {'data': {'updates': [
        {'status': 'notified', 'officerName': 'Ofc. Diaz', 'unit': null, 'recordedAt': now}]}},
      'POST /api/safety/incidents/$incident/sro-status': (_) => {'data': {'ok': true}},
    }, role: 'sro', incidents: [
      {'id': incident, 'status': 'active', 'kind': 'lockdown', 'isDrill': false, 'schoolName': 'Maple Elementary', 'startedAt': now, 'message': 'Lock doors.'}
    ]);
    await launch(tester, fake);
    expect(find.text('SRO incident workspace'), findsOneWidget);
    expect(find.textContaining('Latest status: Notified · Ofc. Diaz'), findsOneWidget);
    expect(find.textContaining('does not show student rosters'), findsOneWidget);
    expect(find.text('All clear'), findsNothing, reason: 'no leader actions');
    await tester.enterText(find.widgetWithText(TextField, 'Officer name (optional)'), 'Ofc. Diaz');
    await tester.tap(find.text('Update SRO status'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/safety/incidents/$incident/sro-status').single.body),
        {'status': 'responding', 'officerName': 'Ofc. Diaz', 'unit': null, 'note': null});
  });

  testWidgets('superintendent: nodes overview and ending a failover', (tester) async {
    final fake = FakeServer({
      'GET /api/eden/tier': (_) => {'data': {'tier': 'district'}},
      'GET /api/eden/admin/overview': (_) => {'data': {
        'hub': {'rootFingerprint': 'ab:cd', 'districtCertExpires': now},
        'nodes': [
          {'id': 'n1', 'school_name': 'Maple', 'name': 'node-1', 'version': '37.4.0', 'online': false, 'status': 'active', 'last_seen_at': now, 'partner_node_id': 'n2'},
          {'id': 'n2', 'school_name': 'Oak', 'name': 'node-2', 'version': '37.4.0', 'online': true, 'status': 'active', 'last_seen_at': now, 'partner_node_id': 'n1'},
        ],
        'failovers': [{'id': 'f1', 'school_name': 'Maple', 'partner_node_id': 'n2', 'status': 'active', 'expires_at': now, 'authorized_by_name': 'Supt One'}],
        'schools': [], 'bundles': [], 'inbound': []}},
      'POST /api/eden/admin/failovers/f1/end': (_) => {'data': {'ok': true}},
      'GET /api/home': (_) => {'data': {'schools': 2, 'students': 10}},
    }, role: 'superintendent');
    await launch(tester, fake);
    await openTab(tester, 'Nodes');
    expect(find.text('1 of 2 school nodes online'), findsOneWidget);
    expect(find.textContaining('Oak is covering'), findsOneWidget);
    await tester.tap(find.text('End failover'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('End failover').last);
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/eden/admin/failovers/f1/end'), hasLength(1));
  });
}

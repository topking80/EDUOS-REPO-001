import 'dart:convert';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:eduos_mobile_branding/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final server = Uri.parse('https://eduos.example.test');
const incident = 'cccccccc-0000-4000-8000-000000000001';
const ada = 'dddddddd-0000-4000-8000-000000000001';
const ben = 'dddddddd-0000-4000-8000-000000000002';

typedef Handler = Object? Function(http.Request r);

class FakeServer {
  FakeServer(this.routes, {this.role = 'principal', this.incidents = const [], this.canInitiate = true, this.canLead = true});
  final Map<String, Handler> routes;
  final String role;
  List<Map<String, Object?>> incidents;
  final bool canInitiate, canLead;
  final List<http.Request> requests = [];

  List<http.Request> posts(String path) => requests.where((r) => r.method == 'POST' && r.url.path == path).toList();

  http.Client client() => MockClient((r) async {
        requests.add(r);
        final key = '${r.method} ${r.url.path}';
        final common = <String, Handler>{
          'GET /api/me': (_) => {'userId': 'u-p', 'displayName': 'Pat Principal', 'role': role, 'districtId': 'd1', 'schoolId': 's1'},
          'GET /api/branding/current': (_) => {'data': {'school': {'name': 'Maple Elementary'}, 'branding': {}}},
          'GET /api/safety/status': (_) => {'data': {'incidents': incidents, 'canInitiate': canInitiate, 'canLead': canLead}},
          'GET /api/notifications': (_) => {'data': {'unread': 0, 'items': []}},
          'GET /api/home': (_) => {'data': {'school_name': 'Maple Elementary', 'students': 412, 'absent_today': 9, 'open_cases': 3, 'overdue_follow_ups': 1, 'pending_invitations': 2}},
          'GET /api/transport/today': (_) => {'data': {'routes': [{'counts': {'onBoard': 12, 'riders': 30}}, {'counts': {'onBoard': 3, 'riders': 20}}]}},
          'GET /api/comms/announcements': (_) => {'data': []},
          'GET /api/pickup/queue': (_) => {'data': {'incident': null, 'waiting': [{'name': 'Ada Lovelace', 'adult': 'Pat Parent', 'at': DateTime.now().toIso8601String()}], 'released': [], 'blocked': 0, 'denied': 0, 'earlyDismissals': []}},
        };
        final handler = routes[key] ?? common[key];
        final body = handler?.call(r);
        if (body == null) return http.Response('{"error":"not_found"}', 404);
        if (body is http.Response) return body;
        return http.Response(jsonEncode(body), r.method == 'POST' ? 201 : 200);
      });
}

Future<AppController> launch(WidgetTester tester, FakeServer fake) async {
  // A tall phone-like surface so long staff screens fit without fiddly scrolling.
  tester.view.physicalSize = const Size(800, 2400);
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

Future<void> openPickupAndCheck(WidgetTester tester, String code) async {
  await tester.tap(find.text('Pick-up').last);
  await tester.pumpAndSettle();
  await tester.enterText(find.widgetWithText(TextField, 'Pass code (type it or use a handheld scanner)'), code);
  await tester.tap(find.text('Check pass'));
  await tester.pumpAndSettle();
}

Map<String, Object?> passResult({bool custody = false, bool blocked = false}) => {
      'data': {
        'pass': 'valid',
        'adult': {'name': 'Pat Parent', 'relationship': 'Parent', 'kind': 'guardian'},
        'students': [
          {'studentId': ada, 'name': 'Ada Lovelace', 'grade': '4', 'eligible': !blocked, 'reason': blocked ? 'do_not_release' : null,
           'custodyOrder': custody, 'flagDetail': custody ? 'Order 22-114: mother only on weekdays' : null, 'earlyDismissal': null},
          {'studentId': ben, 'name': 'Ben Lovelace', 'grade': '2', 'eligible': false, 'reason': 'adult_not_approved', 'custodyOrder': false},
        ],
        'blocked': blocked,
        'reunification': false,
        'instructions': blocked ? 'Do not release. The office has been alerted. Keep the learner inside with staff.' : 'Check the adult\'s photo ID matches the name above, then release.',
      },
    };

void main() {
  group('Pick-up desk', () {
    testWidgets('release needs the photo-ID check and sends only eligible learners', (tester) async {
      final fake = FakeServer({
        'POST /api/pickup/verify': (_) => passResult(),
        'POST /api/pickup/release': (_) => {'data': {'released': [{'name': 'Ada Lovelace'}]}},
      });
      await launch(tester, fake);
      await openPickupAndCheck(tester, '7kq2m-x9pda');
      expect(find.text('Pat Parent'), findsWidgets);
      expect(find.text('Adult not approved'), findsOneWidget);
      expect(jsonDecode(fake.posts('/api/pickup/verify').single.body), {'code': '7kq2m-x9pda'});
      await tester.ensureVisible(find.text('Release'));
      await tester.tap(find.text('Release'));
      await tester.pump();
      expect(find.text('Check the photo ID first.'), findsOneWidget);
      expect(fake.posts('/api/pickup/release'), isEmpty);
      await tester.tap(find.text('I checked a photo ID and it matches Pat Parent'));
      await tester.tap(find.text('Release'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.posts('/api/pickup/release').single.body),
          {'code': '7kq2m-x9pda', 'studentIds': [ada], 'idChecked': true, 'custodyAcknowledged': false});
      expect(find.text('Released: Ada'), findsOneWidget);
    });

    testWidgets('a custody order must be acknowledged before release', (tester) async {
      final fake = FakeServer({
        'POST /api/pickup/verify': (_) => passResult(custody: true),
        'POST /api/pickup/release': (_) => {'data': {'released': [{'name': 'Ada Lovelace'}]}},
      });
      await launch(tester, fake);
      await openPickupAndCheck(tester, 'CODE1');
      expect(find.text('Custody order: Order 22-114: mother only on weekdays'), findsOneWidget);
      await tester.tap(find.text('I checked a photo ID and it matches Pat Parent'));
      await tester.ensureVisible(find.text('Release'));
      await tester.tap(find.text('Release'));
      await tester.pump();
      expect(find.text('Confirm the custody order first.'), findsOneWidget);
      await tester.tap(find.text('I checked the custody order allows this release'));
      await tester.tap(find.text('Release'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.posts('/api/pickup/release').single.body)['custodyAcknowledged'], true);
    });

    testWidgets('a do-not-release flag blocks the release outright', (tester) async {
      final fake = FakeServer({'POST /api/pickup/verify': (_) => passResult(blocked: true)});
      await launch(tester, fake);
      await openPickupAndCheck(tester, 'CODE2');
      expect(find.text('DO NOT RELEASE'), findsOneWidget);
      expect(find.text('Release'), findsNothing);
      expect(find.textContaining('The office has been alerted'), findsOneWidget);
    });

    testWidgets('an unknown pass says do not release; a refusal is logged with its reason', (tester) async {
      var known = false;
      final fake = FakeServer({
        'POST /api/pickup/verify': (_) => known ? passResult() : http.Response('{"error":"pass_not_found"}', 404),
        'POST /api/pickup/deny': (_) => {'data': {'ok': true}},
      });
      await launch(tester, fake);
      await openPickupAndCheck(tester, 'NOPE');
      expect(find.text('Pass not recognised'), findsOneWidget);
      expect(find.text('Do not release. Ask for another pass or call the office.'), findsOneWidget);
      known = true;
      await tester.tap(find.text('Check pass'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Refuse'));
      await tester.tap(find.text('Refuse'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'ID name did not match');
      await tester.tap(find.widgetWithText(FilledButton, 'Refuse'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.posts('/api/pickup/deny').single.body), {'code': 'NOPE', 'reason': 'ID name did not match'});
    });

    testWidgets('leaders approve adults from the Approvals view', (tester) async {
      final fake = FakeServer({
        'GET /api/pickup/admin': (_) => {'data': {
          'pendingAdults': [{'id': 'pa1', 'full_name': 'Gran Lovelace', 'relationship': 'Grandmother', 'student_name': 'Ada Lovelace', 'requested_by_name': 'Pat Parent', 'requested_at': DateTime.now().toIso8601String()}],
          'earlyDismissals': [], 'restrictions': []}},
        'GET /api/students': (_) => {'data': [{'id': ada, 'display_name': 'Ada Lovelace', 'grade_level': '4'}]},
        'POST /api/pickup/adults/pa1/decision': (_) => {'data': {'ok': true}},
      });
      await launch(tester, fake);
      await tester.tap(find.text('Pick-up').last);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Approvals'));
      await tester.pumpAndSettle();
      expect(find.text('Gran Lovelace · Grandmother'), findsOneWidget);
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.posts('/api/pickup/adults/pa1/decision').single.body), {'decision': 'approve'});
    });
  });

  group('Safety', () {
    Map<String, Object?> live() => {
          'id': incident, 'status': 'active', 'kind': 'lockdown', 'isDrill': true, 'schoolName': 'Maple Elementary',
          'startedAt': DateTime.now().toIso8601String(), 'message': 'Lock doors, lights off.'};

    testWidgets('during an incident leaders see accountability and can send the all clear', (tester) async {
      final fake = FakeServer({
        'GET /api/safety/incidents/$incident/board': (_) => {'data': {
          'totals': {'enrolled': 4, 'accounted': 3, 'present': 2, 'missing': 1, 'injured': 1, 'unaccounted': 1, 'extra': 0, 'released': 0},
          'missing': [{'name': 'Ben Lovelace', 'grade': '2', 'by': 'Ms. Rivera'}], 'injured': [{'name': 'Cy Ramos', 'grade': '5', 'note': 'twisted ankle'}],
          'teachers': [{'name': 'Ms. Rivera', 'roster': 22, 'submittedAt': DateTime.now().toIso8601String()}, {'name': 'Mr. Lee', 'roster': 20, 'submittedAt': null}],
          'unaccounted': [{'name': 'Dee Moss', 'grade': '3'}],
          'events': [{'event': 'confirmed', 'detail': null, 'at': DateTime.now().toIso8601String(), 'actor_name': 'Pat Principal'}]}},
        'POST /api/safety/incidents/$incident/all-clear': (_) => {'data': {'ok': true}},
      }, incidents: [live()]);
      await launch(tester, fake);
      expect(find.text('LOCKDOWN'), findsOneWidget);
      expect(find.text('3 of 4 accounted for'), findsOneWidget);
      expect(find.text('Ben Lovelace'), findsOneWidget);
      expect(find.text('Roll call by class (1/2)'), findsOneWidget);
      fake.incidents = [];
      await tester.scrollUntilVisible(find.text('All clear'), 300, scrollable: find.byType(Scrollable).first);
      await tester.tap(find.text('All clear'));
      await tester.pumpAndSettle();
      expect(find.text('All clear: end the drill?'), findsOneWidget);
      await tester.tap(find.text('Yes, all clear'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.posts('/api/safety/incidents/$incident/all-clear').single.body), {'kind': 'lockdown'});
      expect(find.text('LOCKDOWN'), findsNothing, reason: 'normal tabs are back after the all clear');
      expect(find.byType(NavigationBar), findsOneWidget);
    });

    testWidgets('leaders see what the alert reached, with queued and failed channels kept apart from confirmed ones', (tester) async {
      final fake = FakeServer({
        'GET /api/safety/incidents/$incident/board': (_) => {'data': {
          'totals': {'enrolled': 1, 'accounted': 1, 'present': 1}, 'missing': [], 'injured': [], 'teachers': [], 'unaccounted': [], 'events': [],
          'notifications': {'inApp': {'available': 40, 'read': 12}, 'external': {'pending': 30, 'delivered': 5, 'skipped': 0, 'failed': 5},
            'byChannel': {}, 'emergencyServicesContacted': false}}},
      }, incidents: [live()]);
      await launch(tester, fake);
      await tester.scrollUntilVisible(find.text('Alert delivery'), 300, scrollable: find.byType(Scrollable).first);
      for (final label in ['in the EduOS app', 'opened', 'email/SMS/push confirmed', 'email/SMS/push waiting', 'email/SMS/push failed']) {
        expect(find.text(label), findsOneWidget, reason: label);
      }
      expect(find.text('EduOS does not contact 911 or other emergency services. Call them directly.'), findsOneWidget);
    });

    testWidgets('starting an alert is two steps; declining the second step cancels it', (tester) async {
      final fake = FakeServer({
        'POST /api/safety/incidents': (_) => {'data': {'id': incident, 'schoolName': 'Maple Elementary'}},
        'POST /api/safety/incidents/$incident/cancel': (_) => {'data': {'ok': true}},
        'POST /api/safety/incidents/$incident/confirm': (_) => {'data': {'ok': true}},
        'GET /api/safety/incidents': (_) => {'data': []},
      });
      await launch(tester, fake);
      await tester.tap(find.byTooltip('Safety: start an alert'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('EVACUATE'));
      await tester.pump();
      await tester.ensureVisible(find.text('Continue'));
      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();
      expect(find.text('Start a DRILL EVACUATE?'), findsOneWidget);
      expect(jsonDecode(fake.posts('/api/safety/incidents').single.body), {'kind': 'evacuate', 'isDrill': true});
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(fake.posts('/api/safety/incidents/$incident/cancel'), hasLength(1));
      expect(fake.posts('/api/safety/incidents/$incident/confirm'), isEmpty);

      await tester.tap(find.text('Continue'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Yes, start drill'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.posts('/api/safety/incidents/$incident/confirm').single.body), {'kind': 'evacuate', 'isDrill': true});
    });
  });

  testWidgets('school overview shows today\'s numbers and posts a school announcement', (tester) async {
    final fake = FakeServer({
      'POST /api/comms/announcements': (_) => {'data': {'recipients': 380}},
    });
    await launch(tester, fake);
    expect(find.text('School overview'), findsOneWidget);
    expect(find.text('2 bus runs today · 15 of 50 riders on board now'), findsOneWidget);
    expect(find.text('412'), findsOneWidget);
    await tester.scrollUntilVisible(find.widgetWithText(TextField, 'Title'), 300, scrollable: find.byType(Scrollable).first);
    await tester.enterText(find.widgetWithText(TextField, 'Title'), 'Picture day');
    await tester.enterText(find.widgetWithText(TextField, 'Message'), 'Friday, wear a smile.');
    await tester.ensureVisible(find.text('Post'));
    await tester.tap(find.text('Post'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.posts('/api/comms/announcements').single.body),
        {'scope': 'school', 'title': 'Picture day', 'body': 'Friday, wear a smile.', 'audience': ['teacher', 'parent', 'pupil', 'driver']});
    expect(find.text('Posted to 380 people'), findsOneWidget);
  });
}

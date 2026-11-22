import 'dart:convert';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/core/auth_service.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:eduos_mobile_branding/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final server = Uri.parse('https://eduos.example.test');
const kid = '11111111-1111-4111-8111-111111111111';
const adultMe = '22222222-2222-4222-8222-222222222222';

/// A small fake EduOS server for one parent with one child.
class FakeEduOs {
  List<Map<String, Object?>> incidents = [];
  final List<http.Request> requests = [];
  final Map<String, Object?> extra = {};

  http.Client client() => MockClient((r) async {
        requests.add(r);
        expect(r.headers['authorization'], startsWith('Bearer '));
        final key = '${r.method} ${r.url.path}';
        Object? body = switch (key) {
          'GET /api/me' => {'userId': 'u-parent', 'displayName': 'Pat Parent', 'role': 'parent', 'districtId': 'd1', 'schoolId': 's1'},
          'GET /api/branding/current' => {'data': {'school': {'name': 'Maple Elementary'}, 'districtName': 'Lake District', 'branding': {'primary': '#2f6fbf', 'accent': '#f6c445'}}},
          'GET /api/safety/status' => {'data': {'incidents': incidents, 'canInitiate': false, 'canLead': false}},
          'GET /api/notifications' => {'data': {'unread': 2, 'items': [{'kind': 'transport', 'title': 'Bus 4 is running late', 'body': 'About 10 minutes', 'created_at': DateTime.now().toIso8601String(), 'read_at': null}]}},
          'GET /api/home' => {'role': 'parent', 'data': {'children': [{'id': kid, 'display_name': 'Ada Lovelace', 'grade_level': '4', 'school_name': 'Maple Elementary', 'absences_30d': 1, 'due_7d': 3, 'overdue': 0, 'to_acknowledge': 2}]}},
          'GET /api/transport/today' => {'data': {'riders': [{'id': kid, 'display_name': 'Ada Lovelace', 'direction': 'am', 'status': 'boarded', 'route_name': 'North loop', 'bus_label': 'Bus 4', 'stop_name': 'Elm & 9th', 'stop_time': '07:42', 'run_id': 'r1', 'events': [{'recorded_at': DateTime.now().toIso8601String(), 'event': 'boarded', 'is_school': false, 'stop_name': 'Elm & 9th'}]}]}},
          'GET /api/family/children/$kid/summary' => {'attendance': [{'event_date': '2026-11-13', 'status': 'present'}, {'event_date': '2026-11-12', 'status': 'absent'}]},
          'GET /api/pickup/family' => {'data': {'children': [{'id': kid, 'display_name': 'Ada Lovelace', 'school_name': 'Maple Elementary', 'adults': [{'id': adultMe, 'full_name': 'Pat Parent', 'relationship': 'Parent', 'status': 'approved', 'kind': 'guardian', 'is_me': true}], 'earlyDismissals': [], 'log': []}]}},
          'POST /api/pickup/tags' => {'data': {'code': 'K7Q-4MP', 'qr': ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'], 'adultName': 'Pat Parent', 'expiresAt': DateTime.now().add(const Duration(hours: 12)).toIso8601String()}},
          'GET /api/comms/threads' => {'data': [{'id': 't1', 'subject': 'Field trip form', 'with_names': 'Ms. Rivera', 'student_name': 'Ada Lovelace', 'last_message_at': DateTime.now().toIso8601String(), 'last_body': 'Thanks!', 'unread': 1, 'status': 'open'}]},
          'GET /api/comms/announcements' => {'data': []},
          'GET /api/comms/threads/t1' => {'data': {'id': 't1', 'subject': 'Field trip form', 'kind': 'family', 'student_name': 'Ada Lovelace', 'status': 'open', 'participants': [{'user_id': 'u-parent', 'name': 'Pat Parent'}, {'user_id': 'u-t', 'name': 'Ms. Rivera'}], 'messages': [{'id': 'm1', 'author_user_id': 'u-t', 'author_name': 'Ms. Rivera', 'body': 'Please sign the form.', 'hidden': false, 'created_at': DateTime.now().toIso8601String(), 'read_by': []}]}},
          'POST /api/comms/threads/t1/messages' => {'data': {'id': 'm2'}},
          'GET /api/library/family-loans' => {'data': [{'title': 'Charlotte\'s Web', 'student_name': 'Ada Lovelace', 'due_at': '2026-11-20T00:00:00Z', 'returned_at': null, 'overdue': false}]},
          _ => extra[key],
        };
        if (body == null) return http.Response('{"error":"not_found"}', 404);
        if (r.method == 'POST') expect(r.headers['x-csrf-token'], 'csrf-1');
        return http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
      });
}

Future<AppController> signedInApp(WidgetTester tester, FakeEduOs fake) async {
  final kv = MemoryKeyValueStore();
  final sessions = SessionStore(kv);
  await sessions.saveServer(server);
  await sessions.save(Session(serverUrl: server, token: 'tok-1', csrfToken: 'csrf-1', expiresAt: DateTime.now().add(const Duration(hours: 8))));
  final app = AppController(store: kv, httpClientFactory: fake.client, safetyPollInterval: null);
  addTearDown(app.dispose);
  await app.start();
  await tester.pumpWidget(EduOsApp(controller: app));
  await tester.pumpAndSettle();
  return app;
}

void main() {
  testWidgets('a signed-in parent sees their child, attendance, bus status and alerts badge', (tester) async {
    final fake = FakeEduOs();
    final app = await signedInApp(tester, fake);
    expect(app.stage, AppStage.signedIn);
    expect(find.text('Ada Lovelace'), findsOneWidget);
    expect(find.text('Grade 4 · Maple Elementary'), findsOneWidget);
    expect(find.text('On board'), findsOneWidget);
    expect(find.textContaining('Absent'), findsOneWidget);
    expect(find.text('2'), findsWidgets); // unread alerts badge
    for (final label in ['Children', 'Library books', 'Arrival', 'Pick-up', 'More']) {
      expect(find.text(label), findsWidgets, reason: label);
    }
    expect(fake.requests.any((r) => r.headers.containsKey('cookie')), isFalse);
  });

  testWidgets('a person with several profiles switches from the top bar', (tester) async {
    final fake = FakeEduOs();
    fake.extra['GET /api/memberships'] = {'data': [
      {'id': 'm-parent', 'role': 'parent', 'district_id': 'd1', 'district_name': 'Lake District', 'school_id': 's1', 'school_name': 'Maple Elementary', 'current': true},
      {'id': 'm-teacher', 'role': 'teacher', 'district_id': 'd1', 'district_name': 'Lake District', 'school_id': 's2', 'school_name': 'Oak Middle', 'current': false},
      {'id': 'm-hill', 'role': 'parent', 'district_id': 'd2', 'district_name': 'Hill County', 'school_id': 's9', 'school_name': 'Hill Primary', 'current': false},
    ]};
    fake.extra['POST /api/session/membership'] = {'role': 'teacher', 'districtId': 'd1', 'schoolId': 's2', 'csrfToken': 'csrf-1',
        'sessionToken': 'tok-2', 'expiresAt': DateTime.now().add(const Duration(hours: 8)).toIso8601String()};
    final app = await signedInApp(tester, fake);
    expect(app.profiles, hasLength(3));
    await tester.tap(find.byTooltip('Switch profile'));
    await tester.pumpAndSettle();
    expect(find.text('Switch profile'), findsOneWidget);
    // Profiles in two districts: each label names its district.
    expect(find.text('Teacher · Oak Middle · Lake District'), findsOneWidget);
    expect(find.text('Family · Hill Primary · Hill County'), findsOneWidget);
    await tester.tap(find.text('Teacher · Oak Middle · Lake District'));
    await tester.pumpAndSettle();
    final post = fake.requests.lastWhere((r) => r.url.path == '/api/session/membership');
    expect(jsonDecode(post.body), {'membershipId': 'm-teacher'});
    expect(fake.requests.last.headers['authorization'], 'Bearer tok-2', reason: 'the new session is used from then on');
  });

  testWidgets('one profile: no switch button', (tester) async {
    await signedInApp(tester, FakeEduOs());
    expect(find.byTooltip('Switch profile'), findsNothing);
  });

  testWidgets('arrival shows driver check-ins; the library shows loans', (tester) async {
    await signedInApp(tester, FakeEduOs());
    await tester.tap(find.text('Arrival').last);
    await tester.pumpAndSettle();
    expect(find.textContaining('Bus 4 · North loop · stop Elm & 9th (07:42)'), findsOneWidget);
    expect(find.textContaining('never tracks your child\'s location'), findsOneWidget);
    await tester.tap(find.text('Library books').last);
    await tester.pumpAndSettle();
    expect(find.text('Charlotte\'s Web'), findsOneWidget);
    expect(find.text('On loan'), findsOneWidget);
  });

  testWidgets('pick-up makes a one-time pass with a QR code', (tester) async {
    final fake = FakeEduOs();
    await signedInApp(tester, fake);
    await tester.tap(find.text('Pick-up').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Show my pick-up pass'));
    await tester.pumpAndSettle();
    expect(find.text('K7Q-4MP'), findsOneWidget);
    expect(find.bySemanticsLabel('QR code for the pick-up pass of Pat Parent'), findsOneWidget);
    final post = fake.requests.lastWhere((r) => r.url.path == '/api/pickup/tags');
    expect(jsonDecode(post.body), {'adultId': adultMe});
  });

  testWidgets('messages: open a conversation and reply', (tester) async {
    final fake = FakeEduOs();
    await signedInApp(tester, fake);
    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Messages').last);
    await tester.pumpAndSettle();
    expect(find.text('1 new'), findsOneWidget);
    await tester.tap(find.text('Field trip form'));
    await tester.pumpAndSettle();
    expect(find.text('Please sign the form.'), findsOneWidget);
    await tester.enterText(find.widgetWithText(TextField, 'Reply'), 'Signed and sent back.');
    await tester.tap(find.byTooltip('Send'));
    await tester.pumpAndSettle();
    final post = fake.requests.lastWhere((r) => r.method == 'POST');
    expect(post.url.path, '/api/comms/threads/t1/messages');
    expect(jsonDecode(post.body), {'body': 'Signed and sent back.'});
  });

  testWidgets('a live incident takes over the app; reunification offers the pick-up pass', (tester) async {
    final fake = FakeEduOs()
      ..incidents = [
        {'id': 'i1', 'status': 'reunification', 'kind': 'evacuate', 'isDrill': false, 'schoolName': 'Maple Elementary', 'startedAt': DateTime.now().toIso8601String(),
         'message': 'Students are safe at the reunification site.', 'reunificationPoint': 'Lake Park pavilion', 'children': [{'id': kid, 'name': 'Ada Lovelace', 'released': null}]},
      ];
    await signedInApp(tester, fake);
    expect(find.text('REUNIFICATION'), findsOneWidget);
    expect(find.text('THIS IS NOT A DRILL'), findsOneWidget);
    expect(find.text('Reunification point: Lake Park pavilion'), findsOneWidget);
    expect(find.text('With staff'), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing, reason: 'other tabs wait for the all-clear');
    await tester.tap(find.text('Show my pick-up pass'));
    await tester.pumpAndSettle();
    expect(find.text('Who can pick up'), findsOneWidget);
  });

  testWidgets('first run asks for the server, then signs in through the system browser', (tester) async {
    // The mascot animates continuously unless the phone asks for reduced motion.
    tester.platformDispatcher.accessibilityFeaturesTestValue = const FakeAccessibilityFeatures(disableAnimations: true);
    addTearDown(tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
    final fake = FakeEduOs();
    final kv = MemoryKeyValueStore();
    final auth = AuthService(
      authenticate: ({required url, required callbackUrlScheme}) async => 'org.eduos.app:/oauth2redirect?code=handoff',
      httpClient: MockClient((r) async => http.Response(jsonEncode({'sessionToken': 'tok-1', 'csrfToken': 'csrf-1', 'expiresAt': DateTime.now().add(const Duration(hours: 8)).toIso8601String()}), 200)),
    );
    final app = AppController(store: kv, auth: auth, httpClientFactory: fake.client, safetyPollInterval: null);
    addTearDown(app.dispose);
    await app.start();
    await tester.pumpWidget(EduOsApp(controller: app));
    await tester.pumpAndSettle();
    expect(find.text('Welcome to EduOS'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'http://eduos.example.test');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('The address must start with https://'), findsOneWidget);
    await tester.enterText(find.byType(TextField), 'eduos.example.test');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('Sign in to EduOS'), findsOneWidget);
    await tester.tap(find.text('Sign in with your school account'));
    await tester.pumpAndSettle();
    expect(app.stage, AppStage.signedIn);
    expect(find.text('Ada Lovelace'), findsOneWidget);
    expect(kv.values['eduos.session'], contains('tok-1'));
  });
}

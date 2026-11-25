import 'dart:convert';
import 'dart:io';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:eduos_mobile_branding/core/format.dart';
import 'package:eduos_mobile_branding/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final server = Uri.parse('https://eduos.example.test');
const run = 'aaaaaaaa-0000-4000-8000-000000000001';
const homeStop = 'bbbbbbbb-0000-4000-8000-000000000001';
const schoolStop = 'bbbbbbbb-0000-4000-8000-000000000002';
const incident = 'cccccccc-0000-4000-8000-000000000001';
const ada = 'dddddddd-0000-4000-8000-000000000001';
const ben = 'dddddddd-0000-4000-8000-000000000002';

/// Fake EduOS server. [routes] maps "METHOD /path" to a JSON body (or a
/// function of the request). When [offlineWrites] is true, POSTs fail as if
/// the phone had no signal.
class FakeServer {
  FakeServer(this.role, this.routes);
  final String role;
  final Map<String, Object? Function(http.Request r)> routes;
  final List<http.Request> requests = [];
  bool offlineWrites = false;

  http.Client client() => MockClient((r) async {
        requests.add(r);
        if (r.method == 'POST' && offlineWrites) throw const SocketException('no signal');
        final key = '${r.method} ${r.url.path}';
        final common = <String, Object?>{
          'GET /api/me': {'userId': 'u-$role', 'displayName': 'Sam Staff', 'role': role, 'districtId': 'd1', 'schoolId': 's1'},
          'GET /api/branding/current': {'data': {'school': {'name': 'Maple Elementary'}, 'branding': {}}},
          'GET /api/safety/status': {'data': {'incidents': []}},
          'GET /api/notifications': {'data': {'unread': 0, 'items': []}},
        };
        final handler = routes[key];
        final body = handler != null ? handler(r) : common[key];
        if (body == null) return http.Response('{"error":"not_found"}', 404);
        if (body is http.Response) return body;
        return http.Response(jsonEncode(body), r.method == 'POST' ? 201 : 200);
      });
}

Future<AppController> launch(WidgetTester tester, FakeServer fake) async {
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

Map<String, Object?> routeJson({String? runStatus = 'in_progress', String benStatus = 'expected', String cyStatus = 'boarded'}) => {
      'data': {
        'role': 'driver',
        'routes': [
          {
            'id': 'r1', 'name': 'North loop', 'bus_label': 'Bus 4', 'direction': 'am', 'school_name': 'Maple Elementary',
            'run': runStatus == null ? null : {'id': run, 'status': runStatus, 'completed_at': null},
            'counts': {'onBoard': 1, 'expected': 1, 'alighted': 0},
            'stops': [
              {'id': homeStop, 'seq': 1, 'name': 'Elm & 9th', 'time': '07:42', 'is_school': false, 'riders': [
                {'studentId': ben, 'name': 'Ben Okafor', 'grade': '3', 'status': benStatus},
                {'studentId': ada, 'name': 'Cy Ramos', 'grade': '5', 'status': cyStatus},
              ]},
              {'id': schoolStop, 'seq': 2, 'name': 'Maple Elementary', 'time': '08:05', 'is_school': true, 'riders': []},
            ],
          },
        ],
      },
    };

void main() {
  group('Bus driver route', () {
    testWidgets('ON BOARD sends an idempotent check-in for that rider and stop', (tester) async {
      var ben = 'expected';
      final fake = FakeServer('driver', {
        'GET /api/transport/today': (_) => routeJson(benStatus: ben),
        'POST /api/transport/runs/$run/checkins': (r) {
          ben = 'boarded';
          return {'data': {'id': 'c1'}};
        },
      });
      await launch(tester, fake);
      expect(find.text('Bus 4 · North loop'), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('Ben Okafor: on board'));
      await tester.pumpAndSettle();
      final post = fake.requests.lastWhere((r) => r.method == 'POST');
      expect(jsonDecode(post.body), {'studentId': 'dddddddd-0000-4000-8000-000000000002', 'stopId': homeStop, 'event': 'boarded'});
      expect(post.headers['idempotency-key'], matches(RegExp(r'^[0-9a-f]{32}$')));
      expect(post.headers['x-eduos-queued-at'], isNotNull);
      expect(find.bySemanticsLabel('Ben Okafor: on board'), findsNothing, reason: 'reloaded from the server');
      // Cy and Ben are both on board now, so both can be dropped off at school.
      expect(find.bySemanticsLabel('Cy Ramos: off the bus'), findsOneWidget);
      expect(find.bySemanticsLabel('Ben Okafor: off the bus'), findsOneWidget);
    });

    testWidgets('with no signal the check-in is saved on the phone, shown, and sent later with the same key', (tester) async {
      final fake = FakeServer('driver', {
        'GET /api/transport/today': (_) => routeJson(),
        'POST /api/transport/runs/$run/checkins': (_) => {'data': {'id': 'c1'}},
      });
      final app = await launch(tester, fake);
      fake.offlineWrites = true;
      await tester.tap(find.bySemanticsLabel('Ben Okafor: on board'));
      await tester.pumpAndSettle();
      expect(find.textContaining('saved on this phone'), findsWidgets);
      final savedIcon = find.byWidgetPredicate((w) => w is Icon && w.semanticLabel == 'Saved on this phone');
      expect(savedIcon, findsOneWidget);
      expect(app.queued, 1);
      final original = (await app.queue.entries()).single;

      fake.offlineWrites = false;
      final result = await app.flushQueue();
      await tester.pumpAndSettle();
      expect([result?.sent, app.queued], [1, 0]);
      final replay = fake.requests.lastWhere((r) => r.method == 'POST');
      expect(replay.headers['idempotency-key'], original.idempotencyKey);
      expect(replay.headers['x-eduos-queued-at'], original.queuedAt.toUtc().toIso8601String());
      expect(savedIcon, findsNothing);
    });

    testWidgets('a run that hasn\'t started offers Start run; Finish run explains riders still on board', (tester) async {
      var started = false;
      final fake = FakeServer('driver', {
        'GET /api/transport/today': (_) => routeJson(runStatus: started ? 'in_progress' : null),
        'POST /api/transport/runs': (r) {
          started = true;
          return {'data': {'id': run}};
        },
        'POST /api/transport/runs/$run/complete': (_) => http.Response('{"error":"riders_still_on_board","onBoard":1}', 409),
      });
      await launch(tester, fake);
      expect(find.bySemanticsLabel('Ben Okafor: on board'), findsNothing, reason: 'no check-ins before the run starts');
      await tester.tap(find.text('Start run'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.requests.lastWhere((r) => r.method == 'POST').body), {'routeId': 'r1'});
      // The list builds lazily, so scroll the screen's list until the button exists.
      await tester.scrollUntilVisible(find.text('Finish run'), 300, scrollable: find.byType(Scrollable).first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('Finish run'));
      await tester.pumpAndSettle();
      expect(fake.requests.last.url.path, '/api/transport/runs/$run/complete');
      expect(find.text('Riders still on board. Check everyone off first.'), findsOneWidget);
    });
  });

  group('Teacher class register', () {
    final today = isoDate(DateTime.now());
    Map<String, Object? Function(http.Request)> teacherRoutes(List<Map<String, Object?>> marks) => {
          'GET /api/home': (_) => {'data': {'school_name': 'Maple Elementary', 'students': 2, 'to_grade': 3, 'open_assignments': 1, 'absences_7d': 0}},
          'GET /api/rosters': (_) => {'data': [{'student_id': ada, 'student_name': 'Ada Lovelace'}, {'student_id': ben, 'student_name': 'Ben Okafor'}]},
          'GET /api/attendance': (_) => {'data': marks},
          'GET /api/arrival/today': (_) => {'data': []},
          'POST /api/attendance': (r) {
            final b = jsonDecode(r.body) as Map<String, dynamic>;
            marks.insert(0, {'student_id': b['studentId'], 'event_date': b['eventDate'], 'status': b['status']});
            return {'data': {'id': 'a1'}};
          },
        };

    testWidgets('shows today\'s marks, records a mark and marks the rest present', (tester) async {
      final marks = <Map<String, Object?>>[
        {'student_id': ada, 'event_date': today, 'status': 'present'},
        {'student_id': ben, 'event_date': '2020-01-01', 'status': 'absent'},
      ];
      final fake = FakeServer('teacher', teacherRoutes(marks));
      await launch(tester, fake);
      await tester.tap(find.text('Classes'));
      await tester.pumpAndSettle();
      expect(find.text('Today in class'), findsOneWidget);
      expect(find.text('1 of 2 marked'), findsOneWidget, reason: 'older marks don\'t count for today');
      await tester.tap(find.text('Mark the other 1 present'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Mark present'));
      await tester.pumpAndSettle();
      final post = fake.requests.lastWhere((r) => r.method == 'POST');
      expect(post.url.path, '/api/attendance');
      expect(jsonDecode(post.body), {'studentId': ben, 'eventDate': today, 'status': 'present'});
      expect(post.headers['idempotency-key'], isNotNull);
      expect(find.text('2 of 2 marked'), findsOneWidget);
    });

    testWidgets('marks taken with no signal are kept on the phone and shown', (tester) async {
      final fake = FakeServer('teacher', teacherRoutes([]));
      final app = await launch(tester, fake);
      await tester.tap(find.text('Classes'));
      await tester.pumpAndSettle();
      fake.offlineWrites = true;
      await tester.tap(find.text('Absent').last);
      await tester.pumpAndSettle();
      expect(app.queued, 1);
      expect(find.text('1 of 2 marked'), findsOneWidget);
      expect(find.textContaining('saved on this phone'), findsWidgets);
      expect((await app.queue.entries()).single.body, {'studentId': ben, 'eventDate': today, 'status': 'absent'});
    });
  });

  group('Teacher safety roll call', () {
    Map<String, Object? Function(http.Request)> safetyRoutes() => {
          'GET /api/safety/status': (_) => {'data': {'incidents': [
            {'id': incident, 'status': 'active', 'kind': 'lockdown', 'isDrill': true, 'schoolName': 'Maple Elementary', 'startedAt': DateTime.now().toIso8601String(), 'message': 'Lock doors, lights off.'},
          ]}},
          'GET /api/safety/incidents/$incident/rollcall': (_) => {'data': {
            'learners': [{'studentId': ada, 'name': 'Ada Lovelace', 'grade': '4', 'status': null}, {'studentId': ben, 'name': 'Ben Okafor', 'grade': '4', 'status': null}],
            'extras': [], 'submittedAt': null}},
          'POST /api/safety/incidents/$incident/rollcall': (_) => {'data': {'counts': {'present': 1, 'missing': 1, 'injured': 0}}},
        };

    testWidgets('the incident takes over; the teacher marks the class and sends the roll call', (tester) async {
      final fake = FakeServer('teacher', safetyRoutes());
      await launch(tester, fake);
      expect(find.text('LOCKDOWN'), findsOneWidget);
      expect(find.text('DRILL · THIS IS A DRILL'), findsOneWidget);
      await tester.tap(find.text('Present').first);
      await tester.tap(find.text('Missing').last);
      await tester.pump();
      await tester.ensureVisible(find.text('Send roll call'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Send roll call'));
      await tester.pumpAndSettle();
      final post = fake.requests.lastWhere((r) => r.method == 'POST');
      expect(jsonDecode(post.body), {'entries': [{'studentId': ada, 'status': 'present'}, {'studentId': ben, 'status': 'missing'}]});
      expect(post.headers['idempotency-key'], isNotNull);
      expect(find.textContaining('Roll call sent: 1 present, 1 missing, 0 injured'), findsOneWidget);
    });

    testWidgets('unmarked learners need confirmation; with no signal the roll call is saved on the phone', (tester) async {
      final fake = FakeServer('teacher', safetyRoutes());
      final app = await launch(tester, fake);
      fake.offlineWrites = true;
      await tester.tap(find.text('Present').first);
      await tester.pump();
      await tester.ensureVisible(find.text('Send roll call'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Send roll call'));
      await tester.pumpAndSettle();
      expect(find.text('1 learner is not marked yet. You can send now and update later.'), findsOneWidget);
      await tester.tap(find.text('Send now'));
      await tester.pumpAndSettle();
      expect(app.queued, 1);
      expect(find.textContaining('Saved on this phone'), findsWidgets);
      expect((await app.queue.entries()).single.path, '/api/safety/incidents/$incident/rollcall');
    });
  });
}

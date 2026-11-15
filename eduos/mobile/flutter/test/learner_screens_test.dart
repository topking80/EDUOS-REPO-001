import 'dart:convert';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:eduos_mobile_branding/main.dart';
import 'package:eduos_mobile_branding/ui/screens/courses_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final server = Uri.parse('https://eduos.example.test');
const skill = 'eeeeeeee-0000-4000-8000-000000000001';
const session = 'eeeeeeee-0000-4000-8000-000000000002';
const course = 'eeeeeeee-0000-4000-8000-000000000003';
const quiz = 'eeeeeeee-0000-4000-8000-000000000004';
const attempt = 'eeeeeeee-0000-4000-8000-000000000005';
const q1 = 'eeeeeeee-0000-4000-8000-0000000000a1';
const q2 = 'eeeeeeee-0000-4000-8000-0000000000a2';

typedef Handler = Object? Function(http.Request r);

Map<String, Object?> pathJson({String? active}) => {
      'data': {
        'learner': {'name': 'Ada', 'grade': '4'},
        'skills': [
          {'id': skill, 'title': 'Adding fractions', 'subject': 'Math', 'state': 'current', 'mastery': '42.5', 'standard_code': '4.NF.3', 'mastery_basis': 'standard'},
          {'id': 'x2', 'title': 'Place value', 'subject': 'Math', 'state': 'mastered', 'mastery': 91, 'mastery_basis': 'practice_estimate'},
        ],
        'activeSessionId': active,
      },
    };

class FakeServer {
  FakeServer(this.routes);
  final Map<String, Handler> routes;
  final List<http.Request> requests = [];

  List<http.Request> sent(String method, String path) => requests.where((r) => r.method == method && r.url.path == path).toList();

  http.Client client() => MockClient((r) async {
        requests.add(r);
        final key = '${r.method} ${r.url.path}';
        final common = <String, Handler>{
          'GET /api/me': (_) => {'userId': 'u-a', 'displayName': 'Ada Lovelace', 'role': 'pupil', 'districtId': 'd1', 'schoolId': 's1'},
          'GET /api/branding/current': (_) => {'data': {'school': {'name': 'Maple Elementary'}, 'branding': {}}},
          'GET /api/safety/status': (_) => {'data': {'incidents': [], 'canInitiate': false, 'canLead': false}},
          'GET /api/notifications': (_) => {'data': {'unread': 0, 'items': []}},
          'GET /api/christie/path': (_) => pathJson(),
          'GET /api/learning/courses': (_) => {'data': {'courses': [
            {'id': course, 'title': 'Grade 4 Math', 'teacher_name': 'Ms. Rivera', 'term': 'Fall', 'grade': {'letter': 'B', 'percent': '86.5'},
             'mastery': {'mastered': 2, 'total': 5, 'average': 61}, 'next': {'id': quiz, 'title': 'Fractions quiz', 'due_at': null}},
          ]}},
          'GET /api/transport/today': (_) => {'data': {'riders': [
            {'id': 's-ada', 'display_name': 'Ada Lovelace', 'direction': 'am', 'status': 'boarded', 'route_name': 'Route 7', 'bus_label': '12', 'stop_name': 'Oak & 3rd', 'stop_time': '07:42'},
          ]}},
          'GET /api/comms/announcements': (_) => {'data': [
            {'id': 'n1', 'title': 'Picture day', 'body': 'Friday, wear a smile.', 'scope': 'school', 'author_name': 'Pat Principal', 'created_at': DateTime.now().toIso8601String()},
          ]},
          'GET /api/home': (_) => {'data': {'youngLearner': false}},
        };
        final handler = routes[key] ?? common[key];
        final body = handler?.call(r);
        if (body == null) return http.Response('{"error":"not_found"}', 404);
        if (body is http.Response) return body;
        return http.Response(jsonEncode(body), r.method == 'POST' ? 201 : 200);
      });
}

Future<AppController> launch(WidgetTester tester, FakeServer fake) async {
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

Map<String, Object?> attemptJson({required String status, String r1 = '', String r2 = ''}) => {
      'data': {
        'id': attempt, 'title': 'Fractions quiz', 'attemptNo': 1, 'maxAttempts': 2, 'attemptsUsed': 1, 'status': status,
        'deadlineAt': null, 'secondsLeft': status == 'in_progress' ? 600 : null, 'extraTimePct': 25, 'late': false,
        'totalPoints': status == 'in_progress' ? null : '2', 'possiblePoints': '2', 'autoPoints': '2', 'canRetake': status != 'in_progress', 'answersShown': false,
        'items': [
          {'id': q1, 'seq': 1, 'kind': 'mc', 'prompt': '1/4 + 2/4 = ?', 'choices': ['3/8', '3/4', '1/2'], 'points': 1, 'response': r1,
           if (status != 'in_progress') 'earned': 1},
          {'id': q2, 'seq': 2, 'kind': 'numeric', 'prompt': 'What is 1/2 of 10?', 'choices': null, 'points': 1, 'response': r2,
           if (status != 'in_progress') 'earned': 1},
        ],
      },
    };

void main() {
  testWidgets('learner home shows what to practise, courses, the bus and school news', (tester) async {
    await launch(tester, FakeServer({}));
    expect(find.text('Adding fractions'), findsOneWidget);
    expect(find.text('1 of 2 skills mastered'), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is Semantics && w.properties.label == 'Adding fractions: 43% mastery'), findsOneWidget);
    expect(find.text('Next: Fractions quiz'), findsOneWidget);
    expect(find.text('Route 7 · Bus 12'), findsOneWidget);
    expect(find.text('Picture day'), findsOneWidget);
    expect(find.byType(NavigationBar), findsOneWidget);
    for (final t in ['Home', 'My library', 'Courses', 'Christie', 'More']) {
      expect(find.descendant(of: find.byType(NavigationBar), matching: find.text(t)), findsOneWidget, reason: t);
    }
  });

  testWidgets('practising with Christie: start, answer, ask, and finish', (tester) async {
    final fake = FakeServer({
      'POST /api/christie/sessions': (_) => {'data': {'session': {'id': session}, 'resumed': false}},
      'GET /api/christie/sessions/$session': (_) => {'data': {'id': session, 'skill': {'title': 'Adding fractions'}, 'mastery': 42,
        'turns': [{'speaker': 'christie', 'kind': 'item', 'text': 'What is 1/4 + 1/4?'}]}},
      'POST /api/christie/sessions/$session/turns': (r) {
        final kind = (jsonDecode(r.body) as Map)['kind'];
        return kind == 'attempt'
            ? {'data': {'replies': [{'speaker': 'christie', 'kind': 'feedback', 'text': 'Yes! 2/4 is the same as 1/2.'}], 'mastery': {'mastery': 55, 'mastered': false}}}
            : {'data': {'replies': [{'speaker': 'christie', 'kind': 'hint', 'hintLevel': 1, 'text': 'Add the tops, keep the bottom.'}]}};
      },
      'POST /api/christie/sessions/$session/end': (_) => {'data': {'ended': true}},
    });
    await launch(tester, fake);
    await tester.tap(find.text('Practice with Christie'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/christie/sessions').single.body), {'skillId': skill});
    expect(find.text('What is 1/4 + 1/4?'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'Your answer or question'), '2/4');
    await tester.tap(find.text('Check answer'));
    await tester.pumpAndSettle();
    expect(find.text('2/4'), findsOneWidget);
    expect(find.text('Yes! 2/4 is the same as 1/2.'), findsOneWidget);
    expect(find.text('Mastery: 55%'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'Your answer or question'), 'how do I add them?');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/christie/sessions/$session/turns').last.body), {'kind': 'question', 'text': 'how do I add them?'});
    expect(find.text('Hint 1'), findsOneWidget);

    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/christie/sessions/$session/end'), hasLength(1));
    expect(find.text('Practice with Christie'), findsOneWidget, reason: 'back on Home');
  });

  testWidgets('taking a quiz saves answers as you go, then submits and shows the score', (tester) async {
    var submitted = false;
    final fake = FakeServer({
      'GET /api/learning/courses/$course': (_) => {'data': {
        'id': course, 'title': 'Grade 4 Math', 'subject': 'Math', 'gradeLevel': '4', 'term': 'Fall', 'teacher': 'Ms. Rivera',
        'grade': {'letter': 'B', 'percent': 86.5}, 'mastery': {'mastered': 2, 'total': 5, 'average': 61},
        'standards': [{'id': 'st1', 'code': '4.NF.3', 'description': 'Add fractions with like denominators', 'level': 'developing', 'mastery': 64}],
        'units': [{'seq': 1, 'title': 'Fractions', 'lessons': [{'id': 'l1', 'title': 'Like denominators', 'standards': ['4.NF.3'], 'sources': 0}]}],
        'assignments': [{'id': quiz, 'title': 'Fractions quiz', 'kind': 'quiz', 'points': 2, 'time_limit_minutes': 10, 'mine': null}]}},
      'GET /api/learning/assignments/$quiz': (_) => {'data': {
        'id': quiz, 'title': 'Fractions quiz', 'kind': 'quiz', 'points': 2, 'status': 'published', 'maxAttempts': 2, 'retakePolicy': 'highest',
        'timeLimitMinutes': 10, 'effectiveMinutes': 13, 'itemCount': 2, 'standards': [{'code': '4.NF.3'}],
        'accommodations': {'extraTimePct': 25, 'readAloud': false}, 'attempts': submitted ? [{'id': attempt, 'attempt_no': 1, 'status': 'scored', 'total': 2, 'possible': 2}] : []}},
      'POST /api/learning/quizzes/$quiz/attempts': (_) => {'data': {'attempt': {'id': attempt}, 'resumed': false}},
      'GET /api/learning/attempts/$attempt': (_) => attemptJson(status: submitted ? 'scored' : 'in_progress', r1: submitted ? '1' : '', r2: submitted ? '5' : ''),
      'PUT /api/learning/attempts/$attempt/responses/$q1': (_) => {'data': {'saved': true}},
      'PUT /api/learning/attempts/$attempt/responses/$q2': (_) => {'data': {'saved': true}},
      'POST /api/learning/attempts/$attempt/submit': (_) {
        submitted = true;
        return {'data': {'attempt': {}}};
      },
    });
    await launch(tester, fake);
    await tester.tap(find.text('Courses').last);
    await tester.pumpAndSettle();
    expect(find.text('2 of 5 standards mastered'), findsOneWidget);
    await tester.tap(find.text('Open course'));
    await tester.pumpAndSettle();
    expect(find.text('Grade so far: B · 86.5% · 2 of 5 standards mastered'), findsOneWidget);
    expect(find.text('Developing 64%'), findsOneWidget);
    await tester.tap(find.text('Fractions quiz'));
    await tester.pumpAndSettle();
    expect(find.text('• 13 minutes (includes your +25% extra time)'), findsOneWidget);
    await tester.tap(find.text('Start quiz'));
    await tester.pumpAndSettle();
    expect(find.textContaining(RegExp(r'^⏱ (10:00|9:5\d) left \(\+25% time\)$')), findsOneWidget);

    await tester.tap(find.text('3/4'));
    await tester.pump();
    expect(jsonDecode(fake.sent('PUT', '/api/learning/attempts/$attempt/responses/$q1').single.body), {'response': '1'});
    final put = fake.sent('PUT', '/api/learning/attempts/$attempt/responses/$q1').single;
    expect(put.headers['x-csrf-token'], 'csrf');

    await tester.enterText(find.widgetWithText(TextField, 'Your answer (a number or fraction)'), ' 5 ');
    await tester.tap(find.text('Submit quiz'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('PUT', '/api/learning/attempts/$attempt/responses/$q2').single.body), {'response': '5'});
    expect(find.text('Submit your quiz?'), findsOneWidget);
    await tester.tap(find.text('Submit').last);
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/learning/attempts/$attempt/submit'), hasLength(1));
    expect(find.text('Score: 2 / 2'), findsOneWidget);
    expect(find.text('Submit quiz'), findsNothing);
    await tester.tap(find.text('Retake (1 left)'));
    await tester.pumpAndSettle();
    expect(find.text('Retake (1 left)'), findsOneWidget, reason: 'back on the quiz page, which now offers a retake');
    expect(find.text('Attempt 1'), findsOneWidget);
  });

  testWidgets('quiz answers are never queued offline: a failed save says so', (tester) async {
    final fake = FakeServer({
      'GET /api/learning/attempts/$attempt': (_) => attemptJson(status: 'in_progress'),
      'PUT /api/learning/attempts/$attempt/responses/$q1': (_) => throw http.ClientException('network down'),
    });
    final app = await launch(tester, fake);
    // ignore: unawaited_futures
    tester.state<NavigatorState>(find.byType(Navigator).first).push(MaterialPageRoute<void>(builder: (_) => const AttemptScreen(attemptId: attempt)));
    await tester.pumpAndSettle();
    await tester.tap(find.text('3/4'));
    await tester.pumpAndSettle();
    expect(find.textContaining('that answer isn\'t saved yet'), findsOneWidget);
    expect(app.queued, 0);
  });

  testWidgets('my path lists skills by subject; my library lists my loans', (tester) async {
    final fake = FakeServer({
      'GET /api/library/my-loans': (_) => {'data': [{'title': 'Charlotte\'s Web', 'due_at': DateTime.now().add(const Duration(days: 5)).toIso8601String(), 'overdue': false}]},
    });
    await launch(tester, fake);
    await tester.tap(find.text('More'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('My path'));
    await tester.pumpAndSettle();
    expect(find.text('Math'), findsOneWidget);
    expect(find.text('4.NF.3 · standard mastery'), findsOneWidget);
    expect(find.text('Practice again'), findsOneWidget);
    await tester.tap(find.text('My library'));
    await tester.pumpAndSettle();
    expect(find.text('Charlotte\'s Web'), findsOneWidget);
    expect(fake.sent('GET', '/api/library/my-loans'), hasLength(1));
  });
}


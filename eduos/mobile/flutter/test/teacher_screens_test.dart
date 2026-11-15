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
const course = 'ffffffff-0000-4000-8000-000000000001';
const attempt = 'ffffffff-0000-4000-8000-000000000002';
const essay = 'ffffffff-0000-4000-8000-000000000003';
const ada = 'ffffffff-0000-4000-8000-000000000004';
const q1 = 'ffffffff-0000-4000-8000-0000000000a1';
const q2 = 'ffffffff-0000-4000-8000-0000000000a2';
const session = 'ffffffff-0000-4000-8000-000000000005';

typedef Handler = Object? Function(http.Request r);
final now = DateTime.now().toIso8601String();

class FakeServer {
  FakeServer(this.routes, {this.role = 'teacher'});
  final Map<String, Handler> routes;
  final String role;
  final List<http.Request> requests = [];

  List<http.Request> sent(String method, String path) => requests.where((r) => r.method == method && r.url.path == path).toList();

  http.Client client() => MockClient((r) async {
        requests.add(r);
        final key = '${r.method} ${r.url.path}';
        final common = <String, Handler>{
          'GET /api/me': (_) => {'userId': 'u-t', 'displayName': 'Ms. Rivera', 'role': role, 'districtId': 'd1', 'schoolId': 's1'},
          'GET /api/branding/current': (_) => {'data': {'school': {'name': 'Maple Elementary'}, 'branding': {}}},
          'GET /api/safety/status': (_) => {'data': {'incidents': [], 'canInitiate': false, 'canLead': false}},
          'GET /api/notifications': (_) => {'data': {'unread': 0, 'items': []}},
          'GET /api/rosters': (_) => {'data': []},
          'GET /api/attendance': (_) => {'data': []},
          'GET /api/learning/courses': (_) => {'data': {'courses': [
            {'id': course, 'title': 'Grade 4 Math', 'term': 'Fall', 'students': 2, 'lessons': 6, 'teacher_name': 'Ms. Rivera', 'to_review': 1, 'to_grade': 0},
          ]}},
          'GET /api/learning/courses/$course/gradebook': (_) => {'data': {
            'course': {'id': course, 'title': 'Grade 4 Math', 'term': 'Fall', 'gradeWeights': {'quiz': 40, 'work': 60}},
            'assignments': [
              {'id': 'qz', 'title': 'Quiz: Fractions', 'points': 2, 'has_rubric': false},
              {'id': essay, 'title': 'Explain your thinking', 'points': 8, 'has_rubric': true, 'due_at': null},
            ],
            'students': [
              {'id': ada, 'name': 'Ada Lovelace', 'grade': {'letter': 'B', 'percent': 86.5}, 'missing': 0, 'final': null,
               'cells': [{'earned': 2, 'status': 'graded'}, {'earned': null, 'status': 'submitted'}]},
              {'id': 'ben', 'name': 'Ben Ortiz', 'grade': {'letter': null, 'percent': null}, 'missing': 1, 'final': null,
               'cells': [{'earned': null, 'missing': true, 'status': 'not_started'}, {'earned': 6, 'status': 'graded'}]},
            ]}},
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
  testWidgets('grading: review a quiz\'s open answer, grade with a rubric, and score a hand-in', (tester) async {
    final fake = FakeServer({
      'GET /api/assignments': (_) => {'data': [{'id': 'hw1', 'title': 'Reading log', 'status': 'published', 'submission_count': 1}]},
      'GET /api/assignments/hw1/submissions': (_) => {'data': [{'id': 'sub1', 'display_name': 'Cy Ramos', 'score': null, 'response_text': 'I read 20 pages.', 'submitted_at': now}]},
      'POST /api/assignments/hw1/submissions/sub1/grade': (_) => {'data': {'ok': true}},
      'GET /api/learning/review': (_) => {'data': {'attempts': [
        {'id': attempt, 'display_name': 'Ada Lovelace', 'title': 'Quiz: Fractions', 'course': 'Grade 4 Math', 'attempt_no': 1, 'submitted_at': now, 'late': false, 'status': 'needs_review'}]}},
      'GET /api/learning/attempts/$attempt': (_) => {'data': {'id': attempt, 'title': 'Quiz: Fractions', 'attemptNo': 1, 'maxAttempts': 2, 'attemptsUsed': 1, 'status': 'needs_review', 'extraTimePct': 25,
        'items': [
          {'id': q1, 'seq': 1, 'kind': 'mc', 'prompt': '1/4 + 2/4 = ?', 'choices': ['3/8', '3/4'], 'response': '1', 'points': 1, 'earned': 1, 'autoCorrect': true, 'answerKey': {'index': 1}},
          {'id': q2, 'seq': 2, 'kind': 'short', 'prompt': 'Explain why.', 'choices': null, 'response': 'Same bottoms, add tops.', 'points': 2, 'earned': null, 'autoCorrect': null, 'answerKey': {'accepted': []}},
        ]}},
      'POST /api/learning/attempts/$attempt/review': (_) => {'data': {'ok': true}},
      'GET /api/learning/assignments/$essay': (_) => {'data': {'id': essay, 'title': 'Explain your thinking', 'kind': 'work', 'points': 8, 'canManage': true,
        'rubric': [
          {'id': 'c1', 'title': 'Reasoning', 'levels': [{'points': 4, 'label': 'Clear'}, {'points': 2, 'label': 'Partly'}]},
          {'id': 'c2', 'title': 'Accuracy', 'levels': [{'points': 4, 'label': 'Correct'}, {'points': 0, 'label': 'Not yet'}]},
        ],
        'submissions': [{'student_id': ada, 'response_text': 'Because the pieces are the same size.'}]}},
      'POST /api/learning/assignments/$essay/grade': (_) => {'data': {'earned': 6, 'possible': 8}},
    });
    await launch(tester, fake);
    await openTab(tester, 'Grading');
    expect(find.text('1 quiz to review · 1 rubric task · 1 hand-in to grade · 0 graded'), findsOneWidget);

    await tester.tap(find.text('Review'));
    await tester.pumpAndSettle();
    expect(find.text('Attempt 1 · had +25% time'), findsOneWidget);
    expect(find.text('Auto-scored: 1/1'), findsOneWidget);
    expect(find.text('Key: (teacher judgement)'), findsOneWidget);
    await tester.tap(find.text('Return to learner'));
    await tester.pump();
    expect(fake.sent('POST', '/api/learning/attempts/$attempt/review'), isEmpty, reason: 'open answers need points first');
    await tester.enterText(find.widgetWithText(TextField, 'Points for question 2 (0–2)'), '1.5');
    await tester.enterText(find.widgetWithText(TextField, 'Comment on question 2 (optional)'), 'Say what the bottoms are called.');
    await tester.tap(find.text('Return to learner'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/learning/attempts/$attempt/review').single.body), {
      'scores': [{'itemId': q2, 'points': 1.5, 'comment': 'Say what the bottoms are called.'}]
    });

    await tester.tap(find.text('Grade'));
    await tester.pumpAndSettle();
    expect(find.text('Because the pieces are the same size.'), findsOneWidget);
    await tester.tap(find.text('4 · Clear'));
    await tester.tap(find.text('Return with rubric'));
    await tester.pump();
    expect(fake.sent('POST', '/api/learning/assignments/$essay/grade'), isEmpty, reason: 'every row needs a level');
    await tester.tap(find.text('0 · Not yet'));
    await tester.enterText(find.widgetWithText(TextField, 'Feedback for the learner and family'), 'Good start.');
    await tester.tap(find.text('Return with rubric'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/learning/assignments/$essay/grade').single.body), {
      'studentId': ada,
      'scores': [{'criterionId': 'c1', 'points': 4}, {'criterionId': 'c2', 'points': 0}],
      'feedback': 'Good start.',
    });

    await tester.enterText(find.widgetWithText(TextField, 'Score for Cy (0–100)'), '120');
    await tester.tap(find.text('Save grade'));
    await tester.pump();
    expect(fake.sent('POST', '/api/assignments/hw1/submissions/sub1/grade'), isEmpty);
    await tester.enterText(find.widgetWithText(TextField, 'Score for Cy (0–100)'), '90');
    await tester.tap(find.text('Save grade'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/assignments/hw1/submissions/sub1/grade').single.body), {'score': 90, 'feedback': ''});
  });

  testWidgets('courses: the gradebook shows each learner\'s work and posts a final grade', (tester) async {
    final fake = FakeServer({'POST /api/learning/courses/$course/final-grades': (_) => {'data': {'id': 'fg1'}}});
    await launch(tester, fake);
    await openTab(tester, 'Courses');
    expect(find.text('Fall · 2 learners · 6 lessons'), findsOneWidget);
    expect(find.text('1 quiz to review'), findsOneWidget);
    await tester.tap(find.text('Gradebook'));
    await tester.pumpAndSettle();
    expect(find.text('B · 86.5%'), findsOneWidget);
    expect(find.text('No graded work yet · 1 missing'), findsOneWidget);
    await tester.tap(find.text('Ada Lovelace'));
    await tester.pumpAndSettle();
    expect(find.text('2/2'), findsOneWidget);
    expect(find.text('handed in'), findsOneWidget);
    await tester.tap(find.text('Post final grade'));
    await tester.pumpAndSettle();
    expect(find.text('B (86.5%) will be recorded on the records ledger.'), findsOneWidget);
    await tester.tap(find.text('Post'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/learning/courses/$course/final-grades').single.body), {'studentId': ada});
  });

  testWidgets('Christie copilot: read a flagged conversation and mark it reviewed', (tester) async {
    final fake = FakeServer({
      'GET /api/christie/copilot': (_) => {'data': {'suggestions': ['Reteach like denominators to 3 learners.'], 'note': 'Suggestions come from practice data only.',
        'bySkill': [{'title': 'Adding fractions', 'learners': 20, 'mastered': 8, 'avg_mastery': 61}]}},
      'GET /api/christie/review': (_) => {'data': [
        {'id': session, 'student_id': ada, 'student_name': 'Ada Lovelace', 'skill_title': 'Adding fractions', 'solved': 3, 'hints': 2, 'needs_adult': true, 'reviewed_at': null, 'last_activity_at': now, 'mastery': 55}]},
      'GET /api/christie/sessions/$session': (_) => {'data': {'id': session, 'studentName': 'Ada Lovelace', 'skill': {'title': 'Adding fractions'}, 'mastery': 55, 'reviewedAt': null,
        'turns': [{'speaker': 'student', 'kind': 'question', 'text': 'Can I talk to my teacher?', 'at': now}]}},
      'POST /api/christie/sessions/$session/review': (_) => {'data': {'ok': true}},
    });
    await launch(tester, fake);
    await openTab(tester, 'Christie');
    expect(find.text('• Reteach like denominators to 3 learners.'), findsOneWidget);
    expect(find.text('8/20 mastered'), findsOneWidget);
    expect(find.text('Asked for an adult'), findsOneWidget);
    await tester.tap(find.text('Ada Lovelace · Adding fractions'));
    await tester.pumpAndSettle();
    expect(find.text('Can I talk to my teacher?'), findsOneWidget);
    await tester.tap(find.text('Mark reviewed'));
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/christie/sessions/$session/review'), hasLength(1));
    expect(find.text('Class mastery by skill'), findsOneWidget, reason: 'back on the copilot tab');
  });

  group('Staffing', () {
    Map<String, Object?> data() => {'data': {
      'absences': [{'id': 'ab1', 'display_name': 'Mr. Lee', 'starts_at': now, 'ends_at': now, 'reason_category': 'professional_development', 'status': 'pending', 'created_at': now}],
      'coverage': [{'id': 'cv1', 'role_needed': 'Substitute teacher', 'department': 'instruction', 'starts_at': now, 'ends_at': now, 'status': 'requested'}],
      'shifts': [], 'staffing': []}};

    testWidgets('staff request time away; they cannot approve', (tester) async {
      final fake = FakeServer({
        'GET /api/staff-management': (_) => data(),
        'POST /api/staff-management/absences': (_) => {'data': {'id': 'ab2'}},
      });
      await launch(tester, fake);
      await openTab(tester, 'Staffing');
      expect(find.text('My absence requests'), findsOneWidget);
      expect(find.text('Approve'), findsNothing);
      expect(find.text('Request substitute coverage'), findsNothing);
      await tester.tap(find.text('Submit absence'));
      await tester.pumpAndSettle();
      final body = jsonDecode(fake.sent('POST', '/api/staff-management/absences').single.body) as Map;
      expect(body['reasonCategory'], 'personal');
      final from = DateTime.parse(body['startsAt'] as String).toLocal(), to = DateTime.parse(body['endsAt'] as String).toLocal();
      expect((from.hour, from.minute, to.hour, to.minute), (0, 0, 23, 59));
      expect(DateUtils.isSameDay(from, DateTime.now()), isTrue);
      expect(find.text('Absence request submitted.'), findsOneWidget);
    });

    testWidgets('leaders approve absences and coverage', (tester) async {
      final fake = FakeServer({
        'GET /api/staff-management': (_) => data(),
        'GET /api/operations/specialized': (_) => {'data': {}},
        'POST /api/staff-management/absences/ab1/review': (_) => {'data': {'ok': true}},
        'POST /api/staff-management/coverage/cv1/decision': (_) => {'data': {'ok': true}},
      }, role: 'vice_principal');
      await launch(tester, fake);
      await openTab(tester, 'Staffing');
      expect(find.textContaining('Mr. Lee · professional development'), findsOneWidget);
      await tester.tap(find.text('Approve'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.sent('POST', '/api/staff-management/absences/ab1/review').single.body), {'decision': 'approved'});
      await tester.tap(find.text('Approve coverage'));
      await tester.pumpAndSettle();
      expect(jsonDecode(fake.sent('POST', '/api/staff-management/coverage/cv1/decision').single.body), {'decision': 'approved'});
    });
  });
}

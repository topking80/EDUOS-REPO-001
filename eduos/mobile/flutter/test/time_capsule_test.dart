// 37.8 Time Capsules in the app: the hub, making and managing a capsule,
// the history timeline, family memories and teachers' items, storage,
// leaders' milestone releases and review, photos that never carry the
// session token to the storage host, and the tablet/desktop layout.
import 'dart:convert';

import 'package:eduos_mobile_branding/core/api_client.dart';
import 'package:eduos_mobile_branding/core/history_models.dart';
import 'package:eduos_mobile_branding/core/offline_queue.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'operations_screens_test.dart' show FakeServer, launch, openTab;

final future = DateTime.now().add(const Duration(days: 400)).toUtc().toIso8601String();

Map<String, Object?> capsuleJson({String id = 'c1', String status = 'draft', bool mine = true, String title = 'For Ava at 18'}) => {
      'id': id, 'studentId': 'k1', 'studentName': 'Ava Lee', 'title': title, 'message': 'We are so proud of you.', 'status': status,
      'releaseKind': 'milestone', 'releaseAt': null, 'milestone': 'age_18', 'mine': mine, 'createdAt': DateTime.now().toIso8601String(),
    };

final home = {'data': {'children': [{'id': 'k1', 'display_name': 'Ava Lee', 'grade_level': '4', 'school_name': 'Maple Elementary'}]}};

Future<void> openCapsules(WidgetTester tester) => openTab(tester, 'Time Capsules');

void main() {
  testWidgets('family: invitations, my capsules and each child\'s history; accepting sends the answer', (tester) async {
    final fake = FakeServer({
      'GET /api/home': (_) => home,
      'GET /api/history/capsules': (_) => {'data': [capsuleJson(), capsuleJson(id: 'c2', status: 'released', mine: false, title: 'From Grandma')]},
      'GET /api/history/capsule-invitations': (_) => {
            'data': [{'capsuleId': 'c9', 'studentId': 'k1', 'studentName': 'Ava Lee', 'from': 'Sam Lee', 'status': 'scheduled', 'releaseKind': 'scheduled', 'releaseAt': future, 'consent': 'pending'}]
          },
      'GET /api/family/history-transfers': (_) => {'data': []},
      'POST /api/history/capsule-invitations/c9': (_) => {'data': {'capsuleId': 'c9', 'consent': 'approved'}},
    }, role: 'parent');
    await launch(tester, fake);
    await openCapsules(tester);
    expect(find.text('Capsules for you'), findsOneWidget);
    expect(find.text('From Sam Lee'), findsOneWidget);
    expect(find.text('For Ava at 18'), findsOneWidget);
    expect(find.text('Opened for you'), findsOneWidget);
    expect(find.text('From Grandma'), findsOneWidget);
    expect(find.text('Ava Lee\'s history'), findsOneWidget);
    expect(find.text('Family memories'), findsOneWidget);
    await tester.tap(find.text('Accept'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/history/capsule-invitations/c9').single.body), {'decision': 'approved'});
  });

  testWidgets('family: a new milestone capsule is saved as a draft for the chosen child', (tester) async {
    final fake = FakeServer({
      'GET /api/home': (_) => home,
      'GET /api/history/capsules': (_) => {'data': []},
      'GET /api/history/capsule-invitations': (_) => {'data': []},
      'GET /api/family/history-transfers': (_) => {'data': []},
      'POST /api/history/capsules': (_) => {'data': {'id': 'c5', 'status': 'draft'}},
      'GET /api/history/capsules/c5': (_) => {'data': {...capsuleJson(id: 'c5', title: 'Graduation letter'), 'items': [], 'photos': [], 'recipients': [], 'events': []}},
    }, role: 'parent');
    await launch(tester, fake);
    await openCapsules(tester);
    await tester.tap(find.text('New Time Capsule'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextFormField, 'Title'), 'Graduation letter');
    await tester.tap(find.text('At a milestone'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save draft'));
    await tester.pumpAndSettle();
    final body = jsonDecode(fake.sent('POST', '/api/history/capsules').single.body) as Map;
    expect(body['studentId'], 'k1');
    expect(body['title'], 'Graduation letter');
    expect(body['releaseKind'], 'milestone');
    expect(body['milestone'], 'grade_5_completion');
    expect(body.containsKey('releaseAt'), isFalse);
  });

  testWidgets('owner: a draft shows what\'s inside and who receives it, and can be sealed', (tester) async {
    final fake = FakeServer({
      'GET /api/home': (_) => home,
      'GET /api/history/capsules': (_) => {'data': [capsuleJson()]},
      'GET /api/history/capsule-invitations': (_) => {'data': []},
      'GET /api/family/history-transfers': (_) => {'data': []},
      'GET /api/history/capsules/c1': (_) => {
            'data': {
              ...capsuleJson(),
              'items': [
                {'position': 0, 'entryId': 'e1', 'withheld': false, 'entryType': 'achievement', 'kind': 'official_record', 'title': 'Spelling bee winner', 'body': 'First place.', 'occurredAt': '2026-03-02T15:00:00Z', 'photos': []},
                {'position': 1, 'entryId': 'e2', 'withheld': true},
              ],
              'photos': [],
              'recipients': [{'userId': 'u7', 'name': 'Ava Lee', 'type': 'student', 'consent': 'approved'}],
              'events': [{'type': 'created', 'outcome': 'success', 'reason': null, 'at': '2026-11-01T12:00:00Z'}],
            }
          },
      'POST /api/history/capsules/c1/seal': (_) => {'data': {'id': 'c1', 'status': 'sealed'}},
    }, role: 'parent');
    await launch(tester, fake);
    await openCapsules(tester);
    await tester.tap(find.text('For Ava at 18'));
    await tester.pumpAndSettle();
    expect(find.text('Spelling bee winner'), findsOneWidget);
    expect(find.text('An item here isn\'t shared with you.'), findsOneWidget);
    expect(find.text('Accepted'), findsOneWidget);
    expect(find.text('Add history item'), findsOneWidget);
    expect(find.text('Add recipient'), findsOneWidget);
    await tester.tap(find.text('Seal'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Seal').last);
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/history/capsules/c1/seal'), hasLength(1));
  });

  testWidgets('learner: "My history" groups items by school year; filters and paging ask the server', (tester) async {
    Map<String, Object?> item(String id, String title, String year) => {
          'id': id, 'entryType': 'project', 'kind': 'student_portfolio', 'title': title, 'body': '', 'occurredAt': '2025-10-01T12:00:00Z', 'schoolYear': year, 'photos': [],
        };
    final fake = FakeServer({
      'GET /api/history/portfolio': (r) => {
            'data': {
              'student': {'id': 'k1', 'name': 'Ava Lee'},
              'items': r.url.queryParameters['cursor'] == 'p2'
                  ? [item('e3', 'Science fair volcano', '2024-25')]
                  : r.url.queryParameters['year'] == '2024-25'
                      ? [item('e2', 'Book report', '2024-25')]
                      : [item('e1', 'Robotics club build', '2025-26'), item('e2', 'Book report', '2024-25')],
              'nextCursor': r.url.queryParameters.containsKey('cursor') || r.url.queryParameters.containsKey('year') ? null : 'p2',
              'facets': {'years': ['2025-26', '2024-25'], 'types': ['project'], 'kinds': ['student_portfolio'], 'total': 3},
            }
          },
    }, role: 'pupil');
    await launch(tester, fake);
    await openTab(tester, 'My history');
    expect(find.text('2025-26'), findsWidgets);
    expect(find.text('Robotics club build'), findsOneWidget);
    expect(find.text('Book report'), findsOneWidget);
    await tester.tap(find.text('Show more'));
    await tester.pumpAndSettle();
    expect(find.text('Science fair volcano'), findsOneWidget);
    expect(fake.sent('GET', '/api/history/portfolio').last.url.queryParameters['cursor'], 'p2');
    await tester.tap(find.text('Robotics club build'));
    await tester.pumpAndSettle();
    expect(find.text('My work'), findsOneWidget, reason: 'the item page shows its kind');
  });

  testWidgets('teacher: a history item for a student on the roster goes to the school', (tester) async {
    final fake = FakeServer({
      'GET /api/rosters': (_) => {'data': [{'student_id': 'k1', 'student_name': 'Ava Lee'}, {'student_id': 'k2', 'student_name': 'Ben Ortiz'}]},
      'GET /api/teacher/history-items': (_) => {
            'data': [
              {'id': 'h1', 'studentId': 'k2', 'studentName': 'Ben Ortiz', 'entryType': 'project', 'title': 'Bridge model', 'body': '', 'occurredAt': '2026-10-02T12:00:00Z', 'status': 'draft',
                'decisions': [{'decision': 'changes_requested', 'reasonCode': 'needs_edits', 'note': 'Add the date', 'by': 'school', 'at': '2026-10-03T12:00:00Z'}]},
            ]
          },
      'POST /api/students/k1/history/teacher-items': (_) => {'data': {'id': 'h2', 'status': 'submitted'}},
    }, role: 'teacher');
    await launch(tester, fake);
    await openTab(tester, 'History items');
    expect(find.text('Bridge model'), findsOneWidget);
    expect(find.text('Changes requested · Needs edits · “Add the date”'), findsOneWidget);
    expect(find.text('Fix and resubmit'), findsOneWidget);
    await tester.tap(find.byType(DropdownButtonFormField<String>).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Ava Lee').last);
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, 'What did the student do?'), 'Led the class garden');
    await tester.tap(find.text('Send to the school'));
    await tester.pumpAndSettle();
    final body = jsonDecode(fake.sent('POST', '/api/students/k1/history/teacher-items').single.body) as Map;
    expect(body['title'], 'Led the class garden');
    expect(body['entryType'], 'project');
    expect(DateTime.tryParse(body['occurredAt'] as String), isNotNull);
  });

  testWidgets('principal: confirms a milestone release and reviews teachers\' items', (tester) async {
    final fake = FakeServer({
      'GET /api/history/capsules': (_) => {'data': []},
      'GET /api/history/capsule-invitations': (_) => {'data': []},
      'GET /api/history/capsule-milestones': (_) => {
            'data': [{'capsuleId': 'c3', 'studentId': 'k1', 'studentName': 'Ava Lee', 'from': 'Sam Lee', 'milestone': 'grade_5_completion', 'sealedAt': '2026-01-01T00:00:00Z', 'accepted': 2}]
          },
      'POST /api/history/capsules/c3/release': (_) => {'data': {'id': 'c3', 'status': 'released'}},
      'GET /api/history-review': (_) => {
            'data': [{'id': 'h1', 'studentId': 'k1', 'studentName': 'Ava Lee', 'entryType': 'achievement', 'title': 'Math olympiad', 'body': '', 'occurredAt': '2026-10-02T12:00:00Z', 'status': 'submitted', 'decisions': []}]
          },
      'POST /api/history-review/h1': (_) => {'data': {'id': 'h1', 'status': 'approved'}},
    }, role: 'principal');
    await launch(tester, fake);
    await openCapsules(tester);
    expect(find.text('Ava Lee: Finishing grade 5'), findsOneWidget);
    await tester.tap(find.text('Release'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Release').last);
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/history/capsules/c3/release'), hasLength(1));
    await tester.tap(find.text('Review teachers\' items'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Approve'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/history-review/h1').single.body), {'decision': 'approve'});
  });

  testWidgets('storage: explains usage and limits, and says so when the server doesn\'t have it yet', (tester) async {
    var available = false;
    final fake = FakeServer({
      'GET /api/home': (_) => home,
      'GET /api/history/capsules': (_) => {'data': []},
      'GET /api/history/capsule-invitations': (_) => {'data': []},
      'GET /api/family/history-transfers': (_) => {'data': []},
      'GET /api/history/storage': (_) => !available
          ? null
          : {
              'data': {
                'student': {'id': 'k1', 'name': 'Ava Lee'},
                'limits': {'photosAllowed': true, 'maxPhotoBytes': 10485760, 'maxPhotosPerItem': 6, 'maxBytesPerStudent': 262144000},
                'usage': {'usedBytes': 52428800, 'percent': 20, 'photos': 14, 'inLongTermStorage': 3, 'roomForAnotherPhoto': true},
                'items': {'inHistory': 21, 'waitingForReview': 2, 'drafts': 1},
                'myContributions': {'waiting': 1, 'accepted': 4, 'declined': 0, 'withdrawn': 0},
                'capsules': [{'id': 'c1', 'title': 'For Ava at 18', 'status': 'sealed', 'opens': {'milestone': 'age_18'}}],
                'retention': {'recordsScheduleRef': 'GS-7', 'text': 'Official school records are kept by the district under its records schedule.'},
                'export': {'allowed': true, 'href': '/api/history/export?studentId=k1'},
                'guidance': ['The limit is the same for every student and is set by the district.'],
                'donations': {'changeStorage': false, 'text': 'Donations never change this limit.'},
              }
            },
    }, role: 'parent');
    await launch(tester, fake);
    await openCapsules(tester);
    await tester.tap(find.text('Storage'));
    await tester.pumpAndSettle();
    expect(find.text('Storage details aren\'t available on this school server yet.'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    available = true;
    await tester.tap(find.text('Storage'));
    await tester.pumpAndSettle();
    expect(find.text('50.0 MB of 250 MB used (20%)'), findsOneWidget);
    expect(find.text('Records schedule: GS-7'), findsOneWidget);
    expect(find.text('Donations never change this limit.'), findsOneWidget);
    expect(fake.sent('GET', '/api/history/storage').last.url.queryParameters['studentId'], 'k1');
  });

  testWidgets('tablet and desktop: a side rail with every tab, and the capsule opens beside the list', (tester) async {
    final fake = FakeServer({
      'GET /api/home': (_) => home,
      'GET /api/history/capsules': (_) => {'data': [capsuleJson()]},
      'GET /api/history/capsule-invitations': (_) => {'data': []},
      'GET /api/family/history-transfers': (_) => {'data': []},
      'GET /api/history/capsules/c1': (_) => {'data': {...capsuleJson(), 'items': [], 'photos': [], 'recipients': [], 'events': []}},
    }, role: 'parent');
    await launch(tester, fake);
    tester.view.physicalSize = const Size(1280, 1000);
    await tester.pumpAndSettle();
    expect(find.byType(NavigationRail), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    await tester.tap(find.descendant(of: find.byType(NavigationRail), matching: find.text('Time Capsules')));
    await tester.pumpAndSettle();
    expect(find.text('Choose a capsule to see it here.'), findsOneWidget);
    await tester.tap(find.text('For Ava at 18'));
    await tester.pumpAndSettle();
    expect(find.text('Get it ready'), findsOneWidget);
    expect(find.byType(BackButton), findsNothing, reason: 'shown in the side pane, not pushed');
  });

  test('photos: the app asks EduOS where a photo is and never sends the session to the storage host', () async {
    final seen = <http.BaseRequest>[];
    final client = MockClient.streaming((request, _) async {
      seen.add(request);
      expect(request.followRedirects, isFalse);
      return http.StreamedResponse(const Stream.empty(), 302, headers: {'location': 'https://bucket.example.test/history/p1.webp?X-Amz-Signature=abc'});
    });
    final api = ApiClient(
      session: () => Session(serverUrl: Uri.parse('https://eduos.example.test'), token: 'tok', csrfToken: 'csrf', expiresAt: DateTime.now().add(const Duration(hours: 1))),
      queue: OfflineQueue(MemoryKeyValueStore()),
      httpClient: client,
    );
    final url = await api.location('/api/history/photos/p1');
    expect(url.toString(), 'https://bucket.example.test/history/p1.webp?X-Amz-Signature=abc');
    expect(seen.single.url.host, 'eduos.example.test');
    expect(seen.single.headers['authorization'], 'Bearer tok');
  });

  test('labels and sizes match the web app', () {
    expect(milestoneText['age_18'], 'Turning 18');
    expect(capsuleStatusText['scheduled'], 'Sealed');
    expect(historyKindText['family_memory'], 'Family memory');
    expect(fmtBytes(262144000), '250 MB');
    expect(fmtBytes(52428800), '50.0 MB');
    expect(fmtBytes(512), '512 B');
  });
}

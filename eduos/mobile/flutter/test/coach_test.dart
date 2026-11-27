// COACH-01: the native "My teams" screen for a coach profile.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:eduos_mobile_branding/ui/arbiter_links.dart';

import 'operations_screens_test.dart' show FakeServer, launch;

void main() {
  testWidgets('a coach sees their team: what\'s next, roster with eligibility and slip answers, and other schools', (tester) async {
    final fake = FakeServer({
      'GET /api/coach/teams': (_) => {
            'data': {
              'teams': [
                {
                  'id': 'a1', 'kind': 'sport', 'title': 'S2 Soccer', 'role': 'coach', 'meetingDetails': '', 'status': 'published',
                  'events': [{'id': 'e1', 'title': 'Home game', 'starts_at': DateTime.now().add(const Duration(days: 1)).toIso8601String(), 'venue': 'Field'}],
                  'results': [],
                  'slip': {'id': 's1', 'title': 'Away trip', 'granted': 1, 'declined': 0, 'pending': 1},
                  'roster': [
                    {'studentId': 'c1', 'name': 'Carol C', 'grade': '5', 'jersey': 9, 'eligibility': 'eligible', 'slip': 'granted'},
                    {'studentId': 'c2', 'name': 'Dan D', 'grade': '5', 'jersey': null, 'eligibility': 'not_enough_records', 'slip': 'pending'},
                  ],
                },
              ],
              'elsewhere': [{'membership_id': 'm9', 'school_id': 's9', 'school': 'Hill Primary'}],
            },
          },
    }, role: 'coach');
    await launch(tester, fake);
    expect(find.text('S2 Soccer'), findsOneWidget);
    expect(find.text('Home game'), findsOneWidget);
    expect(find.textContaining('Away trip'), findsOneWidget);
    expect(find.text('#9 Carol C'), findsOneWidget);
    expect(find.text('Dan D'), findsOneWidget);
    expect(find.text('Eligible'), findsOneWidget);
    expect(find.text('Not enough records'), findsOneWidget);
    expect(find.text('Slip signed'), findsOneWidget);
    expect(find.text('Slip waiting'), findsOneWidget);
    expect(find.text('Your teams at Hill Primary'), findsOneWidget);
    expect(find.text('Attendance: Home game'), findsOneWidget);
    expect(find.text('Physicals'), findsOneWidget);
  });

  testWidgets('a coach has the Arbiter links for scheduling and officials; they open in the browser', (tester) async {
    final opened = <Uri>[];
    ArbiterLinksCard.opener = (uri) async { opened.add(uri); return true; };
    addTearDown(() => ArbiterLinksCard.opener = (uri) async => false);
    final fake = FakeServer({
      'GET /api/coach/teams': (_) => {'data': {'teams': [{'id': 'a1', 'kind': 'sport', 'title': 'S2 Soccer', 'role': 'coach', 'events': [], 'results': [], 'roster': []}], 'elsewhere': []}},
    }, role: 'coach');
    await launch(tester, fake);
    await tester.scrollUntilVisible(find.text('Officials assigning'), 200);
    expect(find.text('Scheduling & officials'), findsOneWidget);
    expect(find.textContaining('doesn\'t send your schedules, rosters or student information'), findsOneWidget);
    for (final (label, _) in arbiterLinks) {
      await tester.tap(find.text(label));
      await tester.pump();
    }
    expect(opened.map((u) => u.toString()), ['https://arbiter.io/', 'https://arbiter.io/products/scheduling/', 'https://arbiter.io/products/assigningsoftware/']);
    expect(fake.requests.where((r) => r.url.host.contains('arbiter')), isEmpty, reason: 'nothing is sent to Arbiter');
  });

  testWidgets('no Arbiter links without a team', (tester) async {
    await launch(tester, FakeServer({'GET /api/coach/teams': (_) => {'data': {'teams': [], 'elsewhere': []}}}, role: 'coach'));
    expect(find.text('Scheduling & officials'), findsNothing);
  });

  testWidgets('a coach marks attendance and sees physical clearance status', (tester) async {
    final fake = FakeServer({
      'GET /api/coach/teams': (_) => {
            'data': {
              'teams': [
                {
                  'id': 'a1', 'kind': 'sport', 'title': 'S2 Soccer', 'role': 'coach',
                  'events': [{'id': 'e1', 'title': 'Home game', 'starts_at': DateTime.now().subtract(const Duration(hours: 1)).toIso8601String(), 'venue': 'Field'}],
                  'results': [],
                  'roster': [
                    {'studentId': 'c1', 'name': 'Carol C', 'grade': '5', 'jersey': 9, 'eligibility': 'eligible'},
                  ],
                },
              ],
              'elsewhere': [],
            },
          },
      'GET /api/events/e1/attendance': (_) => {
            'data': {
              'event': {'id': 'e1', 'title': 'Home game', 'activityId': 'a1', 'kind': 'sport'},
              'unmarked': 1,
              'counts': {'present': 0, 'late': 0, 'excused': 0, 'absent': 0},
              'students': [{'studentId': 'c1', 'name': 'Carol C', 'grade': '5', 'status': null}],
            },
          },
      'PUT /api/events/e1/attendance': (_) => {'data': {'eventId': 'e1', 'saved': 1, 'counts': {'present': 1, 'late': 0, 'excused': 0, 'absent': 0}}},
      'GET /api/activities/a1/physicals': (_) => {
            'data': {
              'activityId': 'a1',
              'summary': {'cleared': 0, 'expiring': 0, 'expired': 0, 'missing': 1},
              'students': [{'studentId': 'c1', 'name': 'Carol C', 'grade': '5', 'jersey': 9, 'status': 'missing', 'clearedOn': null, 'expiresOn': null}],
            },
          },
    }, role: 'coach');
    await launch(tester, fake);
    await tester.tap(find.text('Attendance: Home game'));
    await tester.pumpAndSettle();
    expect(find.text('Carol C'), findsOneWidget);
    expect(find.text('1 not marked yet'), findsOneWidget);
    await tester.tap(find.byKey(const Key('attendance-status-c1')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Present').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Save attendance'));
    await tester.pumpAndSettle();
    expect(fake.sent('PUT', '/api/events/e1/attendance'), hasLength(1));
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Physicals'));
    await tester.pumpAndSettle();
    expect(find.text('No physical on file'), findsOneWidget);
    expect(fake.sent('GET', '/api/activities/a1/physicals'), hasLength(1));
  });
}


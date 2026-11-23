// COACH-01: the native "My teams" screen for a coach profile.
import 'package:flutter_test/flutter_test.dart';

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
  });
}

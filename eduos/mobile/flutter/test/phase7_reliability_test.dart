// Phase 7 (review of Phase 6): every role's tabs open their real native
// screens; failed or offline submissions keep what staff typed; a double tap
// or double scan sends one request; the library scanner field is ready for
// the next scan; transport, school-node, IT admin and library-permission
// workflows, and recovery after a server error.
import 'dart:async';

import 'package:eduos_mobile_branding/app/role_tabs.dart';
import 'package:eduos_mobile_branding/ui/screens/alerts_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/arrival_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/student_schedule_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/student_work_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/children_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/clubs_sports_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/coach_teams_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/class_register_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/courses_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/driver_route_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/family_library_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/family_pickup_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/learner_screens.dart';
import 'package:eduos_mobile_branding/ui/screens/library_desk_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/messages_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/nodes_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/operations_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/overview_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/safety_board.dart';
import 'package:eduos_mobile_branding/ui/screens/safety_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/staff_pickup_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/staffing_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/teacher_screens.dart';
import 'package:eduos_mobile_branding/ui/screens/teacher_connections_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/teacher_dashboard_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/time_capsule/history_timeline_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/time_capsule/teacher_history_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/time_capsule/time_capsules_screen.dart';
import 'package:eduos_mobile_branding/ui/screens/web_fallback_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'operations_screens_test.dart' show FakeServer, launch, openTab, now;

/// What each tab must show, per role (the spec; lib/ui/shell.dart implements it).
Type expectedScreen(String role, String tab) => switch (tab) {
      'children' => ChildrenScreen,
      'activities' => ClubsSportsScreen,
      'teams' => CoachTeamsScreen,
      'route' => DriverRouteScreen,
      'dashboard' => TeacherDashboardScreen,
      'classes' => ClassRegisterScreen,
      'schoolday' when role == 'teacher' => TeacherConnectionsScreen,
      'library' when role == 'parent' || role == 'pupil' => FamilyLibraryScreen,
      'library' => LibraryDeskScreen,
      'home' => LearnerHomeScreen,
      'path' => PathScreen,
      'christie' => ChristieTab,
      'courses' when role == 'pupil' => LearnerCoursesScreen,
      'courses' => TeacherCoursesScreen,
      'grading' => GradingScreen,
      'copilot' => CopilotScreen,
      'staffing' => StaffingScreen,
      'news' => NewsScreen,
      'arrival' => ArrivalScreen,
      'pickup' when role == 'parent' => FamilyPickupScreen,
      'pickup' => StaffPickupScreen,
      'overview' => OverviewScreen,
      'safety' when role == 'sro' => SafetyScreen,
      'safety' => SafetyCenterScreen,
      'operations' || 'guidance' || 'healthoffice' || 'facilities' || 'meals' => OperationsScreen,
      'attendance' => AttendanceTodayScreen,
      'transport' => TransportScreen,
      'nodes' => NodesScreen,
      'messages' => MessagesScreen,
      'alerts' => AlertsScreen,
      'capsules' => TimeCapsulesScreen,
      'portfolio' => HistoryTimeline,
      'contributions' => TeacherHistoryItemsScreen,
      'work' when role == 'pupil' => StudentWorkScreen,
      'schedule' when role == 'pupil' => StudentScheduleScreen,
      _ => throw StateError('no screen specified for $role/$tab'),
    };

String field(WidgetTester tester, String label) => tester.widget<TextField>(find.widgetWithText(TextField, label)).controller!.text;

void main() {
  for (final role in roleTabs.keys) {
    testWidgets('$role: every tab opens its own native screen', (tester) async {
      await launch(tester, FakeServer({}, role: role));
      for (final tab in roleTabs[role]!) {
        await openTab(tester, tab.label);
        expect(find.byType(expectedScreen(role, tab.id)), findsWidgets, reason: '$role/${tab.id}');
        expect(find.byType(WebFallbackScreen), findsNothing, reason: '$role/${tab.id} fell back to the web');
        expect(tester.takeException(), isNull, reason: '$role/${tab.id} threw');
      }
    });
  }

  testWidgets('operations: a refused or offline submission keeps the text; success clears it', (tester) async {
    var mode = 'error';
    final fake = FakeServer({
      'GET /api/school-operations/facilities': (_) => {'data': []},
      'POST /api/school-operations/facilities': (_) => switch (mode) {
            'error' => http.Response('{"error":"internal_server_error"}', 500),
            'offline' => throw http.ClientException('no network'),
            _ => {'data': {'id': 'w2'}},
          },
    }, role: 'maintenance');
    await launch(tester, fake);
    await tester.enterText(find.widgetWithText(TextField, 'Summary'), 'Boiler pressure low');
    await tester.enterText(find.widgetWithText(TextField, 'Details (optional)'), 'Room B12');
    await tester.tap(find.text('Add work item'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Your text is still here'), findsOneWidget);
    expect(field(tester, 'Summary'), 'Boiler pressure low');
    expect(field(tester, 'Details (optional)'), 'Room B12');
    mode = 'offline';
    await tester.tap(find.text('Add work item'));
    await tester.pumpAndSettle();
    expect(find.textContaining('You\'re offline. Nothing was sent'), findsOneWidget);
    expect(field(tester, 'Summary'), 'Boiler pressure low');
    mode = 'ok';
    await tester.tap(find.text('Add work item'));
    await tester.pumpAndSettle();
    expect(field(tester, 'Summary'), isEmpty);
    expect(field(tester, 'Details (optional)'), isEmpty);
    expect(fake.sent('POST', '/api/school-operations/facilities'), hasLength(3));
  });

  testWidgets('operations: a double tap sends one request per item and per new item', (tester) async {
    final hold = Completer<Object?>(), holdAdd = Completer<Object?>();
    final fake = FakeServer({
      'POST /api/school-operations/facilities/w9/status': (_) => hold.future,
      'POST /api/school-operations/facilities': (_) => holdAdd.future,
    }, role: 'vice_principal');
    await launch(tester, fake);
    await tester.tap(find.text('Complete'));
    await tester.tap(find.text('Complete'), warnIfMissed: false);
    await tester.pump();
    hold.complete({'data': {'ok': true}});
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/school-operations/facilities/w9/status'), hasLength(1));
    await tester.enterText(find.widgetWithText(TextField, 'Summary'), 'Gym lights out');
    await tester.tap(find.text('Add work item'));
    await tester.tap(find.text('Add work item'), warnIfMissed: false);
    await tester.pump();
    holdAdd.complete({'data': {'id': 'w4'}});
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/school-operations/facilities'), hasLength(1));
  });

  group('library desk', () {
    Map<String, Object? Function(http.Request)> desk({Object? Function(http.Request)? ret, Object? Function(http.Request)? checkout}) => {
          'GET /api/library/inventory': (_) => {'data': [
                {'id': 'i1', 'barcode': '3900001', 'title': 'Charlotte\'s Web'},
                {'id': 'i2', 'barcode': '3900002', 'title': 'Holes'},
              ]},
          'GET /api/library/loans': (_) => {'data': [{'id': 'l1', 'item_id': 'i1', 'title': 'Charlotte\'s Web', 'barcode': '3900001', 'due_at': now, 'returned_at': null}]},
          'GET /api/library/summary': (_) => {'data': {'totals': {'titles': 2, 'copies': 2, 'available': 1}}},
          'POST /api/library/loans/l1/return': ret ?? (_) => {'data': {'ok': true}},
          'POST /api/library/loans/checkout': checkout ?? (_) => {'data': {'id': 'l2'}},
        };
    bool checkInFocused(WidgetTester tester) =>
        tester.widget<TextField>(find.widgetWithText(TextField, 'Book barcode for check-in')).focusNode!.hasFocus;

    testWidgets('a double scan returns the book once; the field is ready for the next scan', (tester) async {
      final hold = Completer<Object?>();
      final fake = FakeServer(desk(ret: (_) => hold.future), role: 'librarian');
      await launch(tester, fake);
      await tester.enterText(find.widgetWithText(TextField, 'Book barcode for check-in'), '3900001');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.tap(find.text('Check in'), warnIfMissed: false);
      await tester.pump();
      hold.complete({'data': {'ok': true}});
      await tester.pumpAndSettle();
      expect(fake.sent('POST', '/api/library/loans/l1/return'), hasLength(1));
      expect(find.text('Returned: Charlotte\'s Web'), findsOneWidget);
      expect(field(tester, 'Book barcode for check-in'), isEmpty);
      expect(checkInFocused(tester), isTrue, reason: 'ready for the next scan without tapping');
    });

    testWidgets('an unknown barcode is selected so the next scan replaces it', (tester) async {
      await launch(tester, FakeServer(desk(), role: 'librarian'));
      await tester.enterText(find.widgetWithText(TextField, 'Book barcode for check-in'), '0000000');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();
      final c = tester.widget<TextField>(find.widgetWithText(TextField, 'Book barcode for check-in')).controller!;
      expect(c.selection, const TextSelection(baseOffset: 0, extentOffset: 7));
      expect(checkInFocused(tester), isTrue);
    });

    testWidgets('a refused checkout says why and keeps the scans', (tester) async {
      final fake = FakeServer(desk(checkout: (_) => http.Response('{"error":"library_circulation_denied"}', 403)), role: 'librarian');
      await launch(tester, fake);
      await tester.enterText(find.widgetWithText(TextField, 'Book barcode for checkout'), '3900002');
      await tester.enterText(find.widgetWithText(TextField, 'Borrower card or account ID'), 'aaaaaaaa-0000-4000-8000-000000000001');
      await tester.tap(find.text('Check out'));
      await tester.pumpAndSettle();
      expect(find.text('library circulation denied'), findsOneWidget);
      expect(field(tester, 'Book barcode for checkout'), '3900002');
      expect(fake.sent('POST', '/api/library/loans/checkout'), hasLength(1));
    });

    testWidgets('IT admin: Nodes and Library only, and can circulate', (tester) async {
      await launch(tester, FakeServer(desk(), role: 'it_admin'));
      final labels = tester.widgetList<NavigationDestination>(find.byType(NavigationDestination)).map((d) => d.label).toList();
      expect(labels, ['Nodes', 'Library']);
      await openTab(tester, 'Library');
      expect(find.text('Check out a book'), findsOneWidget);
    });
  });

  testWidgets('transport dashboard: live counts; a server error offers Retry, which recovers', (tester) async {
    var fail = true;
    final fake = FakeServer({
      'GET /api/transport/today': (_) => fail
          ? http.Response('{"error":"internal_server_error"}', 500)
          : {'data': {'routes': [{'name': 'North loop', 'bus_label': 'Bus 7', 'school_name': 'Maple', 'driver_name': 'Dee', 'stops': [{}, {}],
              'run': {'status': 'in_progress', 'started_at': now}, 'counts': {'onBoard': 12, 'expected': 15, 'alighted': 2, 'notRiding': 1}}]}},
    }, role: 'principal');
    await launch(tester, fake);
    await openTab(tester, 'Transport');
    expect(find.text('Something went wrong'), findsOneWidget);
    fail = false;
    await tester.tap(find.text('Retry'));
    await tester.pumpAndSettle();
    expect(find.text('Bus 7 · North loop'), findsOneWidget);
    expect(find.text('12'), findsOneWidget);
    expect(find.text('In progress'), findsOneWidget);
    expect(find.textContaining('No GPS'), findsOneWidget);
  });

  testWidgets('school node: offline link, waiting updates, Sync now', (tester) async {
    var up = 'offline';
    final fake = FakeServer({
      'GET /api/eden/tier': (_) => {'data': {'tier': 'school'}},
      'GET /api/node/status': (_) => {'data': {'enabled': true, 'version': '37.4.0', 'school': {'name': 'Maple'}, 'uplink': {'state': up, 'consecutiveFailures': 4},
            'outbox': {'pending': 3, 'sent': 10}, 'partner': {'name': 'Oak'}, 'hosting': []}},
      'POST /api/node/sync-now': (_) {
        up = 'online';
        return {'data': {'uplink': 'online'}};
      },
    }, role: 'superintendent');
    await launch(tester, fake);
    await openTab(tester, 'Nodes');
    expect(find.text('District link is down'), findsOneWidget);
    expect(find.textContaining('3 updates for the district waiting'), findsOneWidget);
    await tester.tap(find.text('Sync now'));
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/api/node/sync-now'), hasLength(1));
    expect(find.text('Connected to the district'), findsOneWidget);
  });
}

import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'alerts_screen.dart';
import 'class_planner_screen.dart';
import 'class_register_screen.dart';
import 'messages_screen.dart';
import 'safety_board.dart';
import 'staff_pickup_screen.dart';
import 'staffing_screen.dart';
import 'teacher_connections_screen.dart';
import 'teacher_screens.dart';
import 'time_capsule/teacher_history_screen.dart';

Future<void> _open(BuildContext context, String title, Widget screen) =>
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => Scaffold(appBar: AppBar(title: Text(title)), body: screen),
    ));

class _TeacherDashboardData {
  const _TeacherDashboardData({
    required this.schoolName,
    required this.date,
    required this.students,
    required this.attendanceMarkedToday,
    required this.toGrade,
    required this.openAssignments,
    required this.draftAssignments,
    required this.myOpenCases,
    required this.absences7d,
    required this.quizzesToReview,
    required this.tutoringFlagged,
    required this.historyDrafts,
    required this.courses,
    required this.scheduleToday,
    required this.upcomingEvents,
    required this.rooms,
    required this.assignedRooms,
    required this.connectedRooms,
    required this.checkinsToday,
    required this.busRidersCount,
    required this.waitingArrivals,
    required this.waitingPickup,
    required this.duties,
    required this.openTasks,
    required this.incompleteChecklists,
    required this.handoffsCount,
    required this.workItems,
    required this.unreadMessages,
    required this.staffAnnouncements,
    required this.unreadNotifications,
    required this.notifications,
    required this.safetyIncidents,
  });

  final String schoolName;
  final String date;
  final int students;
  final int attendanceMarkedToday;
  final int toGrade;
  final int openAssignments;
  final int draftAssignments;
  final int myOpenCases;
  final int absences7d;
  final int quizzesToReview;
  final int tutoringFlagged;
  final int historyDrafts;
  final List<Json> courses;
  final List<Json> scheduleToday;
  final List<Json> upcomingEvents;
  final List<Json> rooms;
  final int assignedRooms;
  final int connectedRooms;
  final int checkinsToday;
  final int busRidersCount;
  final int waitingArrivals;
  final int waitingPickup;
  final List<Json> duties;
  final int openTasks;
  final int incompleteChecklists;
  final int handoffsCount;
  final List<Json> workItems;
  final int unreadMessages;
  final List<Json> staffAnnouncements;
  final int unreadNotifications;
  final List<Json> notifications;
  final List<Json> safetyIncidents;

  factory _TeacherDashboardData.fromDashboard(Json d) {
    final school = obj(d['school']);
    final ov = obj(d['overview']);
    final cl = obj(d['classroom']);
    final tr = obj(d['transportation']);
    final wq = obj(d['workQueue']);
    final cn = obj(d['connections']);
    final al = obj(d['alerts']);
    return _TeacherDashboardData(
      schoolName: str(school['name'], 'Your school'),
      date: str(d['date']),
      students: integer(ov['students']),
      attendanceMarkedToday: integer(ov['attendanceMarkedToday']),
      toGrade: integer(wq['toGrade']),
      openAssignments: integer(wq['openAssignments']),
      draftAssignments: integer(wq['draftAssignments']),
      myOpenCases: integer(ov['myOpenCases']),
      absences7d: integer(ov['absences7d']),
      quizzesToReview: integer(wq['quizzesToReview']),
      tutoringFlagged: integer(wq['tutoringFlagged']),
      historyDrafts: integer(wq['historyDrafts']),
      courses: objs(ov['courses']),
      scheduleToday: objs(ov['scheduleToday']),
      upcomingEvents: objs(ov['upcomingEvents']),
      rooms: objs(cl['rooms']),
      assignedRooms: integer(cl['assignedRooms']),
      connectedRooms: integer(cl['connectedRooms']),
      checkinsToday: integer(cl['checkinsToday']),
      busRidersCount: integer(tr['busRidersCount']),
      waitingArrivals: integer(tr['arrivalsPending']),
      waitingPickup: integer(tr['pickupWaitingCount']),
      duties: objs(d['duties']),
      openTasks: integer(wq['openTasks']),
      incompleteChecklists: integer(wq['incompleteChecklists']),
      handoffsCount: integer(wq['pendingHandoffs']),
      workItems: objs(wq['items']),
      unreadMessages: integer(cn['unreadMessages']),
      staffAnnouncements: objs(cn['staffAnnouncements']),
      unreadNotifications: integer(al['unreadNotifications']),
      notifications: objs(al['notifications']),
      safetyIncidents: objs(al['safetyIncidents']),
    );
  }
}

/// A single daily command center that summarizes existing teacher workflows.
/// Prefers the unified GET /api/teacher/dashboard endpoint and falls back to
/// individual permission-scoped endpoints if unavailable.
class TeacherDashboardScreen extends StatelessWidget {
  const TeacherDashboardScreen({super.key});

  Future<_TeacherDashboardData> _load(BuildContext context) async {
    final api = AppScope.read(context).api;
    Future<Map<String, Object?>?> get(String path) async {
      try {
        return await api.get(path);
      } on ApiException catch (e) {
        if (e.isUnauthorized || e.isOffline) rethrow;
        return null;
      }
    }

    final unified = await get('/api/teacher/dashboard');
    if (unified != null && obj(unified['data']).isNotEmpty) {
      return _TeacherDashboardData.fromDashboard(obj(unified['data']));
    }

    final results = await Future.wait([
      get('/api/home'),
      get('/api/learning/courses'),
      get('/api/my/rooms'),
      get('/api/staff-workspace'),
      get('/api/arrival/today'),
      get('/api/pickup/queue'),
      get('/api/transport/today'),
    ]);
    final home = obj(results[0]?['data']);
    final courses = objs(obj(results[1]?['data'])['courses']);
    final rooms = objs(results[2]?['data']);
    final workspace = obj(results[3]?['data']);
    final arrivals = objs(results[4]?['data']);
    final pickup = obj(results[5]?['data']);
    final riders = objs(obj(results[6]?['data'])['riders']);

    final tasks = objs(workspace['tasks']);
    final checklists = objs(workspace['checklists']);
    final handoffs = objs(workspace['handoffs']);
    final pairedRooms = rooms.where((r) => obj(r['pairing']).isNotEmpty).length;
    final openTasks = tasks.where((t) => !['done', 'completed', 'closed', 'cancelled'].contains(str(t['status']).toLowerCase())).length;
    final incompleteChecklists = checklists.where((c) => c['completed_at'] == null).length;
    final waitingArrivals = arrivals.where((a) => !['received', 'completed', 'cancelled'].contains(str(a['status']).toLowerCase())).length;
    final waitingPickup = objs(pickup['waiting']).length;

    return _TeacherDashboardData(
      schoolName: str(home['school_name'], 'Your school'),
      date: '',
      students: integer(home['students']),
      attendanceMarkedToday: 0,
      toGrade: integer(home['to_grade']),
      openAssignments: integer(home['open_assignments']),
      draftAssignments: integer(home['draft_assignments']),
      myOpenCases: integer(home['my_open_cases']),
      absences7d: integer(home['absences_7d']),
      quizzesToReview: 0,
      tutoringFlagged: 0,
      historyDrafts: 0,
      courses: courses,
      scheduleToday: const [],
      upcomingEvents: const [],
      rooms: rooms,
      assignedRooms: rooms.length,
      connectedRooms: pairedRooms,
      checkinsToday: 0,
      busRidersCount: riders.length,
      waitingArrivals: waitingArrivals,
      waitingPickup: waitingPickup,
      duties: const [],
      openTasks: openTasks,
      incompleteChecklists: incompleteChecklists,
      handoffsCount: handoffs.length,
      workItems: const [],
      unreadMessages: 0,
      staffAnnouncements: objs(workspace['announcements']),
      unreadNotifications: 0,
      notifications: const [],
      safetyIncidents: const [],
    );
  }

  Widget _openTarget(String target) => switch (target) {
        'grading' => const GradingScreen(),
        'copilot' => const CopilotScreen(),
        'courses' => const TeacherCoursesScreen(),
        'classes' => const ClassRegisterScreen(),
        'contributions' => const TeacherHistoryItemsScreen(),
        'messages' => const MessagesScreen(),
        'alerts' => const AlertsScreen(),
        'pickup' => const StaffPickupScreen(),
        'staffing' => const StaffingScreen(),
        _ => const TeacherConnectionsScreen(),
      };

  String _targetTitle(String target) => switch (target) {
        'grading' => 'Grading',
        'copilot' => 'Christie',
        'courses' => 'My courses',
        'classes' => 'Today in class',
        'contributions' => 'History items',
        'messages' => 'Messages',
        'alerts' => 'Alerts',
        'pickup' => 'Pick-up duty',
        'staffing' => 'Staffing',
        _ => 'School day',
      };

  @override
  Widget build(BuildContext context) => Loader<_TeacherDashboardData>(
        load: () => _load(context),
        builder: (context, data, reload) {
          final hasAlerts = data.safetyIncidents.isNotEmpty || data.unreadNotifications > 0 || data.waitingArrivals > 0;
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Row(children: [
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Good day', style: Theme.of(context).textTheme.titleLarge),
                  Text(data.date.isEmpty ? data.schoolName : '${data.schoolName} · ${data.date}', style: Theme.of(context).textTheme.bodyMedium),
                ])),
                IconButton(tooltip: 'Refresh dashboard', onPressed: reload, icon: const Icon(Icons.refresh)),
              ]),
              const SizedBox(height: 12),
              if (hasAlerts || data.notifications.isNotEmpty)
                SectionCard(title: 'Alerts and safety', children: [
                  for (final inc in data.safetyIncidents)
                    Notice('${str(inc['kind']).toUpperCase()}${inc['is_drill'] == true ? ' (drill)' : ''}: ${str(inc['instructions'], str(inc['status']))}'),
                  if (data.waitingArrivals > 0)
                    Notice('${data.waitingArrivals} arrival handoff(s) awaiting confirmation.'),
                  for (final n in data.notifications.take(3))
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: Icon(alertIcon(str(n['kind']))),
                      title: Text(str(n['title']), style: const TextStyle(fontWeight: FontWeight.w600)),
                      subtitle: str(n['body']).isEmpty ? null : Text(str(n['body'])),
                      trailing: n['read_at'] == null ? const StatusChip('current', text: 'New') : null,
                    ),
                  Wrap(spacing: 8, runSpacing: 8, children: [
                    OutlinedButton.icon(
                      onPressed: () => _open(context, 'Alerts', const AlertsScreen()),
                      icon: const Icon(Icons.notifications_none),
                      label: Text('Alerts (${data.unreadNotifications})'),
                    ),
                    OutlinedButton.icon(
                      onPressed: () => _open(context, 'Safety', const SafetyCenterScreen(embedded: true)),
                      icon: const Icon(Icons.shield_outlined),
                      label: const Text('Safety status'),
                    ),
                  ]),
                ]),
              SectionCard(title: 'Your day at a glance', children: [
                LayoutBuilder(builder: (context, constraints) {
                  final columns = constraints.maxWidth >= 560 ? 4 : 2;
                  return GridView.count(
                    crossAxisCount: columns,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    childAspectRatio: columns == 4 ? 1.55 : 1.8,
                    children: [
                      StatTile(data.students, 'Learners'),
                      StatTile(data.toGrade, 'To grade', warnWhenPositive: true),
                      StatTile(data.waitingArrivals, 'Arrivals', warnWhenPositive: true),
                      StatTile(data.waitingPickup, 'Pick-up queue', warnWhenPositive: true),
                    ],
                  );
                }),
                if (data.students > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text('Attendance marked today: ${data.attendanceMarkedToday}/${data.students}', style: Theme.of(context).textTheme.bodySmall),
                  ),
                if (data.myOpenCases > 0)
                  Notice('${data.myOpenCases} student support case(s) need follow-up.'),
                if (data.absences7d > 0)
                  Notice('${data.absences7d} absence event(s) across your roster in the last seven days.'),
                if (data.scheduleToday.isNotEmpty) ...[
                  const Divider(),
                  const Text('Today\'s schedule', style: TextStyle(fontWeight: FontWeight.w600)),
                  for (final s in data.scheduleToday)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      title: Text('${str(s['starts'])}–${str(s['ends'])} · ${str(s['label'])}'),
                      subtitle: Text(str(s['room'])),
                      trailing: s['now'] == true ? const StatusChip('current', text: 'Now') : null,
                    ),
                ],
                if (data.upcomingEvents.isNotEmpty) ...[
                  const Divider(),
                  const Text('Upcoming events', style: TextStyle(fontWeight: FontWeight.w600)),
                  for (final e in data.upcomingEvents)
                    ListTile(
                      dense: true,
                      contentPadding: EdgeInsets.zero,
                      leading: const Icon(Icons.event_outlined),
                      title: Text(str(e['title'])),
                      subtitle: str(e['venue']).isEmpty ? null : Text(str(e['venue'])),
                    ),
                ],
              ]),
              SectionCard(title: 'Classroom operations', children: [
                Row(children: [
                  Expanded(child: StatTile(data.assignedRooms, 'Assigned rooms')),
                  Expanded(child: StatTile(data.connectedRooms, 'Connected rooms')),
                  Expanded(child: StatTile(data.courses.length, 'Courses')),
                ]),
                if (data.checkinsToday > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text('Room check-ins today: ${data.checkinsToday}', style: Theme.of(context).textTheme.bodySmall),
                  ),
                for (final r in data.rooms.take(4))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(r['paired'] == true ? Icons.cast_connected : Icons.meeting_room_outlined),
                    title: Text(str(r['name'])),
                    subtitle: Text('${integer(r['deviceCount'])} device(s)${r['controller'] != null ? ' · ${str(r['controller'])}' : ''}'),
                    trailing: r['paired'] == true ? const StatusChip('current', text: 'Paired') : null,
                  ),
                const SizedBox(height: 8),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  FilledButton.icon(
                    onPressed: () => _open(context, 'Today in class', const ClassRegisterScreen()),
                    icon: const Icon(Icons.fact_check_outlined),
                    label: const Text('Open class register'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _open(context, 'School day', const TeacherConnectionsScreen()),
                    icon: const Icon(Icons.tv_outlined),
                    label: const Text('Room controls'),
                  ),
                ]),
              ]),
              SectionCard(title: 'Teaching and grading', children: [
                Row(children: [
                  Expanded(child: StatTile(data.openAssignments, 'Published assignments')),
                  Expanded(child: StatTile(data.draftAssignments, 'Drafts')),
                  Expanded(child: StatTile(data.toGrade, 'To grade', warnWhenPositive: true)),
                ]),
                if (data.quizzesToReview > 0 || data.tutoringFlagged > 0 || data.historyDrafts > 0)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      '${data.quizzesToReview} quiz review(s) · ${data.tutoringFlagged} Christie flag(s) · ${data.historyDrafts} history draft(s)',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ),
                const SizedBox(height: 8),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  OutlinedButton.icon(onPressed: () => _open(context, 'My courses', const TeacherCoursesScreen()), icon: const Icon(Icons.school_outlined), label: const Text('Courses')),
                  OutlinedButton.icon(onPressed: () => _open(context, 'Grading', const GradingScreen()), icon: const Icon(Icons.check_circle_outline), label: const Text('Grading')),
                  OutlinedButton.icon(onPressed: () => _open(context, 'Lesson planner', const ClassPlannerScreen()), icon: const Icon(Icons.event_note_outlined), label: const Text('Planner')),
                  OutlinedButton.icon(onPressed: () => _open(context, 'Christie', const CopilotScreen()), icon: const Icon(Icons.auto_awesome), label: const Text('Christie')),
                ]),
              ]),
              SectionCard(title: 'School-day coordination', children: [
                Row(children: [
                  Expanded(child: StatTile(data.busRidersCount, 'Bus riders')),
                  Expanded(child: StatTile(data.waitingArrivals, 'Awaiting handoff', warnWhenPositive: true)),
                  Expanded(child: StatTile(data.waitingPickup, 'Waiting pick-up', warnWhenPositive: true)),
                ]),
                const SizedBox(height: 8),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  FilledButton.tonalIcon(
                    onPressed: () => _open(context, 'School day', const TeacherConnectionsScreen()),
                    icon: const Icon(Icons.hub_outlined),
                    label: const Text('Open school-day workspace'),
                  ),
                  OutlinedButton.icon(
                    onPressed: () => _open(context, 'Pick-up duty', const StaffPickupScreen()),
                    icon: const Icon(Icons.directions_car_outlined),
                    label: const Text('Pick-up passes'),
                  ),
                ]),
              ]),
              SectionCard(title: 'Staff work queue', children: [
                Row(children: [
                  Expanded(child: StatTile(data.openTasks, 'Open tasks', warnWhenPositive: true)),
                  Expanded(child: StatTile(data.incompleteChecklists, 'Checklist items', warnWhenPositive: true)),
                  Expanded(child: StatTile(data.handoffsCount, 'Staff handoffs', warnWhenPositive: true)),
                ]),
                for (final item in data.workItems.take(5))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(str(item['title']), style: const TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: Text(str(item['detail'])),
                    trailing: TextButton(
                      onPressed: () => _open(context, _targetTitle(str(item['target'])), _openTarget(str(item['target']))),
                      child: const Text('Open'),
                    ),
                  ),
                for (final duty in data.duties)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.assignment_turned_in_outlined),
                    title: Text(str(duty['label'])),
                    subtitle: Text('${integer(duty['shiftsToday'])} shift(s) · ${integer(duty['checklistsCompleted'])}/${integer(duty['checklistsTotal'])} checklist · ${integer(duty['openTasks'])} task(s)'),
                    onTap: () => _open(context, 'School day', const TeacherConnectionsScreen()),
                  ),
                Text('Library, lunchroom, transport and general staff work stay in their dedicated domain dashboards.', style: Theme.of(context).textTheme.bodySmall),
              ]),
              SectionCard(title: 'Stay connected', children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.chat_bubble_outline),
                  title: const Text('Messages and staff updates'),
                  subtitle: Text(data.unreadMessages > 0
                      ? '${data.unreadMessages} unread conversation message(s)'
                      : 'Open your secure school conversations'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _open(context, 'Messages', const MessagesScreen()),
                ),
                for (final ann in data.staffAnnouncements.take(2))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.campaign_outlined),
                    title: Text(str(ann['title'])),
                    subtitle: Text(str(ann['body'])),
                  ),
                OutlinedButton.icon(
                  onPressed: () => _open(context, 'Staffing', const StaffingScreen()),
                  icon: const Icon(Icons.groups_outlined),
                  label: const Text('Staffing & shifts'),
                ),
              ]),
            ],
          );
        },
      );
}

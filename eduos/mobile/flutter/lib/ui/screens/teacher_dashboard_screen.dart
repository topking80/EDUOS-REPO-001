import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'class_register_screen.dart';
import 'messages_screen.dart';
import 'teacher_connections_screen.dart';
import 'teacher_screens.dart';

Future<void> _open(BuildContext context, Widget screen) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));

class _TeacherDashboardData {
  const _TeacherDashboardData({
    required this.home,
    required this.courses,
    required this.rooms,
    required this.workspace,
    required this.arrivals,
    required this.pickup,
    required this.riders,
  });

  final Json home;
  final List<Json> courses;
  final List<Json> rooms;
  final Json workspace;
  final List<Json> arrivals;
  final Json pickup;
  final List<Json> riders;
}

/// A single daily command center that summarizes existing teacher workflows.
/// Each source remains permission-scoped by its established API endpoint.
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

    final results = await Future.wait([
      get('/api/home'),
      get('/api/learning/courses'),
      get('/api/my/rooms'),
      get('/api/staff-workspace'),
      get('/api/arrival/today'),
      get('/api/pickup/queue'),
      get('/api/transport/today'),
    ]);
    return _TeacherDashboardData(
      home: obj(results[0]?['data']),
      courses: objs(obj(results[1]?['data'])['courses']),
      rooms: objs(results[2]?['data']),
      workspace: obj(results[3]?['data']),
      arrivals: objs(results[4]?['data']),
      pickup: obj(results[5]?['data']),
      riders: objs(obj(results[6]?['data'])['riders']),
    );
  }

  @override
  Widget build(BuildContext context) => Loader<_TeacherDashboardData>(
        load: () => _load(context),
        builder: (context, data, reload) {
          final tasks = objs(data.workspace['tasks']);
          final checklists = objs(data.workspace['checklists']);
          final handoffs = objs(data.workspace['handoffs']);
          final pairedRooms = data.rooms.where((r) => obj(r['pairing']).isNotEmpty).length;
          final openTasks = tasks.where((t) => !['done', 'completed', 'closed', 'cancelled'].contains(str(t['status']).toLowerCase())).length;
          final incompleteChecklists = checklists.where((c) => c['completed_at'] == null).length;
          final waitingArrivals = data.arrivals.where((a) => !['received', 'completed', 'cancelled'].contains(str(a['status']).toLowerCase())).length;
          final waitingPickup = objs(data.pickup['waiting']).length;
          final school = str(data.home['school_name'], 'Your school');

          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Row(children: [
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text('Good day', style: Theme.of(context).textTheme.titleLarge),
                  Text(school, style: Theme.of(context).textTheme.bodyMedium),
                ])),
                IconButton(tooltip: 'Refresh dashboard', onPressed: reload, icon: const Icon(Icons.refresh)),
              ]),
              const SizedBox(height: 12),
              SectionCard(title: 'Your day at a glance', children: [
                LayoutBuilder(builder: (context, constraints) {
                  final columns = constraints.maxWidth >= 560 ? 4 : 2;
                  return GridView.count(
                    crossAxisCount: columns,
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    childAspectRatio: columns == 4 ? 1.55 : 1.8,
                    children: [
                      StatTile(integer(data.home['students']), 'Learners'),
                      StatTile(integer(data.home['to_grade']), 'To grade', warnWhenPositive: true),
                      StatTile(waitingArrivals, 'Arrivals', warnWhenPositive: true),
                      StatTile(waitingPickup, 'Pick-up queue', warnWhenPositive: true),
                    ],
                  );
                }),
                if (integer(data.home['my_open_cases']) > 0)
                  Notice('${integer(data.home['my_open_cases'])} student support case(s) need follow-up.'),
                if (integer(data.home['absences_7d']) > 0)
                  Notice('${integer(data.home['absences_7d'])} absence event(s) across your roster in the last seven days.'),
              ]),
              SectionCard(title: 'Classroom operations', children: [
                Row(children: [
                  Expanded(child: StatTile(data.rooms.length, 'Assigned rooms')),
                  Expanded(child: StatTile(pairedRooms, 'Connected rooms')),
                  Expanded(child: StatTile(data.courses.length, 'Courses')),
                ]),
                const SizedBox(height: 8),
                FilledButton.icon(
                  onPressed: () => _open(context, const ClassRegisterScreen()),
                  icon: const Icon(Icons.fact_check_outlined),
                  label: const Text('Open class register'),
                ),
              ]),
              SectionCard(title: 'Teaching and grading', children: [
                Row(children: [
                  Expanded(child: StatTile(integer(data.home['open_assignments']), 'Published assignments')),
                  Expanded(child: StatTile(integer(data.home['draft_assignments']), 'Drafts')),
                  Expanded(child: StatTile(integer(data.home['to_grade']), 'To grade', warnWhenPositive: true)),
                ]),
                Wrap(spacing: 8, runSpacing: 8, children: [
                  OutlinedButton.icon(onPressed: () => _open(context, const TeacherCoursesScreen()), icon: const Icon(Icons.school_outlined), label: const Text('Courses')),
                  OutlinedButton.icon(onPressed: () => _open(context, const GradingScreen()), icon: const Icon(Icons.check_circle_outline), label: const Text('Grading')),
                  OutlinedButton.icon(onPressed: () => _open(context, const CopilotScreen()), icon: const Icon(Icons.auto_awesome), label: const Text('Planner')),
                ]),
              ]),
              SectionCard(title: 'School-day coordination', children: [
                Row(children: [
                  Expanded(child: StatTile(data.riders.length, 'Bus riders')),
                  Expanded(child: StatTile(waitingArrivals, 'Awaiting handoff', warnWhenPositive: true)),
                  Expanded(child: StatTile(waitingPickup, 'Waiting pick-up', warnWhenPositive: true)),
                ]),
                const SizedBox(height: 8),
                FilledButton.tonalIcon(
                  onPressed: () => _open(context, const TeacherConnectionsScreen()),
                  icon: const Icon(Icons.hub_outlined),
                  label: const Text('Open school-day workspace'),
                ),
              ]),
              SectionCard(title: 'Staff work queue', children: [
                Row(children: [
                  Expanded(child: StatTile(openTasks, 'Open tasks', warnWhenPositive: true)),
                  Expanded(child: StatTile(incompleteChecklists, 'Checklist items', warnWhenPositive: true)),
                  Expanded(child: StatTile(handoffs.length, 'Staff handoffs', warnWhenPositive: true)),
                ]),
                Text('Library, lunchroom, transport and general staff work stay in their dedicated domain dashboards.', style: Theme.of(context).textTheme.bodySmall),
              ]),
              SectionCard(title: 'Stay connected', children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.chat_bubble_outline),
                  title: const Text('Messages and staff updates'),
                  subtitle: const Text('Open your secure school conversations'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _open(context, const MessagesScreen()),
                ),
              ]),
            ],
          );
        },
      );
}

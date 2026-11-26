import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../widgets.dart';

const attendanceLabels = {
  'present': 'Present',
  'late': 'Late',
  'excused': 'Excused',
  'absent': 'Absent',
};

const physicalLabels = {
  'cleared': ('present', 'Physical on file'),
  'expiring': ('expected', 'Physical expiring'),
  'expired': ('absent', 'Physical expired'),
  'missing': ('absent', 'No physical on file'),
};

/// Coach/advisor attendance for one meeting, practice or game (db/152).
class ActivityAttendanceScreen extends StatefulWidget {
  const ActivityAttendanceScreen({super.key, required this.eventId, required this.title});
  final String eventId;
  final String title;

  static Future<void> open(BuildContext context, {required String eventId, required String title}) =>
      Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => Scaffold(appBar: AppBar(title: Text(title)), body: ActivityAttendanceScreen(eventId: eventId, title: title)),
      ));

  @override
  State<ActivityAttendanceScreen> createState() => _ActivityAttendanceScreenState();
}

class _ActivityAttendanceScreenState extends State<ActivityAttendanceScreen> {
  final _picks = <String, String>{};

  @override
  Widget build(BuildContext context) => Loader<Json>(
        load: () async => obj((await AppScope.read(context).api.get('/api/events/${widget.eventId}/attendance'))['data']),
        builder: (context, d, reload) {
          final students = objs(d['students']);
          String? current(Json s) {
            final id = str(s['studentId']);
            if (_picks.containsKey(id)) return _picks[id];
            final status = str(s['status']);
            return status.isEmpty ? null : status;
          }
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text('${integer(d['unmarked'])} not marked yet', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            if (students.isEmpty) const EmptyState('No one is on this activity yet.'),
            for (final s in students)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(str(s['name'])),
                subtitle: Text('Grade ${str(s['grade'])}'),
                trailing: DropdownButton<String>(
                  key: Key('attendance-status-${str(s['studentId'])}'),
                  value: current(s),
                  hint: const Text('Mark'),
                  items: [
                    for (final e in attendanceLabels.entries) DropdownMenuItem(value: e.key, child: Text(e.value)),
                  ],
                  onChanged: (v) => setState(() {
                    if (v == null) {
                      _picks.remove(str(s['studentId']));
                    } else {
                      _picks[str(s['studentId'])] = v;
                    }
                  }),
                ),
              ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: students.every((s) => current(s) == null)
                  ? null
                  : () async {
                      final marks = [
                        for (final s in students)
                          if (current(s) != null) {'studentId': str(s['studentId']), 'status': current(s)},
                      ];
                      try {
                        await AppScope.read(context).api.put('/api/events/${widget.eventId}/attendance', {
                          'marks': marks,
                        });
                        if (!context.mounted) return;
                        toast(context, 'Attendance saved.');
                        _picks.clear();
                        reload();
                      } on ApiException catch (e) {
                        if (!context.mounted) return;
                        toast(context, switch (e.error) {
                          'event_not_started' => 'Attendance opens when the event starts.',
                          'event_cancelled' => 'This event was cancelled.',
                          _ when e.isOffline => 'You\'re offline. Connect to save attendance.',
                          _ => 'Couldn\'t save attendance.',
                        });
                      }
                    },
              child: const Text('Save attendance'),
            ),
          ]);
        },
      );
}

/// Coach view of athletic physical clearance dates only (db/152). No medical details.
class ActivityPhysicalsScreen extends StatelessWidget {
  const ActivityPhysicalsScreen({super.key, required this.activityId, required this.title});
  final String activityId;
  final String title;

  static Future<void> open(BuildContext context, {required String activityId, required String title}) =>
      Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => Scaffold(appBar: AppBar(title: Text('Physicals · $title')), body: ActivityPhysicalsScreen(activityId: activityId, title: title)),
      ));

  @override
  Widget build(BuildContext context) => Loader<Json>(
        load: () async => obj((await AppScope.read(context).api.get('/api/activities/$activityId/physicals'))['data']),
        builder: (context, d, reload) {
          final students = objs(d['students']);
          final summary = obj(d['summary']);
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text('${integer(summary['cleared'])} on file · ${integer(summary['expiring'])} expiring · ${integer(summary['expired'])} expired · ${integer(summary['missing'])} missing. Dates only; no medical details are kept.',
                style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            if (students.isEmpty) const EmptyState('No one is on the active roster yet.'),
            for (final s in students)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(str(s['name'])),
                subtitle: str(s['expiresOn']).isEmpty ? null : Text('Expires ${str(s['expiresOn'])}'),
                trailing: () {
                  final chip = physicalLabels[str(s['status'])];
                  return chip == null ? null : StatusChip(chip.$1, text: chip.$2);
                }(),
              ),
          ]);
        },
      );
}

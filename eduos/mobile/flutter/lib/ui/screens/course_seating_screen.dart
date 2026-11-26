import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Teacher/admin seating chart for a course, or a family's own-seat view when sharing is on (db/153).
class CourseSeatingScreen extends StatelessWidget {
  const CourseSeatingScreen({super.key, required this.courseId, this.title = 'Seating chart'});
  final String courseId;
  final String title;

  static Future<void> open(BuildContext context, {required String courseId, String title = 'Seating chart'}) =>
      Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => Scaffold(appBar: AppBar(title: Text(title)), body: CourseSeatingScreen(courseId: courseId, title: title)),
      ));

  @override
  Widget build(BuildContext context) => Loader<Json>(
        load: () async => obj((await AppScope.read(context).api.get('/api/learning/courses/$courseId/seating'))['data']),
        builder: (context, d, reload) {
          if (d['canManage'] != true) {
            final mine = objs(d['assignments']);
            final room = str(obj(d['chart'])['roomName']);
            return ListView(padding: const EdgeInsets.all(16), children: [
              if (mine.isEmpty) const EmptyState('The teacher has shared this chart, but no seat is assigned yet.'),
              for (final a in mine)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(str(a['name'])),
                  subtitle: Text(['Row ${a['row']}, seat ${a['col']}', if (str(a['label']).isNotEmpty) str(a['label']), if (room.isNotEmpty) room].join(' · ')),
                ),
            ]);
          }
          return _ManagerSeating(courseId: courseId, data: d, reload: reload);
        },
      );
}

class _ManagerSeating extends StatefulWidget {
  const _ManagerSeating({required this.courseId, required this.data, required this.reload});
  final String courseId;
  final Json data;
  final VoidCallback reload;

  @override
  State<_ManagerSeating> createState() => _ManagerSeatingState();
}

class _ManagerSeatingState extends State<_ManagerSeating> {
  late bool _share;
  late final Map<String, TextEditingController> _rows;
  late final Map<String, TextEditingController> _cols;

  @override
  void initState() {
    super.initState();
    final d = widget.data;
    final chart = obj(d['chart']);
    _share = d['shareWithFamilies'] == true || chart['shareWithFamilies'] == true;
    final byStudent = {for (final a in objs(d['assignments'])) str(a['studentId']): a};
    _rows = {};
    _cols = {};
    for (final s in objs(d['students'])) {
      final id = str(s['studentId']);
      final cur = byStudent[id];
      _rows[id] = TextEditingController(text: cur == null ? '' : '${cur['row']}');
      _cols[id] = TextEditingController(text: cur == null ? '' : '${cur['col']}');
    }
  }

  @override
  void dispose() {
    for (final c in _rows.values) {
      c.dispose();
    }
    for (final c in _cols.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final d = widget.data;
    final students = objs(d['students']);
    return ListView(padding: const EdgeInsets.all(16), children: [
      Text('${objs(d['assignments']).length} of ${students.length} enrolled learners seated.', style: Theme.of(context).textTheme.bodySmall),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Let each student and their family see their own seat'),
        value: _share,
        onChanged: (v) => setState(() => _share = v),
      ),
      if (students.isEmpty) const EmptyState('No enrolled learners in this course yet.'),
      for (final s in students)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(str(s['name'])),
          subtitle: Row(children: [
            SizedBox(width: 72, child: TextField(controller: _rows[str(s['studentId'])], keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Row'))),
            const SizedBox(width: 8),
            SizedBox(width: 72, child: TextField(controller: _cols[str(s['studentId'])], keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Seat'))),
          ]),
        ),
      const SizedBox(height: 12),
      FilledButton(
        onPressed: () async {
          final assignments = <Map<String, Object?>>[];
          for (final s in students) {
            final id = str(s['studentId']);
            final row = int.tryParse(_rows[id]?.text.trim() ?? '');
            final col = int.tryParse(_cols[id]?.text.trim() ?? '');
            if (row == null && col == null) continue;
            assignments.add({'studentId': id, 'row': row, 'col': col, 'label': ''});
          }
          try {
            final chart = obj(d['chart']);
            final rows = integer(chart['rowsCount']);
            final cols = integer(chart['colsCount']);
            await AppScope.read(context).api.put('/api/learning/courses/${widget.courseId}/seating', {
              'rowsCount': rows < 1 ? 5 : rows,
              'colsCount': cols < 1 ? 6 : cols,
              'roomId': chart['roomId'],
              'shareWithFamilies': _share,
              'assignments': assignments,
            });
            if (!context.mounted) return;
            toast(context, _share ? 'Seating chart saved. Families can see their own seat.' : 'Seating chart saved. Families cannot see seats.');
            widget.reload();
          } on ApiException catch (e) {
            if (!context.mounted) return;
            toast(context, e.isOffline ? 'You\'re offline. Connect to save the seating chart.' : 'Check row/seat numbers: each learner needs a unique seat inside the grid.');
          }
        },
        child: const Text('Save seating chart'),
      ),
    ]);
  }
}

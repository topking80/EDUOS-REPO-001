import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

class _ClassToday {
  const _ClassToday({required this.schoolName, required this.students, required this.toGrade, required this.openAssignments,
      required this.absences7d, required this.roster, required this.marks});
  final String schoolName;
  final int students, toGrade, openAssignments, absences7d;
  final List<RosterLearner> roster;

  /// Latest mark recorded today per learner (studentId -> status).
  final Map<String, String> marks;
}

const attendanceStatuses = ['present', 'absent', 'tardy'];

/// Teacher "Classes": today's numbers and the class register. Marking uses
/// POST /api/attendance, which is offline-safe: with no signal the mark is
/// kept on the phone and sent later with the time it was actually taken.
/// A changed mark is recorded as a new event, like the rest of EduOS.
class ClassRegisterScreen extends StatefulWidget {
  const ClassRegisterScreen({super.key, this.today});

  /// Override "today" (tests).
  final DateTime? today;

  @override
  State<ClassRegisterScreen> createState() => _ClassRegisterScreenState();
}

class _ClassRegisterScreenState extends State<ClassRegisterScreen> {
  /// Marks saved on this phone and not yet confirmed (shown while open).
  final Map<String, String> _pending = {};
  final Set<String> _sending = {};
  Key _loaderKey = UniqueKey();

  String get _day => isoDate(widget.today ?? DateTime.now());

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (AppScope.of(context).queued == 0 && _pending.isNotEmpty) {
      _pending.clear();
      _loaderKey = UniqueKey();
    }
  }

  Future<_ClassToday> _load() async {
    final api = AppScope.read(context).api;
    final results = await Future.wait([api.get('/api/home'), api.get('/api/rosters'), api.get('/api/attendance')]);
    final home = obj(results[0]['data']);
    final roster = objs(results[1]['data']).map(RosterLearner.fromJson).toList();
    // GET /api/attendance is newest first, so the first mark seen per learner today wins.
    final marks = <String, String>{};
    for (final m in objs(results[2]['data']).map(AttendanceMark.fromJson)) {
      if (m.day == _day) marks.putIfAbsent(m.studentId, () => m.status);
    }
    return _ClassToday(
      schoolName: str(home['school_name']),
      students: integer(home['students']),
      toGrade: integer(home['to_grade']),
      openAssignments: integer(home['open_assignments']),
      absences7d: integer(home['absences_7d']),
      roster: roster,
      marks: marks,
    );
  }

  Future<void> _mark(RosterLearner learner, String status, Future<void> Function() reload) async {
    final app = AppScope.read(context);
    setState(() => _sending.add(learner.studentId));
    try {
      final sent = await app.api.post('/api/attendance', {'studentId': learner.studentId, 'eventDate': _day, 'status': status});
      if (!mounted) return;
      if (sent.queued) {
        setState(() => _pending[learner.studentId] = status);
        await app.refreshStatus();
        if (mounted) toast(context, '${firstName(learner.name)}: saved on this phone, sends when back online');
      } else {
        await reload();
      }
    } on ApiException catch (e) {
      if (mounted) toast(context, e.status == 404 ? '${learner.name} isn\'t on your roster.' : 'Couldn\'t save. Try again.');
    } finally {
      if (mounted) setState(() => _sending.remove(learner.studentId));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Loader<_ClassToday>(
      key: _loaderKey,
      load: _load,
      builder: (context, t, reload) {
        String? status(RosterLearner l) => _pending[l.studentId] ?? t.marks[l.studentId];
        final marked = t.roster.where((l) => status(l) != null).length;
        final unmarked = t.roster.where((l) => status(l) == null).toList();
        return ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(children: [
            Text(t.schoolName, style: Theme.of(context).textTheme.bodySmall),
            Semantics(header: true, child: Text('Today in class', style: Theme.of(context).textTheme.titleLarge)),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: StatTile(t.students, 'learners')),
              Expanded(child: StatTile(t.toGrade, 'to grade', warnWhenPositive: true)),
              Expanded(child: StatTile(t.openAssignments, 'open assignments')),
              Expanded(child: StatTile(t.absences7d, 'absences (7 days)', warnWhenPositive: true)),
            ]),
          ]),
          SectionCard(title: 'Attendance · ${fmtDay(widget.today ?? DateTime.now())}', children: [
            Text('$marked of ${t.roster.length} marked'),
            if (_pending.isNotEmpty) Notice('${_pending.length} mark${_pending.length == 1 ? '' : 's'} saved on this phone, waiting for signal.'),
            if (unmarked.isNotEmpty)
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  icon: const Icon(Icons.done_all),
                  label: Text('Mark the other ${unmarked.length} present'),
                  onPressed: () async {
                    final ok = await confirm(context,
                        title: 'Mark ${unmarked.length} learner${unmarked.length == 1 ? '' : 's'} present?',
                        text: 'Everyone not marked yet will be recorded as present for today.',
                        action: 'Mark present');
                    if (!ok) return;
                    for (final l in unmarked) {
                      if (!mounted) return;
                      await _mark(l, 'present', reload);
                    }
                  },
                ),
              ),
            if (t.roster.isEmpty) const EmptyState('No learners on your roster.'),
            for (final l in t.roster)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text(l.name, style: const TextStyle(fontWeight: FontWeight.w600))),
                    if (status(l) case final s? when !attendanceStatuses.contains(s)) StatusChip(s),
                    if (_pending.containsKey(l.studentId)) const Icon(Icons.cloud_off, size: 16, semanticLabel: 'Saved on this phone'),
                  ]),
                  const SizedBox(height: 4),
                  SegmentedButton<String>(
                    emptySelectionAllowed: true,
                    showSelectedIcon: false,
                    segments: [for (final s in attendanceStatuses) ButtonSegment(value: s, label: Text(statusLabel(s)))],
                    selected: {if (status(l) case final s? when attendanceStatuses.contains(s)) s},
                    onSelectionChanged: _sending.contains(l.studentId)
                        ? null
                        : (v) {
                            if (v.isNotEmpty && v.first != status(l)) _mark(l, v.first, reload);
                          },
                  ),
                ]),
              ),
          ]),
          const Notice('Linked families see attendance in their app. A change is recorded as a new mark; earlier marks stay in the history.'),
        ]);
      },
    );
  }
}

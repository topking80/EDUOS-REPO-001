import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Student app Phase B: the learner's own week. Classes come from the
/// learner's active enrollments at their school; club and sport events from
/// their own memberships. Times are the school's local time. Nothing is kept
/// on the device: offline, the screen says so instead of showing old data.
class StudentScheduleScreen extends StatefulWidget {
  const StudentScheduleScreen({super.key});

  @override
  State<StudentScheduleScreen> createState() => _StudentScheduleScreenState();
}

const _dayKind = {'no_school': 'No school', 'early_release': 'Early release', 'late_start': 'Late start', 'modified': 'Modified day'};
const _classStatus = {
  'scheduled': ('present', 'On'),
  'adjusted': ('expected', 'New time today'),
  'changed': ('expected', 'Changed'),
  'cancelled': ('cancelled', 'Cancelled'),
  'no_school': ('absent', 'No school'),
};

DateTime _day(String iso) => DateTime.parse('${iso}T12:00:00');

class _StudentScheduleScreenState extends State<StudentScheduleScreen> {
  String? _from;

  Future<Json> _load() async {
    final api = AppScope.read(context).api;
    final r = await api.get('/api/learning/schedule?days=7${_from == null ? '' : '&from=$_from'}');
    return obj(r['data']);
  }

  void _move(Json d, int days) => setState(() => _from = isoDate(_day(str(d['from'])).add(Duration(days: days))));

  @override
  Widget build(BuildContext context) => Loader<Json>(
        key: ValueKey(_from),
        load: _load,
        builder: (context, d, reload) {
          final days = objs(d['days']);
          final today = str(d['today']);
          final updated = date(d['updatedAt']);
          return ListView(padding: const EdgeInsets.all(16), children: [
            SectionCard(title: 'My schedule', children: [
              Text('Times are school time (${str(d['timezone'])}).${updated != null ? ' Last changed ${ago(updated)}.' : ''}',
                  style: Theme.of(context).textTheme.bodySmall),
              const SizedBox(height: 8),
              Wrap(spacing: 8, children: [
                OutlinedButton(onPressed: () => _move(d, -7), child: const Text('Previous week')),
                if (_from != null) OutlinedButton(onPressed: () => setState(() => _from = null), child: const Text('Today')),
                OutlinedButton(onPressed: () => _move(d, 7), child: const Text('Next week')),
              ]),
            ]),
            for (final day in days) _DayCard(day, isToday: str(day['date']) == today),
          ]);
        },
      );
}

class _DayCard extends StatelessWidget {
  const _DayCard(this.day, {required this.isToday});
  final Json day;
  final bool isToday;

  @override
  Widget build(BuildContext context) {
    final cal = day['calendar'] == null ? null : obj(day['calendar']);
    final classes = objs(day['classes']), events = objs(day['events']);
    final label = fmtDay(_day(str(day['date'])));
    return SectionCard(title: isToday ? 'Today · $label' : label, children: [
      if (cal != null) Notice('${_dayKind[str(cal['kind'])] ?? str(cal['kind'])}: ${str(cal['label'])}'),
      if (classes.isEmpty && events.isEmpty) EmptyState(cal?['kind'] == 'no_school' ? 'No school today.' : 'Nothing scheduled.'),
      for (final k in classes)
        _Row(
          title: '${str(k['starts'])}–${str(k['ends'])} ${str(k['title'])}',
          detail: [k['period'], k['room'], k['teacher']].where((x) => x != null && '$x'.isNotEmpty).join(' · '),
          note: strOrNull(k['note']),
          chip: _classStatus[str(k['status'])] ?? ('present', str(k['status'])),
        ),
      for (final e in events)
        _Row(
          title: '${str(e['starts'])}${e['ends'] == null ? '' : '–${str(e['ends'])}'} ${str(e['title'])}',
          detail: [e['activity'], e['venue']].where((x) => x != null && '$x'.isNotEmpty).join(' · '),
          chip: e['status'] == 'cancelled' ? ('cancelled', 'Cancelled') : ('present', e['kind'] == 'sport' ? 'Sport' : 'Club'),
        ),
    ]);
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.title, required this.detail, required this.chip, this.note});
  final String title, detail;
  final String? note;
  final (String, String) chip;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              if (detail.isNotEmpty) Text(detail, style: Theme.of(context).textTheme.bodySmall),
              if (note != null) Text(note!),
            ]),
          ),
          const SizedBox(width: 8),
          StatusChip(chip.$1, text: chip.$2),
        ]),
      );
}

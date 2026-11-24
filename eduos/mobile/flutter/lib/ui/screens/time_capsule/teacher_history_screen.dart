// Teacher "History items" (TC-03): submit an item for a student on my
// roster, follow it through the school's review and the family's decision,
// and fix it when changes are requested. Mirrors VIEWS.contributions.
import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/format.dart';
import '../../../core/history_models.dart';
import '../../../core/models.dart';
import '../../widgets.dart';
import 'history_widgets.dart';

class _TeacherData {
  const _TeacherData(this.students, this.items);
  final List<(String, String)> students;
  final List<HistoryItem> items;
}

class _FixTeacherHistoryItemDialog extends StatefulWidget {
  const _FixTeacherHistoryItemDialog({required this.item});
  final HistoryItem item;

  @override
  State<_FixTeacherHistoryItemDialog> createState() => _FixTeacherHistoryItemDialogState();
}

class _FixTeacherHistoryItemDialogState extends State<_FixTeacherHistoryItemDialog> {
  late final _title = TextEditingController(text: widget.item.title);
  late final _body = TextEditingController(text: widget.item.body);

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Fix and resubmit'),
        content: SizedBox(
          width: 480,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: _title, maxLength: 180, decoration: const InputDecoration(labelText: 'Title')),
            TextField(controller: _body, maxLength: 12000, minLines: 3, maxLines: 8, decoration: const InputDecoration(labelText: 'Description')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final title = _title.text.trim();
              if (title.isNotEmpty) Navigator.pop(context, {'title': title, 'body': _body.text.trim()});
            },
            child: const Text('Resubmit'),
          ),
        ],
      );
}

class TeacherHistoryItemsScreen extends StatelessWidget {
  const TeacherHistoryItemsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<_TeacherData>(
      load: () async {
        final r = await Future.wait([
          app.api.get('/api/rosters?limit=500').catchError((Object _) => <String, Object?>{}),
          app.api.get('/api/teacher/history-items'),
        ]);
        final names = <String, String>{for (final row in objs(r[0]['data'])) str(row['student_id']): str(row['student_name'])};
        final students = names.entries.map((e) => (e.key, e.value)).toList()..sort((a, b) => a.$2.compareTo(b.$2));
        return _TeacherData(students, objs(r[1]['data']).map(HistoryItem.fromJson).toList());
      },
      builder: (context, d, reload) {
        Future<void> edit(HistoryItem i) async {
          final values = await showDialog<Map<String, String>>(
            context: context,
            builder: (_) => _FixTeacherHistoryItemDialog(item: i),
          );
          if (values == null || !context.mounted) return;
          try {
            await app.api.patch('/api/teacher/history-items/${i.id}', values);
            await app.api.post('/api/teacher/history-items/${i.id}/submit');
            if (context.mounted) toast(context, 'Resubmitted to the school.');
            await reload();
          } on ApiException {
            if (context.mounted) toast(context, 'Couldn\'t resubmit it.');
          }
        }

        return ReadableList(children: [
          _NewTeacherItem(students: d.students, onSaved: reload),
          SectionCard(title: 'My items', children: [
            if (d.items.isEmpty) const EmptyState('You haven\'t added any history items yet.'),
            for (final i in d.items)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text(i.title, style: const TextStyle(fontWeight: FontWeight.w600))),
                    StatusChip(i.status,
                        text: itemStatusText[i.status] ?? statusLabel(i.status),
                        tone: i.status == 'published'
                            ? ChipTone.good
                            : i.status == 'draft'
                                ? ChipTone.bad
                                : ChipTone.waiting),
                  ]),
                  Text([if (i.studentName != null) i.studentName!, historyTypeText[i.entryType] ?? i.entryType, fmtDay(i.occurredAt)].join(' · '), style: Theme.of(context).textTheme.bodySmall),
                  if (i.body.isNotEmpty) Text(i.body, maxLines: 3, overflow: TextOverflow.ellipsis),
                  for (final dec in i.decisions) Text(dec.label, style: Theme.of(context).textTheme.bodySmall),
                  PhotoStrip(i.photos),
                  if (i.status == 'draft') TextButton(onPressed: () => edit(i), child: const Text('Fix and resubmit')),
                ]),
              ),
          ]),
        ]);
      },
    );
  }
}

class _NewTeacherItem extends StatefulWidget {
  const _NewTeacherItem({required this.students, required this.onSaved});
  final List<(String, String)> students;
  final Future<void> Function() onSaved;

  @override
  State<_NewTeacherItem> createState() => _NewTeacherItemState();
}

class _NewTeacherItemState extends State<_NewTeacherItem> {
  String? _student;
  String _type = teacherItemTypes.first;
  final _title = TextEditingController(), _body = TextEditingController();
  DateTime _when = DateTime.now();
  bool _busy = false;

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_student == null || _title.text.trim().isEmpty) return toast(context, 'Choose a student and give it a title.');
    setState(() => _busy = true);
    try {
      await AppScope.read(context)
          .api
          .post('/api/students/$_student/history/teacher-items', {'title': _title.text.trim(), 'body': _body.text.trim(), 'entryType': _type, 'occurredAt': _when.toUtc().toIso8601String()});
      _title.clear();
      _body.clear();
      if (mounted) toast(context, 'Sent to the school for review.');
      await widget.onSaved();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'student_not_on_your_roster' ? 'That student isn\'t on your roster.' : 'Couldn\'t send it.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => SectionCard(title: 'Add to a student\'s history', children: [
        const Notice('The school reviews it, then the family decides whether to keep it.'),
        DropdownButtonFormField<String>(
          value: _student,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Student'),
          items: [for (final s in widget.students) DropdownMenuItem(value: s.$1, child: Text(s.$2))],
          onChanged: (v) => setState(() => _student = v),
        ),
        DropdownButtonFormField<String>(
          value: _type,
          decoration: const InputDecoration(labelText: 'Type'),
          items: [for (final t in teacherItemTypes) DropdownMenuItem(value: t, child: Text(historyTypeText[t] ?? t))],
          onChanged: (v) => setState(() => _type = v ?? _type),
        ),
        TextField(controller: _title, maxLength: 180, decoration: const InputDecoration(labelText: 'What did the student do?')),
        TextField(controller: _body, maxLength: 12000, minLines: 2, maxLines: 6, decoration: const InputDecoration(labelText: 'Describe it for the family (optional)')),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.event),
          title: Text('When: ${fmtDay(_when)} ${_when.year}'),
          trailing: TextButton(
            onPressed: () async {
              final d = await showDatePicker(context: context, firstDate: DateTime(DateTime.now().year - 15), lastDate: DateTime.now(), initialDate: _when);
              if (d != null) setState(() => _when = d);
            },
            child: const Text('Change'),
          ),
        ),
        FilledButton(onPressed: _busy ? null : _save, child: Text(_busy ? 'Sending…' : 'Send to the school')),
      ]);
}

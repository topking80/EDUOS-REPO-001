import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/format.dart';
import '../../../core/history_models.dart';
import '../../../core/models.dart';
import '../../widgets.dart';
import 'history_widgets.dart';

/// Make a draft Time Capsule (POST /api/history/capsules). Returns its id.
class NewCapsuleScreen extends StatefulWidget {
  const NewCapsuleScreen({super.key, required this.children, this.now});
  final List<ChildSummary> children;
  final DateTime Function()? now;

  @override
  State<NewCapsuleScreen> createState() => _NewCapsuleScreenState();
}

class _NewCapsuleScreenState extends State<NewCapsuleScreen> {
  final _form = GlobalKey<FormState>();
  final _title = TextEditingController();
  final _message = TextEditingController();
  late String? _studentId = widget.children.length == 1 ? widget.children.first.id : null;
  String _kind = 'scheduled';
  String _milestone = milestoneText.keys.first;
  DateTime? _date;
  bool _busy = false;

  DateTime get _today => (widget.now ?? DateTime.now)();

  @override
  void dispose() {
    _title.dispose();
    _message.dispose();
    super.dispose();
  }

  Future<void> _pickDate() async {
    final first = DateTime(_today.year, _today.month, _today.day).add(const Duration(days: 1));
    final picked = await showDatePicker(context: context, firstDate: first, lastDate: DateTime(_today.year + 80), initialDate: _date ?? first);
    if (picked != null) setState(() => _date = picked);
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    if (_kind == 'scheduled' && _date == null) {
      toast(context, 'Choose the day it opens.');
      return;
    }
    setState(() => _busy = true);
    final app = AppScope.read(context);
    try {
      final opens = _kind == 'milestone'
          ? {'milestone': _milestone}
          // 9 AM on the chosen day, where this device is.
          : {'releaseAt': DateTime(_date!.year, _date!.month, _date!.day, 9).toUtc().toIso8601String()};
      final res = await app.api.post('/api/history/capsules', {
        'studentId': _studentId,
        'title': _title.text.trim(),
        'message': _message.text.trim(),
        'releaseKind': _kind,
        ...opens,
      });
      final id = str(obj(res.data)['id']);
      if (mounted) {
        toast(context, 'Draft saved. Add history items and recipients, then seal it.');
        Navigator.of(context).pop(id.isEmpty ? null : id);
      }
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'invalid_capsule' ? 'Check the title and the opening date.' : 'Couldn\'t save the capsule.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('New Time Capsule')),
      body: Form(
        key: _form,
        child: ReadableList(children: [
          const Notice('A capsule starts as a draft only you can see. Seal it when it\'s ready; it opens on the day or milestone you choose, for the people who accept.'),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            value: _studentId,
            decoration: const InputDecoration(labelText: 'For'),
            items: [for (final c in widget.children) DropdownMenuItem(value: c.id, child: Text(c.name))],
            onChanged: (v) => setState(() => _studentId = v),
            validator: (v) => v == null ? 'Choose a child' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _title,
            maxLength: 180,
            decoration: const InputDecoration(labelText: 'Title'),
            validator: (v) => (v ?? '').trim().isEmpty ? 'Give it a title' : null,
          ),
          TextFormField(
            controller: _message,
            maxLength: 12000,
            minLines: 3,
            maxLines: 8,
            decoration: const InputDecoration(labelText: 'A message for when it opens (optional)'),
          ),
          const SizedBox(height: 8),
          SegmentedButton<String>(
            segments: const [
              ButtonSegment(value: 'scheduled', label: Text('On a date'), icon: Icon(Icons.event)),
              ButtonSegment(value: 'milestone', label: Text('At a milestone'), icon: Icon(Icons.flag_outlined)),
            ],
            selected: {_kind},
            onSelectionChanged: (s) => setState(() => _kind = s.first),
          ),
          const SizedBox(height: 12),
          if (_kind == 'scheduled')
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.event),
              title: Text(_date == null ? 'Choose the day it opens' : 'Opens ${fmtDay(_date)} ${_date!.year}'),
              trailing: TextButton(onPressed: _pickDate, child: Text(_date == null ? 'Choose' : 'Change')),
            )
          else
            DropdownButtonFormField<String>(
              value: _milestone,
              decoration: const InputDecoration(labelText: 'Milestone'),
              items: [for (final e in milestoneText.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
              onChanged: (v) => setState(() => _milestone = v ?? _milestone),
            ),
          const SizedBox(height: 16),
          FilledButton(onPressed: _busy ? null : _save, child: Text(_busy ? 'Saving…' : 'Save draft')),
        ]),
      ),
    );
  }
}

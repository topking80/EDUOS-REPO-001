import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Native daily lesson planner backed by TEACH-04 class-plan APIs.
class ClassPlannerScreen extends StatefulWidget {
  const ClassPlannerScreen({super.key, this.today});
  final DateTime? today;

  @override
  State<ClassPlannerScreen> createState() => _ClassPlannerScreenState();
}

class _ClassPlannerScreenState extends State<ClassPlannerScreen> {
  late DateTime _day = DateUtils.dateOnly(widget.today ?? DateTime.now());
  String? _courseId;
  Key _loaderKey = UniqueKey();
  bool _busy = false;

  String get _date => isoDate(_day);

  Future<List<Json>> _load() async {
    final data = objs((await AppScope.read(context).api.get('/api/class-plans?date=$_date'))['data']);
    if (_courseId != null && !data.any((c) => str(c['course_id']) == _courseId)) _courseId = null;
    return data;
  }

  Future<Json> _detail(String courseId) async =>
      obj((await AppScope.read(context).api.get('/api/class-plans/$courseId/$_date'))['data']);

  void _refresh() => setState(() => _loaderKey = UniqueKey());

  Future<void> _open(Json course) async {
    final id = str(course['course_id']);
    if (id.isEmpty) return;
    setState(() => _courseId = id);
    _refresh();
  }

  Future<void> _copy(Json course) async {
    final from = await showDatePicker(
      context: context,
      initialDate: _day.subtract(const Duration(days: 1)),
      firstDate: DateTime(2020),
      lastDate: _day.subtract(const Duration(days: 1)),
      helpText: 'Copy a previous class plan',
    );
    if (from == null || !mounted) return;
    try {
      await AppScope.read(context).api.post('/api/class-plans/${course['course_id']}/$_date/copy-from', {'fromDate': isoDate(from)});
      if (mounted) toast(context, 'Copied as a draft. Review it before marking ready.');
      _refresh();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'plan_exists' ? 'A plan already exists for this day.' : 'Could not copy that plan.');
    }
  }

  Future<void> _edit(Json course, Json detail) async {
    final plan = obj(detail['plan']);
    final choices = obj(detail['choices']);
    final blocks = objs(plan['blocks']).map((b) => Map<String, Object?>.from(b)).toList();
    final title = TextEditingController(text: str(plan['title']));
    try {
      final changed = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        useSafeArea: true,
        builder: (sheetContext) => _PlanEditor(
          title: title,
          blocks: blocks,
          lessons: objs(choices['lessons']),
          assignments: objs(choices['assignments']),
        ),
      );
      if (changed != true || !mounted) return;
      await _save(str(course['course_id']), title.text.trim(), blocks, plan['version'] is int ? plan['version'] as int : null, 'draft');
    } finally {
      title.dispose();
    }
  }

  Future<void> _save(String courseId, String title, List<Map<String, Object?>> blocks, int? version, String status) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      await AppScope.read(context).api.put('/api/class-plans/$courseId/$_date', {
        'title': title.isEmpty ? null : title,
        'blocks': blocks,
        'status': status,
        'baseVersion': version,
      });
      if (mounted) toast(context, status == 'ready' ? 'Class plan marked ready.' : 'Draft saved.');
      _refresh();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'plan_changed' ? 'This plan changed elsewhere. Reload it before editing.' : 'Could not save the plan.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Loader<List<Json>>(
        key: _loaderKey,
        load: _load,
        builder: (context, courses, reload) {
          Json? selected;
          for (final course in courses) {
            if (str(course['course_id']) == _courseId) {
              selected = course;
              break;
            }
          }
          return ListView(padding: const EdgeInsets.all(16), children: [
            SectionCard(children: [
              Row(children: [
                IconButton(tooltip: 'Previous day', onPressed: () { setState(() { _day = _day.subtract(const Duration(days: 1)); _courseId = null; }); _refresh(); }, icon: const Icon(Icons.chevron_left)),
                Expanded(child: Text(fmtDay(_day), textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge)),
                IconButton(tooltip: 'Next day', onPressed: () { setState(() { _day = _day.add(const Duration(days: 1)); _courseId = null; }); _refresh(); }, icon: const Icon(Icons.chevron_right)),
                IconButton(tooltip: 'Choose date', onPressed: () async {
                  final picked = await showDatePicker(context: context, initialDate: _day, firstDate: DateTime(2020), lastDate: DateTime(2100));
                  if (picked != null && mounted) setState(() { _day = DateUtils.dateOnly(picked); _courseId = null; _loaderKey = UniqueKey(); });
                }, icon: const Icon(Icons.calendar_month)),
              ]),
              const Text('Plan the flow of each class. Drafts stay private to authorized course staff until you mark them ready.'),
            ]),
            if (courses.isEmpty) const EmptyState('No active courses are available for this date.'),
            for (final c in courses)
              SectionCard(children: [
                Row(children: [
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(str(c['title']), style: Theme.of(context).textTheme.titleMedium),
                    Text([str(c['subject']), str(c['grade_level'])].where((s) => s.isNotEmpty).join(' · '), style: Theme.of(context).textTheme.bodySmall),
                  ])),
                  if (str(c['status']).isNotEmpty) StatusChip(str(c['status'])),
                ]),
                const SizedBox(height: 6),
                Text('${integer(c['blocks'])} activities · ${integer(c['minutes'])} planned min'),
                Wrap(spacing: 8, children: [
                  FilledButton.tonal(onPressed: () => _open(c), child: Text(selected == c ? 'Refresh plan' : 'Open plan')),
                  OutlinedButton(onPressed: () => _copy(c), child: const Text('Copy previous')),
                ]),
                if (selected == c)
                  FutureBuilder<Json>(
                    key: ValueKey('$_date-${c['course_id']}'),
                    future: _detail(str(c['course_id'])),
                    builder: (context, snapshot) {
                      if (snapshot.connectionState != ConnectionState.done) return const LinearProgressIndicator();
                      if (snapshot.hasError) return const Notice('Could not load this class plan.');
                      final d = snapshot.data!;
                      final p = obj(d['plan']);
                      final blocks = objs(p['blocks']);
                      return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        const Divider(),
                        Text(str(p['title']).isEmpty ? 'Untitled plan' : str(p['title']), style: Theme.of(context).textTheme.titleSmall),
                        if (p.isEmpty) const Text('No plan yet. Start with a blank draft or copy a previous day.'),
                        for (var i = 0; i < blocks.length; i++)
                          ListTile(
                            contentPadding: EdgeInsets.zero,
                            leading: CircleAvatar(radius: 15, child: Text('${i + 1}')),
                            title: Text(_blockTitle(blocks[i])),
                            subtitle: Text('${str(blocks[i]['kind'])} · ${integer(blocks[i]['minutes'])} min'),
                          ),
                        Wrap(spacing: 8, children: [
                          OutlinedButton.icon(onPressed: _busy ? null : () => _edit(c, d), icon: const Icon(Icons.edit_outlined), label: const Text('Edit plan')),
                          if (str(p['status']) != 'ready')
                            FilledButton.icon(
                              onPressed: _busy || blocks.isEmpty ? null : () => _save(str(c['course_id']), str(p['title']), blocks.map((b) => Map<String, Object?>.from(b)).toList(), p['version'] is int ? p['version'] as int : null, 'ready'),
                              icon: const Icon(Icons.check_circle_outline),
                              label: const Text('Mark ready'),
                            ),
                        ]),
                        if (p['updatedAt'] != null) Text('Last saved ${ago(DateTime.tryParse(str(p['updatedAt'])))}', style: Theme.of(context).textTheme.bodySmall),
                      ]);
                    },
                  ),
              ]),
          ]);
        },
      );

  String _blockTitle(Json b) => switch (str(b['kind'])) {
        'lesson' => str(obj(b['lesson'])['title']).isEmpty ? 'Lesson' : str(obj(b['lesson'])['title']),
        'assignment' => str(obj(b['assignment'])['title']).isEmpty ? 'Assignment' : str(obj(b['assignment'])['title']),
        'warmup' => str(b['prompt']),
        'timer' => str(b['label']).isEmpty ? 'Timer' : str(b['label']),
        'link' => str(b['label']),
        _ => str(b['title']).isEmpty ? str(b['body']) : str(b['title']),
      };
}

class _PlanEditor extends StatefulWidget {
  const _PlanEditor({required this.title, required this.blocks, required this.lessons, required this.assignments});
  final TextEditingController title;
  final List<Map<String, Object?>> blocks;
  final List<Json> lessons, assignments;

  @override
  State<_PlanEditor> createState() => _PlanEditorState();
}

class _PlanEditorState extends State<_PlanEditor> {
  Future<void> _add() async {
    final kind = await showModalBottomSheet<String>(
      context: context,
      builder: (context) => SafeArea(child: Wrap(children: [
        for (final item in const [('warmup', 'Warm-up question'), ('text', 'Instructions / notes'), ('timer', 'Timed activity'), ('lesson', 'Course lesson'), ('assignment', 'Assignment or quiz'), ('link', 'Web link')])
          ListTile(title: Text(item.$2), onTap: () => Navigator.pop(context, item.$1)),
      ])),
    );
    if (kind == null || !mounted) return;
    final block = <String, Object?>{'kind': kind, 'minutes': null, 'note': null};
    if (kind == 'lesson' || kind == 'assignment') {
      final options = kind == 'lesson' ? widget.lessons : widget.assignments;
      if (options.isEmpty) return toast(context, kind == 'lesson' ? 'No lessons in this course.' : 'No open assignments in this course.');
      final selected = await showModalBottomSheet<Json>(
        context: context,
        builder: (context) => SafeArea(child: ListView(shrinkWrap: true, children: [
          for (final option in options)
            ListTile(title: Text(str(option['title'])), onTap: () => Navigator.pop(context, option)),
        ])),
      );
      if (selected == null || !mounted) return;
      if (kind == 'lesson') block['lessonId'] = selected['id']; else block['assignmentId'] = selected['id'];
    } else {
      final values = await _textFields(kind);
      if (values == null || !mounted) return;
      block.addAll(values);
    }
    setState(() => widget.blocks.add(block));
  }

  Future<Map<String, Object?>?> _textFields(String kind) async {
    final first = TextEditingController(), second = TextEditingController();
    final result = await showDialog<Map<String, Object?>>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(switch (kind) {'warmup' => 'Warm-up', 'timer' => 'Timed activity', 'link' => 'Web link', _ => 'Class instructions'}),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: first, decoration: InputDecoration(labelText: switch (kind) {'warmup' => 'Question', 'timer' => 'Activity label', 'link' => 'Link label', _ => 'Title'})),
          if (kind == 'text' || kind == 'link')
            TextField(controller: second, decoration: InputDecoration(labelText: kind == 'link' ? 'HTTPS URL' : 'Instructions'), minLines: 2, maxLines: 5),
          if (kind == 'timer') TextField(controller: second, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Minutes')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: () {
            final a = first.text.trim(), b = second.text.trim();
            if (kind == 'warmup' && a.isNotEmpty) Navigator.pop(context, {'prompt': a});
            if (kind == 'timer' && a.isNotEmpty && (int.tryParse(b) ?? 0) > 0) Navigator.pop(context, {'label': a, 'minutes': int.parse(b)});
            if (kind == 'text' && b.isNotEmpty) Navigator.pop(context, {'title': a, 'body': b});
            if (kind == 'link' && a.isNotEmpty && b.startsWith('https://')) Navigator.pop(context, {'label': a, 'url': b});
          }, child: const Text('Add')),
        ],
      ),
    );
    first.dispose();
    second.dispose();
    return result;
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(left: 16, right: 16, top: 16, bottom: MediaQuery.viewInsetsOf(context).bottom + 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Edit class plan', style: Theme.of(context).textTheme.titleLarge),
          TextField(controller: widget.title, decoration: const InputDecoration(labelText: 'Plan title')),
          const SizedBox(height: 12),
          if (widget.blocks.isEmpty) const EmptyState('No activities yet. Add the first step.'),
          for (var i = 0; i < widget.blocks.length; i++)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(_label(widget.blocks[i])),
              subtitle: Text(str(widget.blocks[i]['kind'])),
              leading: IconButton(tooltip: 'Move up', onPressed: i == 0 ? null : () => setState(() { final b = widget.blocks.removeAt(i); widget.blocks.insert(i - 1, b); }), icon: const Icon(Icons.arrow_upward)),
              trailing: IconButton(tooltip: 'Remove activity', onPressed: () => setState(() => widget.blocks.removeAt(i)), icon: const Icon(Icons.delete_outline)),
            ),
          OutlinedButton.icon(onPressed: _add, icon: const Icon(Icons.add), label: const Text('Add activity')),
          const SizedBox(height: 8),
          FilledButton(onPressed: () => Navigator.pop(context, true), child: const Text('Save draft')),
        ]),
      );

  String _label(Map<String, Object?> b) => str(b['prompt']).isNotEmpty ? str(b['prompt']) : str(b['title']).isNotEmpty ? str(b['title']) : str(b['label']).isNotEmpty ? str(b['label']) : str(b['kind']);
}

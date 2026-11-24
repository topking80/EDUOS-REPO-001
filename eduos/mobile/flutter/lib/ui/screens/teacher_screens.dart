import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'courses_screen.dart';
import 'learner_screens.dart';

Future<void> _push(BuildContext context, Widget screen) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));

String _plural(int n, String one, [String? many]) => '$n ${n == 1 ? one : many ?? '${one}s'}';

/// Staff Courses tab: my courses with what's waiting, the course and its gradebook.
class TeacherCoursesScreen extends StatelessWidget {
  const TeacherCoursesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final teacher = app.me?.role == 'teacher';
    return Loader<List<Json>>(
      load: () async => objs(obj((await app.api.get('/api/learning/courses'))['data'])['courses']),
      builder: (context, courses, reload) => ListView(padding: const EdgeInsets.all(16), children: [
        Row(children: [
          Expanded(child: Semantics(header: true, child: Text('My courses', style: Theme.of(context).textTheme.titleLarge))),
          if (teacher) OutlinedButton.icon(icon: const Icon(Icons.groups_outlined), label: const Text('My roster'), onPressed: () => _push(context, const RosterScreen())),
        ]),
        const SizedBox(height: 8),
        if (courses.isEmpty) const EmptyState('No courses yet.'),
        for (final c in courses)
          SectionCard(children: [
            Text(str(c['title']), style: Theme.of(context).textTheme.titleMedium),
            Text('${str(c['term'])} · ${_plural(integer(c['students']), 'learner')} · ${_plural(integer(c['lessons']), 'lesson')}${teacher ? '' : ' · ${str(c['teacher_name'])}'}',
                style: Theme.of(context).textTheme.bodySmall),
            Wrap(spacing: 8, children: [
              if (integer(c['to_review']) > 0) StatusChip('expected', text: '${_plural(integer(c['to_review']), 'quiz', 'quizzes')} to review'),
              if (integer(c['to_grade']) > 0) StatusChip('expected', text: '${integer(c['to_grade'])} to grade'),
            ]),
            const SizedBox(height: 8),
            Wrap(spacing: 8, children: [
              FilledButton(
                onPressed: () async {
                  await _push(context, CourseScreen(courseId: str(c['id']), title: str(c['title'])));
                  await reload();
                },
                child: Text('Open course', semanticsLabel: 'Open course: ${c['title']}'),
              ),
              OutlinedButton(
                onPressed: () => _push(context, GradebookScreen(courseId: str(c['id']))),
                child: Text('Gradebook', semanticsLabel: 'Gradebook: ${c['title']}'),
              ),
            ]),
          ]),
      ]),
    );
  }
}

/// A teacher's roster with each learner's Christie practice at a glance.
class RosterScreen extends StatelessWidget {
  const RosterScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('My roster')),
      body: Loader<(List<Json>, List<Json>)>(
        load: () async {
          final roster = objs((await app.api.get('/api/rosters'))['data']);
          List<Json> sessions = const [];
          try {
            sessions = objs((await app.api.get('/api/christie/review'))['data']);
          } on ApiException catch (e) {
            if (e.isUnauthorized || e.isOffline) rethrow;
          }
          return ({for (final r in roster) str(r['student_id']): r}.values.toList(), sessions);
        },
        builder: (context, d, _) {
          final (students, sessions) = d;
          return ListView(padding: const EdgeInsets.all(16), children: [
            SectionCard(title: 'My roster (${students.length})', children: [
              if (students.isEmpty) const EmptyState('No learners on your roster.'),
              for (final r in students)
                () {
                  final mine = sessions.where((x) => x['student_id'] == r['student_id']).toList();
                  final flagged = mine.any((x) => x['needs_adult'] == true && x['reviewed_at'] == null);
                  return ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(str(r['student_name']), style: const TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: Text(mine.isEmpty
                        ? 'No Christie sessions yet'
                        : '${_plural(mine.length, 'Christie session')} · latest ${str(mine.first['skill_title'])} ${integer(mine.first['mastery'])}%'),
                    trailing: flagged ? const StatusChip('absent', text: 'Needs you') : null,
                  );
                }(),
            ]),
          ]);
        },
      ),
    );
  }
}

/// Extra time and read-aloud per learner (PUT /api/learning/accommodations/:studentId).
class AccommodationsCard extends StatelessWidget {
  const AccommodationsCard({super.key, required this.courseId});
  final String courseId;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return InlineLoader<List<Json>>(
      load: () async => objs((await app.api.get('/api/learning/accommodations?courseId=$courseId'))['data']),
      builder: (context, list) => SectionCard(title: 'Accommodations', children: [
        Text('Extra time stretches quiz timers. Read-aloud tells the learner to use their device\'s screen reader.', style: Theme.of(context).textTheme.bodySmall),
        if (list.isEmpty) const EmptyState('No learners in this course.'),
        for (final a in list) _AccommodationRow(a),
      ]),
    );
  }
}

class _AccommodationRow extends StatefulWidget {
  const _AccommodationRow(this.a);
  final Json a;

  @override
  State<_AccommodationRow> createState() => _AccommodationRowState();
}

class _AccommodationRowState extends State<_AccommodationRow> {
  late int _pct = const [0, 25, 50, 100].contains(integer(widget.a['extra_time_pct'])) ? integer(widget.a['extra_time_pct']) : 0;
  late bool _readAloud = boolean(widget.a['read_aloud']);
  late int _savedPct = _pct;
  late bool _savedReadAloud = _readAloud;
  bool _saving = false;

  bool get _dirty => _pct != _savedPct || _readAloud != _savedReadAloud;

  Future<void> _save(String name) async {
    if (_saving || !_dirty) return;
    setState(() => _saving = true);
    try {
      await AppScope.read(context).api.put("/api/learning/accommodations/${widget.a['student_id']}", {'extraTimePct': _pct, 'readAloud': _readAloud});
      if (!mounted) return;
      setState(() {
        _savedPct = _pct;
        _savedReadAloud = _readAloud;
        _saving = false;
      });
      toast(context, 'Saved for ${firstName(name)}');
    } on ApiException {
      if (!mounted) return;
      setState(() => _saving = false);
      toast(context, 'Couldn\'t save. Your changes are still here; try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final name = str(widget.a['display_name']);
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      const Divider(),
      Text(name, style: const TextStyle(fontWeight: FontWeight.w600)),
      Row(children: [
        Expanded(
          child: DropdownButtonFormField<int>(
            value: _pct,
            decoration: InputDecoration(labelText: 'Extra time for ${firstName(name)}'),
            items: [for (final v in const [0, 25, 50, 100]) DropdownMenuItem(value: v, child: Text(v == 0 ? 'Standard time' : '+$v% time'))],
            onChanged: _saving ? null : (v) => setState(() => _pct = v ?? 0),
          ),
        ),
        Checkbox(value: _readAloud, onChanged: _saving ? null : (v) => setState(() => _readAloud = v ?? false), semanticLabel: 'Read-aloud for $name'),
        const Text('Read-aloud'),
      ]),
      Row(mainAxisAlignment: MainAxisAlignment.end, children: [
        Text(_dirty ? 'Unsaved changes' : 'Saved', style: const TextStyle(fontSize: 12)),
        const SizedBox(width: 12),
        TextButton(
          onPressed: _saving || !_dirty ? null : () => _save(name),
          child: Text(_saving ? 'Saving…' : 'Save', semanticsLabel: 'Save accommodations for $name'),
        ),
      ]),
    ]);
  }
}

/// Staff view of an assignment: each learner's quiz attempts, with Review.
class StaffSubmissions extends StatelessWidget {
  const StaffSubmissions(this.a, {super.key, this.onReturn});
  final AssignmentDetail a;
  final Future<void> Function()? onReturn;

  @override
  Widget build(BuildContext context) {
    if (a.kind != 'quiz') {
      return SectionCard(title: 'Hand-ins', children: [
        if (a.submissions.isEmpty) const EmptyState('Nothing handed in yet.'),
        for (final x in a.submissions)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(str(x['display_name'])),
            trailing: x['points_earned'] != null
                ? StatusChip('present', text: '${pts(number(x['points_earned']))}/${pts(a.points)}')
                : const StatusChip('expected', text: 'To grade'),
          ),
        const Notice('Grade classwork from the Grading tab.'),
      ]);
    }
    return SectionCard(title: 'Attempts', children: [
      if (a.submissions.isEmpty) const EmptyState('No attempts yet.'),
      for (final x in a.submissions)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('${str(x['display_name'])} · attempt ${integer(x['attempt_no'])}${integer(x['extra_time_pct']) > 0 ? ' · +${integer(x['extra_time_pct'])}% time' : ''}'),
          trailing: x['status'] == 'needs_review'
              ? FilledButton.tonal(
                  onPressed: () async {
                    await _push(context, QuizReviewScreen(attemptId: str(x['id'])));
                    await onReturn?.call();
                  },
                  child: Text('Review', semanticsLabel: 'Review ${x['display_name']}'),
                )
              : StatusChip('present', text: '${pts(number(x['total']))}/${pts(number(x['possible']))}'),
        ),
    ]);
  }
}

/// The gradebook: each learner's grade and work, and posting final grades.
class GradebookScreen extends StatefulWidget {
  const GradebookScreen({super.key, required this.courseId});
  final String courseId;

  @override
  State<GradebookScreen> createState() => _GradebookScreenState();
}

class _GradebookScreenState extends State<GradebookScreen> {
  Key _key = UniqueKey();

  String _cell(Json c, Json a) => c['earned'] != null
      ? '${pts(number(c['earned']))}/${pts(number(a['points']))}'
      : c['missing'] == true
          ? 'missing'
          : c['status'] == 'needs_review'
              ? 'to review'
              : c['status'] == 'submitted'
                  ? 'handed in'
                  : '–';

  Future<void> _final(Json course, Json s) async {
    final app = AppScope.read(context);
    final grade = obj(s['grade']);
    final name = firstName(str(s['name']));
    final now = '${grade['letter']} (${pts(number(grade['percent']))}%)';
    final correction = s['final'] is Map;
    String? reason;
    if (correction) {
      reason = await promptText(context, title: 'Correct $name\'s final grade', text: 'Posts $now as a correction. Nothing is overwritten.', label: 'Reason (shown on the record)', action: 'Post correction');
      if (reason == null) return;
    } else if (!await confirm(context, title: 'Post $name\'s final grade?', text: '$now will be recorded on the records ledger.', action: 'Post')) {
      return;
    }
    try {
      await app.api.post('/api/learning/courses/${course['id']}/final-grades', {'studentId': s['id'], if (correction) 'percent': grade['percent'], if (correction) 'reason': reason});
      if (!mounted) return;
      toast(context, 'Final grade recorded');
      setState(() => _key = UniqueKey());
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'invalid_final_grade' ? 'A correction needs a reason of 10 or more characters.' : 'Couldn\'t post the grade.');
    }
  }

  Future<void> _credential(Json course, Json s) async {
    final app = AppScope.read(context);
    final title = await promptText(context, title: 'Credential for ${firstName(str(s['name']))}', text: 'Suggested title: Completed ${course['title']}', label: 'Title', action: 'Issue', maxLength: 160);
    if (title == null) return;
    try {
      await app.api.post('/api/learning/credentials', {'studentId': s['id'], 'kind': 'course_completion', 'title': title, 'courseId': course['id']});
      if (mounted) toast(context, 'Credential issued and recorded');
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t issue the credential.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final lead = app.me?.role == 'principal' || app.me?.role == 'superintendent';
    return Scaffold(
      appBar: AppBar(title: const Text('Gradebook')),
      body: Loader<Json>(
        key: _key,
        load: () async => obj((await app.api.get('/api/learning/courses/${widget.courseId}/gradebook'))['data']),
        builder: (context, g, _) {
          final course = obj(g['course']), assignments = objs(g['assignments']), students = objs(g['students']);
          final weights = obj(course['gradeWeights']).entries.map((e) => '${e.key} ${e.value}%').join(', ');
          return ListView(padding: const EdgeInsets.all(16), children: [
            Semantics(header: true, child: Text(str(course['title']), style: Theme.of(context).textTheme.titleLarge)),
            Text('${weights.isEmpty ? '' : 'Weights: $weights. '}Ungraded work never counts as zero; missing work is flagged.', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            if (students.isEmpty) const EmptyState('No learners in this course.'),
            for (final s in students)
              () {
                final grade = obj(s['grade']);
                final fin = s['final'] is Map ? obj(s['final']) : null;
                final cells = objs(s['cells']);
                final missing = integer(s['missing']);
                return Card(
                  child: ExpansionTile(
                    title: Text(str(s['name']), style: const TextStyle(fontWeight: FontWeight.w600)),
                    subtitle: Text(fin != null
                        ? 'Final: ${fin['letter']} (${pts(number(fin['percent']))}%) · posted ${fmtDay(date(fin['posted_at']))}'
                        : '${grade['letter'] != null ? '${grade['letter']} · ${pts(number(grade['percent']))}%' : 'No graded work yet'}${missing > 0 ? ' · $missing missing' : ''}'),
                    childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
                    expandedCrossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (var i = 0; i < assignments.length && i < cells.length; i++)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Row(children: [
                            Expanded(child: Text(str(assignments[i]['title']))),
                            Text(_cell(cells[i], assignments[i]), style: TextStyle(color: cells[i]['missing'] == true ? Theme.of(context).colorScheme.error : null)),
                          ]),
                        ),
                      const SizedBox(height: 8),
                      Wrap(spacing: 8, children: [
                        if (grade['percent'] != null)
                          OutlinedButton(onPressed: () => _final(course, s), child: Text(fin != null ? 'Correct final grade' : 'Post final grade')),
                        if (lead) OutlinedButton(onPressed: () => _credential(course, s), child: const Text('Issue credential')),
                      ]),
                    ],
                  ),
                );
              }(),
            const Notice('Posting writes the grade to the EDAL records ledger. A correction adds a new record with your reason; nothing is overwritten.'),
          ]);
        },
      ),
    );
  }
}

class _Queue {
  const _Queue(this.reviews, this.rubric, this.handIns, this.graded);
  final List<Json> reviews, rubric, handIns;
  final int graded;
}

/// Grading tab: quizzes with open answers, rubric work and hand-ins.
class GradingScreen extends StatefulWidget {
  const GradingScreen({super.key});

  @override
  State<GradingScreen> createState() => _GradingScreenState();
}

class _GradingScreenState extends State<GradingScreen> {
  Key _key = UniqueKey();

  void _reload() => setState(() => _key = UniqueKey());

  Future<_Queue> _load() async {
    final api = AppScope.read(context).api;
    Future<Map<String, Object?>?> optional(String path) async {
      try {
        return await api.get(path);
      } on ApiException catch (e) {
        if (e.isUnauthorized || e.isOffline) rethrow;
        return null;
      }
    }

    final assignments = objs((await api.get('/api/assignments'))['data']).where((a) => a['status'] == 'published' && integer(a['submission_count']) > 0).toList();
    final subs = <Json>[];
    for (final (i, r) in (await Future.wait([for (final a in assignments) optional('/api/assignments/${a['id']}/submissions')])).indexed) {
      subs.addAll([for (final s in objs(r?['data'])) {...s, '_assignment': assignments[i]}]);
    }
    final review = objs(obj((await optional('/api/learning/review'))?['data'])['attempts']).where((x) => x['status'] == 'needs_review').toList();
    final courses = objs(obj((await optional('/api/learning/courses'))?['data'])['courses']);
    final rubric = <Json>[];
    for (final (ci, g) in (await Future.wait([for (final c in courses) optional('/api/learning/courses/${c['id']}/gradebook')])).indexed) {
      final d = obj(g?['data']);
      final list = objs(d['assignments']);
      for (final (i, a) in list.indexed) {
        if (a['has_rubric'] != true) continue;
        for (final s in objs(d['students'])) {
          final cells = objs(s['cells']);
          if (i < cells.length && cells[i]['status'] != 'graded') rubric.add({'a': a, 's': s, 'course': str(courses[ci]['title'])});
        }
      }
    }
    return _Queue(review, rubric, subs.where((s) => s['score'] == null).toList(), subs.where((s) => s['score'] != null).length);
  }

  @override
  Widget build(BuildContext context) {
    return Loader<_Queue>(
      key: _key,
      load: _load,
      builder: (context, q, _) => ListView(padding: const EdgeInsets.all(16), children: [
        Semantics(header: true, child: Text('Grading queue', style: Theme.of(context).textTheme.titleLarge)),
        Text('${_plural(q.reviews.length, 'quiz', 'quizzes')} to review · ${_plural(q.rubric.length, 'rubric task')} · ${_plural(q.handIns.length, 'hand-in')} to grade · ${q.graded} graded',
            style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        SectionCard(title: 'Quizzes to review', children: [
          if (q.reviews.isEmpty) const EmptyState('No open answers waiting.'),
          for (final x in q.reviews)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${x['display_name']} · ${x['title']}', style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text('${x['course']} · attempt ${integer(x['attempt_no'])} · ${ago(date(x['submitted_at']))}${x['late'] == true ? ' · late' : ''}'),
              trailing: FilledButton(
                onPressed: () async {
                  await _push(context, QuizReviewScreen(attemptId: str(x['id'])));
                  _reload();
                },
                child: Text('Review', semanticsLabel: 'Review ${x['display_name']}: ${x['title']}'),
              ),
            ),
        ]),
        SectionCard(title: 'Rubric grading', children: [
          if (q.rubric.isEmpty) const EmptyState('No rubric work waiting.'),
          for (final t in q.rubric.take(30))
            () {
              final a = obj(t['a']), s = obj(t['s']);
              return ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${s['name']} · ${a['title']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${t['course']}${a['due_at'] != null ? ' · due ${fmtDay(date(a['due_at']))}' : ''}'),
                trailing: OutlinedButton(
                  onPressed: () async {
                    await _push(context, RubricScreen(assignmentId: str(a['id']), studentId: str(s['id']), name: str(s['name'])));
                    _reload();
                  },
                  child: Text('Grade', semanticsLabel: 'Grade ${s['name']}: ${a['title']}'),
                ),
              );
            }(),
        ]),
        Semantics(header: true, child: Text('Hand-ins', style: Theme.of(context).textTheme.titleMedium)),
        if (q.handIns.isEmpty) const SectionCard(children: [EmptyState('All caught up. Nothing to grade.')]),
        for (final s in q.handIns) _HandInCard(s, key: ValueKey(s['id']), onGraded: _reload),
      ]),
    );
  }
}

class _HandInCard extends StatefulWidget {
  const _HandInCard(this.s, {super.key, required this.onGraded});
  final Json s;
  final VoidCallback onGraded;

  @override
  State<_HandInCard> createState() => _HandInCardState();
}

class _HandInCardState extends State<_HandInCard> {
  final _score = TextEditingController(), _feedback = TextEditingController();

  @override
  void dispose() {
    _score.dispose();
    _feedback.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final s = widget.s, a = obj(s['_assignment']);
    final name = str(s['display_name']);
    return SectionCard(title: name, children: [
      Text('${str(a['title'])} · submitted ${ago(date(s['submitted_at']))}', style: Theme.of(context).textTheme.bodySmall),
      Padding(padding: const EdgeInsets.symmetric(vertical: 8), child: Text(str(s['response_text'], '(no text)'))),
      TextField(controller: _score, keyboardType: TextInputType.number, decoration: InputDecoration(labelText: 'Score for ${firstName(name)} (0–100)')),
      TextField(controller: _feedback, maxLength: 4000, minLines: 2, maxLines: 6, decoration: const InputDecoration(labelText: 'Feedback', counterText: '')),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: () async {
          final score = num.tryParse(_score.text.trim());
          if (score == null || score < 0 || score > 100) return toast(context, 'Enter a score from 0 to 100.');
          try {
            await AppScope.read(context).api.post('/api/assignments/${a['id']}/submissions/${s['id']}/grade', {'score': score, 'feedback': _feedback.text.trim()});
            if (!context.mounted) return;
            toast(context, 'Graded ${firstName(name)}');
            widget.onGraded();
          } on ApiException {
            if (context.mounted) toast(context, 'Couldn\'t save that grade.');
          }
        },
        child: Text('Save grade', semanticsLabel: 'Save grade for $name'),
      ),
    ]);
  }
}

/// Scoring a quiz attempt's open answers and returning it to the learner.
class QuizReviewScreen extends StatefulWidget {
  const QuizReviewScreen({super.key, required this.attemptId});
  final String attemptId;

  @override
  State<QuizReviewScreen> createState() => _QuizReviewScreenState();
}

class _QuizReviewScreenState extends State<QuizReviewScreen> {
  final Map<String, TextEditingController> _points = {}, _comments = {};

  @override
  void dispose() {
    for (final c in [..._points.values, ..._comments.values]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _submit(List<Json> items) async {
    final scores = <Json>[];
    for (final it in items) {
      final id = str(it['id']);
      final p = _points[id]?.text.trim(), c = _comments[id]!.text.trim();
      if (_points.containsKey(id)) {
        final v = num.tryParse(p ?? '');
        if (v == null || v < 0 || v > (number(it['points']) ?? 0)) return toast(context, 'Give points for every open answer (question ${it['seq']}).');
        scores.add({'itemId': id, 'points': v, if (c.isNotEmpty) 'comment': c});
      } else if (c.isNotEmpty) {
        scores.add({'itemId': id, 'comment': c});
      }
    }
    try {
      await AppScope.read(context).api.post('/api/learning/attempts/${widget.attemptId}/review', {'scores': scores});
      if (!mounted) return;
      toast(context, 'Returned to the learner');
      Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'items_still_need_points' ? 'Give points for every open answer.' : 'Couldn\'t save the review.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Review quiz')),
      body: Loader<Json>(
        load: () async => obj((await app.api.get('/api/learning/attempts/${widget.attemptId}'))['data']),
        builder: (context, a, _) {
          final items = objs(a['items']);
          final extra = integer(a['extraTimePct']);
          return ListView(padding: const EdgeInsets.all(16), children: [
            Semantics(header: true, child: Text(str(a['title']), style: Theme.of(context).textTheme.titleLarge)),
            Text('Attempt ${integer(a['attemptNo'])}${a['late'] == true ? ' · late' : ''}${extra > 0 ? ' · had +$extra% time' : ''}', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            for (final it in items)
              () {
                final q = QuizItem.fromJson(it);
                final open = it['autoCorrect'] == null;
                if (open) _points.putIfAbsent(q.id, () => TextEditingController(text: q.earned == null ? '' : pts(q.earned)));
                _comments.putIfAbsent(q.id, TextEditingController.new);
                final given = q.kind == 'mc' ? (int.tryParse(q.response) != null && int.parse(q.response) < q.choices.length ? q.choices[int.parse(q.response)] : '') : q.response;
                final key = q.answerKey == null ? null : (q.keyText?.isNotEmpty ?? false) ? q.keyText : '(teacher judgement)';
                return SectionCard(children: [
                  Text('${q.seq}. ${q.prompt}', style: Theme.of(context).textTheme.titleSmall),
                  const SizedBox(height: 6),
                  Text.rich(TextSpan(children: [const TextSpan(text: 'Answer given: ', style: TextStyle(fontWeight: FontWeight.w700)), TextSpan(text: given.isEmpty ? '(blank)' : given)])),
                  if (key != null) Text('Key: $key', style: Theme.of(context).textTheme.bodySmall),
                  if (open)
                    TextField(
                      controller: _points[q.id],
                      keyboardType: const TextInputType.numberWithOptions(decimal: true),
                      decoration: InputDecoration(labelText: 'Points for question ${q.seq} (0–${pts(q.points)})'),
                    )
                  else
                    Text('Auto-scored: ${pts(q.earned)}/${pts(q.points)}'),
                  TextField(controller: _comments[q.id], maxLength: 1000, minLines: 1, maxLines: 4, decoration: InputDecoration(labelText: 'Comment on question ${q.seq} (optional)', counterText: '')),
                ]);
              }(),
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
              onPressed: () => _submit(items),
              child: const Text('Return to learner'),
            ),
          ]);
        },
      ),
    );
  }
}

/// Grading classwork against its rubric (POST /api/learning/assignments/:id/grade).
class RubricScreen extends StatefulWidget {
  const RubricScreen({super.key, required this.assignmentId, required this.studentId, required this.name});
  final String assignmentId, studentId, name;

  @override
  State<RubricScreen> createState() => _RubricScreenState();
}

class _RubricScreenState extends State<RubricScreen> {
  final Map<String, num> _picked = {};
  final _feedback = TextEditingController();

  @override
  void dispose() {
    _feedback.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: Text(widget.name)),
      body: Loader<Json>(
        load: () async => obj((await app.api.get('/api/learning/assignments/${widget.assignmentId}'))['data']),
        builder: (context, a, _) {
          final rubric = objs(a['rubric']);
          final sub = objs(a['submissions']).where((s) => s['student_id'] == widget.studentId).firstOrNull;
          return ListView(padding: const EdgeInsets.all(16), children: [
            Semantics(header: true, child: Text(str(a['title']), style: Theme.of(context).textTheme.titleLarge)),
            if (strOrNull(sub?['response_text'])?.isNotEmpty ?? false) SectionCard(title: 'Handed in', children: [Text(str(sub!['response_text']))]),
            for (final c in rubric)
              SectionCard(title: str(c['title']), children: [
                for (final l in objs(c['levels']))
                  RadioListTile<num>(
                    contentPadding: EdgeInsets.zero,
                    value: number(l['points']) ?? 0,
                    groupValue: _picked[str(c['id'])],
                    title: Text('${pts(number(l['points']))} · ${str(l['label'])}'),
                    onChanged: (v) => setState(() => _picked[str(c['id'])] = v!),
                  ),
              ]),
            TextField(controller: _feedback, maxLength: 4000, minLines: 3, maxLines: 8, decoration: const InputDecoration(labelText: 'Feedback for the learner and family')),
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
              onPressed: () async {
                if (rubric.any((c) => !_picked.containsKey(str(c['id'])))) return toast(context, 'Pick a level for every row.');
                try {
                  final r = await app.api.post('/api/learning/assignments/${widget.assignmentId}/grade', {
                    'studentId': widget.studentId,
                    'scores': [for (final c in rubric) {'criterionId': c['id'], 'points': _picked[str(c['id'])]}],
                    'feedback': _feedback.text.trim(),
                  });
                  if (!context.mounted) return;
                  final d = obj(r.data);
                  toast(context, 'Returned: ${pts(number(d['earned']))}/${pts(number(d['possible']))}');
                  Navigator.of(context).pop();
                } on ApiException {
                  if (context.mounted) toast(context, 'Couldn\'t save the rubric.');
                }
              },
              child: const Text('Return with rubric'),
            ),
          ]);
        },
      ),
    );
  }
}

/// Teacher's Christie tab: suggestions, class mastery by skill and tutoring sessions.
class CopilotScreen extends StatefulWidget {
  const CopilotScreen({super.key});

  @override
  State<CopilotScreen> createState() => _CopilotScreenState();
}

class _CopilotScreenState extends State<CopilotScreen> {
  Key _key = UniqueKey();

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<(Json, List<Json>)>(
      key: _key,
      load: () async {
        final r = await Future.wait([app.api.get('/api/christie/copilot'), app.api.get('/api/christie/review')]);
        return (obj(r[0]['data']), objs(r[1]['data']));
      },
      builder: (context, data, _) {
        final (d, sessions) = data;
        final suggestions = d['suggestions'] is List ? (d['suggestions'] as List).map((e) => '$e').toList() : const <String>[];
        final skills = objs(d['bySkill']);
        return ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(title: 'Christie copilot', children: [
            for (final s in suggestions) Padding(padding: const EdgeInsets.only(bottom: 6), child: Text('• $s')),
            if (strOrNull(d['note']) != null) Text(str(d['note']), style: Theme.of(context).textTheme.bodySmall),
          ]),
          SectionCard(title: 'Class mastery by skill', children: [
            if (skills.isEmpty) const EmptyState('No practice data yet.'),
            for (final k in skills) ...[
              Row(children: [
                Expanded(child: Text(str(k['title']))),
                Text('${integer(k['mastered'])}/${integer(k['learners'])} mastered', style: Theme.of(context).textTheme.bodySmall),
              ]),
              MasteryBar(integer(k['avg_mastery']), '${k['title']}: class average ${integer(k['avg_mastery'])}%'),
            ],
          ]),
          SectionCard(title: 'Tutoring sessions', children: [
            if (sessions.isEmpty) const EmptyState('No sessions yet.'),
            for (final x in sessions)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${x['student_name']} · ${x['skill_title']}', style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${integer(x['solved'])} solved · ${integer(x['hints'])} hints · ${ago(date(x['last_activity_at']))}'),
                trailing: x['needs_adult'] == true && x['reviewed_at'] == null
                    ? const StatusChip('absent', text: 'Asked for an adult')
                    : x['reviewed_at'] != null
                        ? const StatusChip('present', text: 'Reviewed')
                        : const Icon(Icons.chevron_right),
                onTap: () async {
                  await _push(context, SessionReviewScreen(sessionId: str(x['id'])));
                  setState(() => _key = UniqueKey());
                },
              ),
          ]),
        ]);
      },
    );
  }
}

/// Reading a learner's Christie conversation and marking it reviewed.
class SessionReviewScreen extends StatelessWidget {
  const SessionReviewScreen({super.key, required this.sessionId});
  final String sessionId;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Conversation')),
      body: Loader<Json>(
        load: () async => obj((await app.api.get('/api/christie/sessions/$sessionId'))['data']),
        builder: (context, s, _) => ListView(padding: const EdgeInsets.all(16), children: [
          Semantics(header: true, child: Text('${str(s['studentName'])} · ${str(obj(s['skill'])['title'])}', style: Theme.of(context).textTheme.titleLarge)),
          Text('Mastery ${(number(s['mastery']) ?? 0).round()}%', style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 8),
          for (final t in objs(s['turns']))
            Align(
              alignment: t['speaker'] == 'student' ? Alignment.centerRight : Alignment.centerLeft,
              child: Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.all(12),
                constraints: const BoxConstraints(maxWidth: 520),
                decoration: BoxDecoration(color: t['speaker'] == 'student' ? scheme.primaryContainer : scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(14)),
                child: Semantics(
                  label: '${t['speaker'] == 'student' ? 'Student' : 'Christie'}: ${t['text']}',
                  excludeSemantics: true,
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(str(t['text'])),
                    Text('${str(t['kind'])} · ${fmtTime(date(t['at']))}', style: Theme.of(context).textTheme.bodySmall),
                  ]),
                ),
              ),
            ),
          if (s['reviewedAt'] != null)
            Text('Reviewed ${ago(date(s['reviewedAt']))}')
          else
            FilledButton(
              style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
              onPressed: () async {
                try {
                  await app.api.post('/api/christie/sessions/$sessionId/review');
                  if (!context.mounted) return;
                  toast(context, 'Marked reviewed');
                  Navigator.of(context).pop();
                } on ApiException {
                  if (context.mounted) toast(context, 'Couldn\'t mark it reviewed.');
                }
              },
              child: const Text('Mark reviewed'),
            ),
        ]),
      ),
    );
  }
}

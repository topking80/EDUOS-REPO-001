import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'learner_screens.dart';
import 'teacher_screens.dart';

const _kindText = {'quiz': 'Quiz', 'work': 'Classwork'};
const _workStatus = {'not_started': 'Not started', 'in_progress': 'In progress', 'needs_review': 'With your teacher', 'graded': 'Graded', 'submitted': 'Handed in'};
const _retake = {'highest': 'your best score counts', 'latest': 'your last score counts', 'average': 'your scores are averaged'};

String _levelTone(String level) => switch (level) { 'mastered' => 'present', 'developing' => 'current', 'emerging' => 'expected', _ => 'none' };

Widget levelChip(String level, [String extra = '']) => StatusChip(_levelTone(level), text: '${levelText[level] ?? level}$extra');

Future<void> _push(BuildContext context, Widget screen) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));

/// Learner Courses tab: my courses with grade and standards mastered.
class LearnerCoursesScreen extends StatelessWidget {
  const LearnerCoursesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<List<LearnerCourse>>(
      load: () async => objs(obj((await app.api.get('/api/learning/courses'))['data'])['courses']).map(LearnerCourse.fromJson).toList(),
      builder: (context, courses, _) => ListView(padding: const EdgeInsets.all(16), children: [
        Semantics(header: true, child: Text('My courses', style: Theme.of(context).textTheme.titleLarge)),
        const SizedBox(height: 8),
        if (courses.isEmpty) const EmptyState('You\'re not in any courses yet.'),
        for (final c in courses)
          SectionCard(children: [
            Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(c.title, style: Theme.of(context).textTheme.titleMedium),
                  Text('${c.teacher} · ${c.term}', style: Theme.of(context).textTheme.bodySmall),
                ]),
              ),
              Semantics(
                label: 'Course grade ${c.grade.text}',
                excludeSemantics: true,
                child: Text(c.grade.letter ?? '–', style: Theme.of(context).textTheme.headlineSmall),
              ),
            ]),
            MasteryBar(c.mastery.average, '${c.title}: ${c.mastery.mastered} of ${c.mastery.total} standards mastered'),
            Text('${c.mastery.mastered} of ${c.mastery.total} standards mastered', style: Theme.of(context).textTheme.bodySmall),
            if (c.next != null) Text('Next: ${c.next!.title}${c.next!.dueAt != null ? ' · due ${fmtDay(c.next!.dueAt)}' : ''}'),
            const SizedBox(height: 8),
            FilledButton(onPressed: () => _push(context, CourseScreen(courseId: c.id, title: c.title)), child: Text('Open course', semanticsLabel: 'Open course: ${c.title}')),
          ]),
      ]),
    );
  }
}

/// One course: grade, standards, units and lessons, assignments and quizzes.
class CourseScreen extends StatelessWidget {
  const CourseScreen({super.key, required this.courseId, required this.title});
  final String courseId, title;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: Text(title)),
      body: Loader<CourseDetail>(
        load: () async => CourseDetail.fromJson(obj((await app.api.get('/api/learning/courses/$courseId'))['data'])),
        builder: (context, c, reload) => ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(children: [
            Text('${c.subject} · Grade ${c.gradeLevel} · ${c.term} · ${c.teacher}', style: Theme.of(context).textTheme.bodySmall),
            Semantics(header: true, child: Text(c.title, style: Theme.of(context).textTheme.titleLarge)),
            if (c.hasLearner) Text('Grade so far: ${c.grade.text} · ${c.mastery.mastered} of ${c.mastery.total} standards mastered'),
          ]),
          if (c.hasLearner && c.standards.isNotEmpty)
            SectionCard(title: 'Standards', children: [
              for (final s in c.standards)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(s.code, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text(s.description),
                  trailing: levelChip(s.level, s.mastery != null ? ' ${s.mastery}%' : ''),
                ),
            ]),
          for (final u in c.units)
            SectionCard(title: 'Unit ${u.seq}: ${u.title}', children: [
              if (u.summary != null) Text(u.summary!, style: Theme.of(context).textTheme.bodySmall),
              for (final l in u.lessons)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(l.title),
                  subtitle: Text([l.standards.join(', '), if (l.sources > 0) '${l.sources} primary source${l.sources > 1 ? 's' : ''}'].where((x) => x.isNotEmpty).join(' · ')),
                  trailing: c.canManage ? StatusChip(l.approved ? 'present' : 'expected', text: l.approved ? 'Approved' : 'Needs approval') : const Icon(Icons.chevron_right),
                  onTap: () => _push(context, LessonScreen(lessonId: l.id)),
                ),
            ]),
          SectionCard(title: 'Assignments & quizzes', children: [
            if (c.assignments.isEmpty) const EmptyState('Nothing assigned yet.'),
            for (final a in c.assignments) AssignmentTile(a, onReturn: reload),
          ]),
          if (c.canManage && AppScope.of(context).me?.role != 'superintendent') AccommodationsCard(courseId: c.id),
        ]),
      ),
    );
  }
}

class AssignmentTile extends StatelessWidget {
  const AssignmentTile(this.a, {super.key, this.onReturn});
  final AssignmentRef a;
  final Future<void> Function()? onReturn;

  @override
  Widget build(BuildContext context) {
    final m = a.mine;
    final details = [
      _kindText[a.kind] ?? a.kind,
      if (a.points > 0) '${pts(a.points)} pts',
      if (a.dueAt != null) 'due ${fmtDay(a.dueAt)}',
      if (a.timeLimit != null) '${a.timeLimit} min',
    ].join(' · ');
    return ListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(a.title),
      subtitle: Text(details),
      trailing: m == null
          ? null
          : m.missing
              ? const StatusChip('absent', text: 'Missing')
              : m.status == 'graded'
                  ? StatusChip('present', text: '${pts(m.earned)}/${pts(a.points)}')
                  : StatusChip('expected', text: _workStatus[m.status] ?? m.status),
      onTap: () async {
        await _push(context, AssignmentScreen(assignmentId: a.id));
        await onReturn?.call();
      },
    );
  }
}

Future<void> _openSource(BuildContext context, String url) async {
  final uri = Uri.tryParse(url);
  if (uri == null || !(uri.scheme == 'https' || uri.scheme == 'http') || !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
    if (context.mounted) toast(context, 'Couldn\'t open that link.');
  }
}

/// A lesson: goal, text, standards and my mastery, primary sources, practice and work.
class LessonScreen extends StatelessWidget {
  const LessonScreen({super.key, required this.lessonId});
  final String lessonId;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Lesson')),
      body: Loader<LessonDetail>(
        load: () async => LessonDetail.fromJson(obj((await app.api.get('/api/learning/lessons/$lessonId'))['data'])),
        builder: (context, l, reload) => ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(children: [
            Text('${l.course} · ${l.unit}', style: Theme.of(context).textTheme.bodySmall),
            Semantics(header: true, child: Text(l.title, style: Theme.of(context).textTheme.titleLarge)),
            const SizedBox(height: 8),
            Text.rich(TextSpan(children: [const TextSpan(text: 'Goal: ', style: TextStyle(fontWeight: FontWeight.w700)), TextSpan(text: l.objective)])),
            const SizedBox(height: 8),
            Wrap(spacing: 6, children: [for (final s in l.standards) Chip(label: Text(s.code))]),
            const SizedBox(height: 8),
            for (final p in l.content.split(RegExp(r'\n+')).where((p) => p.trim().isNotEmpty))
              Padding(padding: const EdgeInsets.only(bottom: 10), child: SelectableText(p, style: Theme.of(context).textTheme.bodyLarge)),
          ]),
          if (l.mastery.isNotEmpty)
            SectionCard(title: 'My mastery here', children: [
              for (final s in l.standards)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text(s.code),
                  trailing: l.mastery[s.id] != null ? levelChip(l.mastery[s.id]!.level, ' ${l.mastery[s.id]!.mastery}%') : levelChip('not_started'),
                ),
            ]),
          for (final s in l.sources)
            SectionCard(children: [
              Text('Primary source · ${s.kind}${s.date != null ? ' · ${s.date}' : ''}', style: Theme.of(context).textTheme.bodySmall),
              Text(s.title, style: Theme.of(context).textTheme.titleMedium),
              if (s.creator != null) Text('By ${s.creator}'),
              if (s.excerpt != null)
                Container(
                  margin: const EdgeInsets.symmetric(vertical: 8),
                  padding: const EdgeInsets.only(left: 12),
                  decoration: BoxDecoration(border: Border(left: BorderSide(color: Theme.of(context).colorScheme.outline, width: 3))),
                  child: Text(s.excerpt!, style: const TextStyle(fontStyle: FontStyle.italic)),
                ),
              Text(s.description),
              if (s.prompts.isNotEmpty) ...[
                const SizedBox(height: 8),
                Text('Think about it', style: Theme.of(context).textTheme.titleSmall),
                for (final (i, p) in s.prompts.indexed) Text('${i + 1}. $p'),
              ],
              const SizedBox(height: 8),
              Text('Rights: ${s.rights}', style: Theme.of(context).textTheme.bodySmall),
              OutlinedButton.icon(
                icon: const Icon(Icons.open_in_new),
                label: Text('See it at the ${s.archive}'),
                onPressed: () => _openSource(context, s.url),
              ),
            ]),
          if (l.skills.isNotEmpty)
            SectionCard(title: 'Practice', children: [
              for (final k in l.skills)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: FilledButton.icon(
                    icon: const Icon(Icons.auto_awesome),
                    label: Text('Practice “${k.title}” with Christie'),
                    onPressed: () => startSkill(context, k.id),
                  ),
                ),
              Text('Christie gives hints from this approved lesson, not answers.', style: Theme.of(context).textTheme.bodySmall),
            ]),
          if (l.assignments.isNotEmpty)
            SectionCard(title: 'Work for this lesson', children: [for (final a in l.assignments) AssignmentTile(a, onReturn: reload)]),
        ]),
      ),
    );
  }
}

/// A quiz (rules, start/resume/retake, my attempts) or classwork (status, rubric, feedback).
class AssignmentScreen extends StatelessWidget {
  const AssignmentScreen({super.key, required this.assignmentId});
  final String assignmentId;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Assignment')),
      body: Loader<AssignmentDetail>(
        load: () async => AssignmentDetail.fromJson(obj((await app.api.get('/api/learning/assignments/$assignmentId'))['data'])),
        builder: (context, a, reload) {
          final head = SectionCard(children: [
            Text('${_kindText[a.kind] ?? a.kind} · ${pts(a.points)} points${a.standards.isNotEmpty ? ' · ${a.standards.join(', ')}' : ''}',
                style: Theme.of(context).textTheme.bodySmall),
            Semantics(header: true, child: Text(a.title, style: Theme.of(context).textTheme.titleLarge)),
            if (a.instructions != null && a.instructions!.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Text(a.instructions!)),
            if (a.dueAt != null) Text('Due ${fmtDay(a.dueAt)}'),
          ]);
          if (a.canManage) return ListView(padding: const EdgeInsets.all(16), children: [head, StaffSubmissions(a, onReturn: reload)]);
          if (a.kind != 'quiz') return ListView(padding: const EdgeInsets.all(16), children: [head, _WorkResult(a)]);
          final open = a.open;
          final canStart = (open != null || a.left > 0) && a.status == 'published';
          return ListView(padding: const EdgeInsets.all(16), children: [
            head,
            SectionCard(title: 'Before you start', children: [
              Text('• ${a.itemCount} questions'),
              Text(a.timeLimit != null
                  ? '• ${a.effectiveMinutes ?? a.timeLimit} minutes${a.extraTimePct > 0 ? ' (includes your +${a.extraTimePct}% extra time)' : ''}'
                  : '• No time limit'),
              Text('• ${a.maxAttempts} attempt${a.maxAttempts == 1 ? '' : 's'} · ${_retake[a.retakePolicy] ?? a.retakePolicy}'),
              if (a.readAloud) const Text('• Read-aloud is on: your device\'s screen reader (TalkBack or VoiceOver) reads each question.'),
              const SizedBox(height: 12),
              if (canStart)
                FilledButton(
                  style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                  onPressed: () async {
                    try {
                      final r = await app.api.post('/api/learning/quizzes/${a.id}/attempts');
                      final id = str(obj(obj(r.data)['attempt'])['id']);
                      if (!context.mounted) return;
                      await _push(context, AttemptScreen(attemptId: id));
                      await reload();
                    } on ApiException catch (e) {
                      if (context.mounted) {
                        toast(context, switch (e.error) {
                          'no_attempts_left' => 'No attempts left.',
                          'quiz_past_due' => 'This quiz is past due.',
                          'not_enrolled' => 'You\'re not in this course.',
                          _ => e.isOffline ? 'Quizzes need a connection. Try again when you\'re online.' : 'Couldn\'t start the quiz.',
                        });
                      }
                    }
                  },
                  child: Text(open != null ? 'Resume quiz' : a.attempts.isNotEmpty ? 'Retake (${a.left} left)' : 'Start quiz'),
                ),
            ]),
            if (a.attempts.isNotEmpty)
              SectionCard(title: 'My attempts', children: [
                for (final x in a.attempts)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text('Attempt ${x.no}${x.late ? ' · late' : ''}'),
                    trailing: switch (x.status) {
                      'needs_review' => const StatusChip('expected', text: 'With your teacher'),
                      'in_progress' => const StatusChip('current', text: 'In progress'),
                      _ => StatusChip('present', text: '${pts(x.total)}/${pts(x.possible)}'),
                    },
                    onTap: x.status == 'in_progress'
                        ? null
                        : () async {
                            await _push(context, AttemptScreen(attemptId: x.id));
                            await reload();
                          },
                  ),
              ]),
          ]);
        },
      ),
    );
  }
}

class _WorkResult extends StatelessWidget {
  const _WorkResult(this.a);
  final AssignmentDetail a;

  @override
  Widget build(BuildContext context) {
    final s = a.submission;
    final rubric = s == null ? const <Json>[] : objs(s['rubric_scores']);
    if (s != null && (rubric.isNotEmpty || s['feedback'] != null || s['returned_at'] != null)) {
      return SectionCard(title: rubric.isNotEmpty ? 'Rubric: ${pts(number(s['points_earned']))}/${pts(a.points)}' : 'Score: ${pts(number(s['points_earned']))}/${pts(a.points)}', children: [
        for (final r in rubric)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            title: Text(str(r['title'])),
            subtitle: Text(str(r['label'])),
            trailing: Text('${pts(number(r['points']))}/${pts(number(r['max']))}'),
          ),
        if (strOrNull(s['feedback'])?.isNotEmpty ?? false)
          Text.rich(TextSpan(children: [const TextSpan(text: 'Teacher: ', style: TextStyle(fontWeight: FontWeight.w700)), TextSpan(text: str(s['feedback']))])),
      ]);
    }
    return SectionCard(children: [
      EmptyState(s == null
          ? 'Not handed in yet.'
          : boolean(s['graded'])
              ? 'Graded: your teacher will return it soon.'
              : 'Handed in. Waiting for your teacher.'),
    ]);
  }
}

/// Taking a quiz (answers save as you go, timer with warnings) or its result.
class AttemptScreen extends StatefulWidget {
  const AttemptScreen({super.key, required this.attemptId});
  final String attemptId;

  @override
  State<AttemptScreen> createState() => _AttemptScreenState();
}

class _AttemptScreenState extends State<AttemptScreen> {
  QuizAttempt? _a;
  Object? _error;
  bool _busy = false;
  Timer? _timer;
  DateTime? _end;
  int? _left;
  final Map<String, TextEditingController> _text = {};
  final Map<String, String> _choice = {};
  final Map<String, String> _saved = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _timer?.cancel();
    for (final c in _text.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final a = QuizAttempt.fromJson(obj((await AppScope.read(context).api.get('/api/learning/attempts/${widget.attemptId}'))['data']));
      if (!mounted) return;
      _timer?.cancel();
      for (final c in _text.values) {
        c.dispose();
      }
      _text.clear();
      _choice.clear();
      _saved.clear();
      for (final it in a.items) {
        _saved[it.id] = it.response;
        if (it.kind == 'mc') {
          _choice[it.id] = it.response;
        } else {
          _text[it.id] = TextEditingController(text: it.response);
        }
      }
      setState(() => _a = a);
      if (a.live && (a.secondsLeft != null || a.deadlineAt != null)) {
        // Count down from the server's secondsLeft so a wrong device clock doesn't matter.
        _end = DateTime.now().add(Duration(seconds: a.secondsLeft ?? a.deadlineAt!.difference(DateTime.now()).inSeconds));
        _tick();
        _timer = Timer.periodic(const Duration(seconds: 1), (_) => _tick());
      }
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  void _tick() {
    final s = _end!.difference(DateTime.now()).inSeconds.clamp(0, 1 << 30);
    if (s != _left && (s == 300 || s == 60)) SemanticsService.announce('${s ~/ 60} minute${s > 60 ? 's' : ''} left.', TextDirection.ltr);
    if (s == 0 && _left != 0) {
      SemanticsService.announce('Time is up. Submit your quiz now.', TextDirection.ltr);
      _timer?.cancel();
    }
    if (mounted) setState(() => _left = s);
  }

  final Map<String, ({String value, Future<bool> future})> _inFlight = {};

  /// Saves one answer; a save of the same value already on its way is reused.
  Future<bool> _save(String itemId, String value) {
    if (_saved[itemId] == value) return Future.value(true);
    final pending = _inFlight[itemId];
    if (pending != null && pending.value == value) return pending.future;
    final future = _put(itemId, value).whenComplete(() {
      if (_inFlight[itemId]?.value == value) _inFlight.remove(itemId);
    });
    _inFlight[itemId] = (value: value, future: future);
    return future;
  }

  Future<bool> _put(String itemId, String value) async {
    try {
      await AppScope.read(context).api.put('/api/learning/attempts/${widget.attemptId}/responses/$itemId', {'response': value});
      _saved[itemId] = value;
      return true;
    } on ApiException catch (e) {
      if (mounted) {
        toast(context, switch (e) {
          ApiException(error: 'time_up') => 'Time is up. Submit your quiz.',
          ApiException(isOffline: true) => 'You\'re offline, so that answer isn\'t saved yet. Reconnect before you submit.',
          _ => 'Couldn\'t save that answer.',
        });
      }
      return false;
    }
  }

  Future<void> _submit() async {
    FocusScope.of(context).unfocus();
    setState(() => _busy = true);
    try {
      for (final MapEntry(key: id, value: c) in _text.entries) {
        if (!await _save(id, c.text.trim())) return;
      }
      if (!mounted) return;
      final ok = await confirm(context, title: 'Submit your quiz?', text: 'You can\'t change answers after you submit.', action: 'Submit');
      if (!ok || !mounted) return;
      await AppScope.read(context).api.post('/api/learning/attempts/${widget.attemptId}/submit');
      if (!mounted) return;
      toast(context, 'Submitted');
      await _load();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.isOffline ? 'You\'re offline. Reconnect, then submit.' : 'Couldn\'t submit. Try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String get _clock {
    final s = _left ?? 0;
    return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
  }

  Widget _item(QuizItem it, bool live) {
    final theme = Theme.of(context);
    final result = live
        ? null
        : it.needsTeacher
            ? const StatusChip('expected', text: 'Teacher will score')
            : it.earned == null
                ? null
                : StatusChip(it.earned! >= it.points ? 'present' : it.earned! > 0 ? 'expected' : 'absent', text: '${pts(it.earned)}/${pts(it.points)}');
    final src = it.source;
    return SectionCard(children: [
      Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: Text('${it.seq}. ${it.prompt}', style: theme.textTheme.titleSmall)),
        if (result != null) result,
      ]),
      if (src != null) ...[
        if (strOrNull(src['excerpt']) != null) Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: Text(str(src['excerpt']), style: const TextStyle(fontStyle: FontStyle.italic))),
        TextButton.icon(
          icon: const Icon(Icons.open_in_new),
          label: Text('${str(src['title'])} (${str(src['archive'])})'),
          onPressed: () => _openSource(context, str(src['url'])),
        ),
      ],
      const SizedBox(height: 6),
      if (it.kind == 'mc')
        for (final (i, c) in it.choices.indexed)
          RadioListTile<String>(
            contentPadding: EdgeInsets.zero,
            value: '$i',
            groupValue: _choice[it.id],
            title: Text(c),
            onChanged: live
                ? (v) {
                    if (v == null) return;
                    setState(() => _choice[it.id] = v);
                    _save(it.id, v);
                  }
                : null,
          )
      else
        Focus(
          onFocusChange: (has) {
            if (!has && live) _save(it.id, _text[it.id]!.text.trim());
          },
          child: TextField(
            controller: _text[it.id],
            enabled: live,
            keyboardType: it.kind == 'numeric' ? const TextInputType.numberWithOptions(decimal: true, signed: true) : TextInputType.multiline,
            maxLength: it.kind == 'numeric' ? 40 : 2000,
            minLines: it.kind == 'numeric' ? 1 : (it.kind == 'source' ? 4 : 2),
            maxLines: it.kind == 'numeric' ? 1 : 8,
            decoration: InputDecoration(labelText: it.kind == 'numeric' ? 'Your answer (a number or fraction)' : 'Your answer', counterText: ''),
          ),
        ),
      if (it.keyText != null) Text.rich(TextSpan(children: [const TextSpan(text: 'Answer: ', style: TextStyle(fontWeight: FontWeight.w700)), TextSpan(text: it.keyText)])),
      if (it.teacherComment != null)
        Text.rich(TextSpan(children: [const TextSpan(text: 'Teacher: ', style: TextStyle(fontWeight: FontWeight.w700)), TextSpan(text: it.teacherComment)])),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final a = _a;
    final theme = Theme.of(context);
    Widget body;
    if (_error != null) {
      body = ListView(padding: const EdgeInsets.all(16), children: [
        SectionCard(children: [const Text('Couldn\'t open this quiz.'), FilledButton(onPressed: _load, child: const Text('Retry'))]),
      ]);
    } else if (a == null) {
      body = const Center(child: CircularProgressIndicator());
    } else {
      final live = a.live;
      body = ListView(padding: const EdgeInsets.all(16), children: [
        if (live)
          SectionCard(children: [
            Semantics(
              liveRegion: false,
              label: _end == null ? 'No time limit' : 'Time left $_clock',
              excludeSemantics: true,
              child: Text(
                _end == null ? 'No time limit' : '⏱ $_clock left${a.extraTimePct > 0 ? ' (+${a.extraTimePct}% time)' : ''}',
                style: theme.textTheme.titleLarge?.copyWith(color: (_left ?? 999) <= 60 && _end != null ? theme.colorScheme.error : null),
              ),
            ),
            Text('Attempt ${a.attemptNo} of ${a.maxAttempts} · answers save as you go', style: theme.textTheme.bodySmall),
          ])
        else
          SectionCard(children: [
            Text('Attempt ${a.attemptNo} of ${a.maxAttempts}${a.late ? ' · submitted late' : ''}', style: theme.textTheme.bodySmall),
            Semantics(
              header: true,
              child: Text(a.status == 'needs_review' ? 'Submitted. Some answers are with your teacher.' : 'Score: ${pts(a.totalPoints)} / ${pts(a.possiblePoints)}',
                  style: theme.textTheme.titleLarge),
            ),
            if (a.status == 'needs_review') Text('Auto-scored so far: ${pts(a.autoPoints)} / ${pts(a.possiblePoints)}'),
            Text(a.answersShown ? 'Correct answers are shown because you have no attempts left.' : a.canRetake ? 'Correct answers appear after your last attempt.' : '',
                style: theme.textTheme.bodySmall),
          ]),
        for (final it in a.items) _item(it, live),
        if (live)
          FilledButton(
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
            onPressed: _busy ? null : _submit,
            child: const Text('Submit quiz'),
          )
        else if (a.canRetake)
          OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: Text('Retake (${a.maxAttempts - a.attemptsUsed} left)')),
      ]);
    }
    return Scaffold(appBar: AppBar(title: Text(a?.title ?? 'Quiz')), body: body);
  }
}

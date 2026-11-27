import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'courses_screen.dart';
import 'messages_screen.dart';
import 'student_schedule_screen.dart';

/// A mastery ring: percent in the middle, the label read by screen readers.
class MasteryRing extends StatelessWidget {
  const MasteryRing(this.percent, this.label, {super.key, this.size = 72});
  final int percent;
  final String label;
  final double size;

  @override
  Widget build(BuildContext context) => Semantics(
        label: '$label: $percent% mastery',
        excludeSemantics: true,
        child: SizedBox.square(
          dimension: size,
          child: Stack(alignment: Alignment.center, children: [
            SizedBox.expand(child: CircularProgressIndicator(value: percent / 100, strokeWidth: 8, backgroundColor: Theme.of(context).colorScheme.surfaceContainerHighest)),
            Text('$percent%', style: const TextStyle(fontWeight: FontWeight.w800)),
          ]),
        ),
      );
}

class MasteryBar extends StatelessWidget {
  const MasteryBar(this.percent, this.label, {super.key});
  final int percent;
  final String label;

  @override
  Widget build(BuildContext context) => Semantics(
        label: label,
        excludeSemantics: true,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: LinearProgressIndicator(value: percent.clamp(0, 100) / 100, minHeight: 8, borderRadius: BorderRadius.circular(4)),
        ),
      );
}

/// Starts (or resumes) Christie practice on a skill and opens the chat.
Future<void> startSkill(BuildContext context, String skillId) async {
  final app = AppScope.read(context);
  try {
    final r = await app.api.post('/api/christie/sessions', {'skillId': skillId});
    final id = str(obj(obj(r.data)['session'])['id']);
    if (!context.mounted) return;
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChristieChatScreen(sessionId: id)));
  } on ApiException catch (e) {
    if (!context.mounted) return;
    toast(context, switch (e) {
      ApiException(error: 'skill_has_no_items') => 'This skill has no practice yet.',
      ApiException(isOffline: true) => 'Christie needs a connection. Try again when you\'re online.',
      ApiException(status: 429) => 'Slow down a little and try again.',
      _ => 'Christie couldn\'t start. Try again.',
    });
  }
}

class _Home {
  const _Home({required this.path, required this.courses, required this.riders, required this.news, required this.young,
      this.today, this.loans = const [], this.clubs = const []});
  final LearningPath? path;
  final List<LearnerCourse> courses;
  final List<Rider> riders;
  final List<Announcement> news;
  final bool young;
  // Student app Phase D: today's schedule, books due soon, my clubs and teams.
  final Json? today;
  final List<Json> loans;
  final List<String> clubs;
}

const _todayKind = {'no_school': 'No school', 'early_release': 'Early release', 'late_start': 'Late start', 'modified': 'Modified day'};
const _todayStatus = {
  'adjusted': ('expected', 'New time today'),
  'changed': ('expected', 'Changed'),
  'cancelled': ('cancelled', 'Cancelled'),
  'no_school': ('absent', 'No school'),
};

/// "Today at school": built only from endpoints that return the learner's own
/// records. Attendance and meals wait for self-only APIs; the bus card below
/// stays event-based (boarding and stop check-ins), never location tracking.
class _TodayCard extends StatelessWidget {
  const _TodayCard(this.h, {required this.onWeek});
  final _Home h;
  final VoidCallback onWeek;

  @override
  Widget build(BuildContext context) {
    final day = h.today;
    final cal = day == null || day['calendar'] == null ? null : obj(day['calendar']);
    final classes = objs(day?['classes']), events = objs(day?['events']);
    final small = Theme.of(context).textTheme.bodySmall;
    return SectionCard(title: 'Today at school', children: [
      if (cal != null) Notice('${_todayKind[str(cal['kind'])] ?? str(cal['kind'])}: ${str(cal['label'])}'),
      if (day != null && classes.isEmpty && events.isEmpty)
        Text(cal?['kind'] == 'no_school' ? 'No school today.' : 'Nothing on your schedule today.', style: small),
      for (final k in classes)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text('${str(k['starts'])} ${str(k['title'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
                if (k['room'] != null) Text(str(k['room']), style: small),
                if (k['note'] != null) Text(str(k['note'])),
              ]),
            ),
            if (_todayStatus[str(k['status'])] case (final st, final label)) StatusChip(st, text: label),
          ]),
        ),
      for (final e in events)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Row(children: [
            Expanded(child: Text('${str(e['starts'])} ${str(e['title'])} · ${str(e['activity'])}', style: const TextStyle(fontWeight: FontWeight.w600))),
            if (e['status'] == 'cancelled') const StatusChip('cancelled', text: 'Cancelled'),
          ]),
        ),
      if (h.loans.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text('Library books', style: Theme.of(context).textTheme.titleSmall),
        for (final l in h.loans)
          Row(children: [
            Expanded(child: Text(str(l['title']))),
            StatusChip(l['overdue'] == true ? 'absent' : 'expected', text: l['overdue'] == true ? 'Overdue' : 'Due ${fmtDay(date(l['due_at']))}'),
          ]),
      ],
      if (h.clubs.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text('My clubs & teams', style: Theme.of(context).textTheme.titleSmall),
        Text(h.clubs.join(' · ')),
      ],
      Align(alignment: Alignment.centerLeft, child: TextButton(onPressed: onWeek, child: const Text('My week'))),
    ]);
  }
}

/// Learner Home: what to practise next, my courses, my bus and school news.
class LearnerHomeScreen extends StatelessWidget {
  const LearnerHomeScreen({super.key});

  Future<_Home> _load(BuildContext context) async {
    final api = AppScope.read(context).api;
    Future<Map<String, Object?>?> optional(String path) async {
      try {
        return await api.get(path);
      } on ApiException catch (e) {
        if (e.isUnauthorized || e.isOffline) rethrow;
        return null;
      }
    }

    final r = await Future.wait([
      optional('/api/christie/path'),
      optional('/api/learning/courses'),
      optional('/api/transport/today'),
      optional('/api/comms/announcements'),
      optional('/api/home'),
      optional('/api/learning/schedule?days=1'),
      optional('/api/library/my-loans'),
      optional('/api/activities'),
    ]);
    final days = objs(obj(r[5]?['data'])['days']);
    final soon = DateTime.now().add(const Duration(days: 3));
    final loans = objs(r[6]?['data']).where((l) => l['returned_at'] == null && (l['overdue'] == true || (date(l['due_at'])?.isBefore(soon) ?? false))).toList();
    return _Home(
      path: r[0] == null ? null : LearningPath.fromJson(obj(r[0]!['data'])),
      courses: objs(obj(r[1]?['data'])['courses']).map(LearnerCourse.fromJson).toList(),
      riders: objs(obj(r[2]?['data'])['riders']).map(Rider.fromJson).toList(),
      news: objs(r[3]?['data']).map(Announcement.fromJson).toList(),
      young: boolean(obj(r[4]?['data'])['youngLearner']),
      today: days.isEmpty ? null : days.first,
      loans: loans,
      clubs: objs(r[7]?['data']).where((a) => a['myStatus'] == 'active').map((a) => str(a['title'])).toList(),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Loader<_Home>(
      load: () => _load(context),
      builder: (context, h, reload) {
        final current = h.path?.current;
        final list = ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(children: [
            Row(children: [
              if (current != null) MasteryRing(current.mastery, current.title),
              if (current != null) const SizedBox(width: 16),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(current != null ? '${current.subject} · up next' : 'Learning path', style: Theme.of(context).textTheme.bodySmall),
                  Semantics(header: true, child: Text(current?.title ?? 'No practice assigned yet', style: Theme.of(context).textTheme.titleLarge)),
                  if (h.path != null) Text('${h.path!.mastered} of ${h.path!.skills.length} skills mastered', style: Theme.of(context).textTheme.bodySmall),
                ]),
              ),
            ]),
            if (current != null) ...[
              const SizedBox(height: 12),
              FilledButton.icon(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                icon: const Icon(Icons.auto_awesome),
                label: const Text('Practice with Christie'),
                onPressed: () async {
                  await startSkill(context, current.id);
                  await reload();
                },
              ),
            ],
          ]),
          if (h.today != null || h.loans.isNotEmpty || h.clubs.isNotEmpty)
            _TodayCard(h, onWeek: () => Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (_) => Scaffold(appBar: AppBar(title: const Text('My schedule')), body: const StudentScheduleScreen())))),
          if (h.courses.isNotEmpty)
            SectionCard(title: 'My courses', children: [
              for (final c in h.courses)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(c.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text(c.next != null ? 'Next: ${c.next!.title}${c.next!.dueAt != null ? ' · due ${fmtDay(c.next!.dueAt)}' : ''}' : 'All caught up'),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CourseScreen(courseId: c.id, title: c.title))),
                ),
            ]),
          if (h.riders.isNotEmpty)
            SectionCard(title: 'My bus', children: [
              for (final r in h.riders)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.directions_bus),
                  title: Text('${r.routeName}${r.busLabel.isNotEmpty ? ' · Bus ${r.busLabel}' : ''}'),
                  subtitle: Text('${r.direction == 'pm' ? 'Home' : 'To school'} · ${r.stopName}${r.stopTime != null ? ' at ${r.stopTime}' : ''}'),
                  trailing: StatusChip(r.status),
                ),
            ]),
          SectionCard(title: 'School news', children: [AnnouncementList(h.news.take(2).toList(), onChanged: reload)]),
        ]);
        // Younger learners get larger text, as on the web.
        if (!h.young) return list;
        final mq = MediaQuery.of(context);
        return MediaQuery(data: mq.copyWith(textScaler: TextScaler.linear(mq.textScaler.scale(1) * 1.15)), child: list);
      },
    );
  }
}

/// My learning path: skills by subject with mastery and a practice button.
class PathScreen extends StatelessWidget {
  const PathScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<LearningPath>(
      load: () async => LearningPath.fromJson(obj((await app.api.get('/api/christie/path'))['data'])),
      builder: (context, p, reload) {
        if (p.skills.isEmpty) return ListView(padding: const EdgeInsets.all(16), children: const [EmptyState('No skills on your path yet.')]);
        final bySubject = <String, List<PathSkill>>{};
        for (final s in p.skills) {
          bySubject.putIfAbsent(s.subject, () => []).add(s);
        }
        return ListView(padding: const EdgeInsets.all(16), children: [
          Semantics(header: true, child: Text('My learning path', style: Theme.of(context).textTheme.titleLarge)),
          Text('Grade ${p.grade}. Skills linked to a standard show your standard mastery. Others show a practice estimate, not a grade.',
              style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 8),
          for (final MapEntry(key: subject, value: list) in bySubject.entries)
            SectionCard(title: subject, children: [
              for (final s in list)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                    Row(children: [
                      Expanded(child: Text(s.title, style: const TextStyle(fontWeight: FontWeight.w600))),
                      StatusChip(s.state == 'mastered' ? 'present' : s.state == 'current' ? 'current' : 'expected',
                          text: s.state == 'mastered' ? 'Mastered' : s.state == 'current' ? 'Up next' : '${s.mastery}%'),
                    ]),
                    if (s.standardCode != null)
                      Text('${s.standardCode} · ${s.standardBasis ? 'standard mastery' : 'practice estimate'}', style: Theme.of(context).textTheme.bodySmall),
                    MasteryBar(s.mastery, '${s.title}: ${s.mastery}% mastery'),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: (s.state == 'current' ? FilledButton.new : OutlinedButton.new)(
                        onPressed: () async {
                          await startSkill(context, s.id);
                          await reload();
                        },
                        child: Text(s.state == 'mastered' ? 'Practice again' : 'Practice', semanticsLabel: '${s.state == 'mastered' ? 'Practice again' : 'Practice'}: ${s.title}'),
                      ),
                    ),
                  ]),
                ),
            ]),
        ]);
      },
    );
  }
}

const christieNotice = 'Christie only uses lessons your school approved and gives hints, not answers. Your teacher can read these chats. '
    'Don\'t type your full name, address or phone number.';

/// The Christie tab: continue the open session or start the next skill.
class ChristieTab extends StatelessWidget {
  const ChristieTab({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<LearningPath>(
      load: () async => LearningPath.fromJson(obj((await app.api.get('/api/christie/path'))['data'])),
      builder: (context, p, reload) {
        final current = p.skills.where((s) => s.state == 'current').firstOrNull;
        return ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(title: 'Christie, your practice buddy', children: [
            const Text('Christie gives hints and asks questions. You do the solving.'),
            const SizedBox(height: 12),
            if (p.activeSessionId != null)
              FilledButton.icon(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                icon: const Icon(Icons.chat_bubble_outline),
                label: const Text('Continue practice'),
                onPressed: () async {
                  await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ChristieChatScreen(sessionId: p.activeSessionId!)));
                  await reload();
                },
              )
            else if (current != null)
              FilledButton.icon(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                icon: const Icon(Icons.auto_awesome),
                label: Text('Start: ${current.title}'),
                onPressed: () async {
                  await startSkill(context, current.id);
                  await reload();
                },
              )
            else
              const EmptyState('Your teacher hasn\'t added practice yet.'),
          ]),
          const Notice(christieNotice),
        ]);
      },
    );
  }
}

/// A practice chat with Christie (GET/POST /api/christie/sessions/:id).
class ChristieChatScreen extends StatefulWidget {
  const ChristieChatScreen({super.key, required this.sessionId});
  final String sessionId;

  @override
  State<ChristieChatScreen> createState() => _ChristieChatScreenState();
}

class _ChristieChatScreenState extends State<ChristieChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  ChristieSession? _session;
  final List<ChristieTurn> _turns = [];
  String _masteryLine = '';
  Object? _error;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final s = ChristieSession.fromJson(obj((await AppScope.read(context).api.get('/api/christie/sessions/${widget.sessionId}'))['data']));
      if (!mounted) return;
      setState(() {
        _session = s;
        _turns
          ..clear()
          ..addAll(s.turns);
        _masteryLine = 'Mastery: ${s.mastery}%';
      });
      _toEnd();
    } catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  void _toEnd() => WidgetsBinding.instance.addPostFrameCallback((_) {
        if (_scroll.hasClients) _scroll.jumpTo(_scroll.position.maxScrollExtent);
      });

  Future<void> _send(String kind) async {
    final text = _input.text.trim();
    if (kind != 'skip' && text.isEmpty) return;
    final app = AppScope.read(context);
    setState(() {
      _busy = true;
      if (kind != 'skip') _turns.add(ChristieTurn(speaker: 'student', text: text, kind: kind));
      _input.clear();
    });
    _toEnd();
    try {
      final r = obj((await app.api.post('/api/christie/sessions/${widget.sessionId}/turns', {'kind': kind, 'text': text})).data);
      final replies = objs(r['replies']).map(ChristieTurn.fromJson).toList();
      final m = obj(r['mastery']);
      if (!mounted) return;
      setState(() {
        _turns.addAll(replies);
        if (m.isNotEmpty) _masteryLine = 'Mastery: ${(number(m['mastery']) ?? 0).round()}%${boolean(m['mastered']) ? ' · Mastered!' : ''}';
      });
      for (final t in replies) {
        SemanticsService.announce('Christie: ${t.text}', TextDirection.ltr);
      }
      _toEnd();
    } on ApiException catch (e) {
      if (mounted) {
        toast(context, switch (e) {
          ApiException(status: 429) => 'Slow down a little and try again.',
          ApiException(isOffline: true) => 'You\'re offline. Christie needs a connection.',
          _ => 'Christie didn\'t get that. Try again.',
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _done() async {
    try {
      await AppScope.read(context).api.post('/api/christie/sessions/${widget.sessionId}/end');
    } on ApiException {
      // Sessions also end on their own after inactivity.
    }
    if (mounted) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final s = _session;
    final scheme = Theme.of(context).colorScheme;
    return Scaffold(
      appBar: AppBar(
        title: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(s?.skillTitle ?? 'Christie'),
          if (s != null) Text(_masteryLine, style: Theme.of(context).textTheme.bodySmall),
        ]),
        actions: [TextButton(onPressed: _done, child: const Text('Done'))],
      ),
      body: _error != null
          ? ListView(padding: const EdgeInsets.all(16), children: [
              SectionCard(children: [
                const Text('Couldn\'t open this practice.'),
                FilledButton(onPressed: _load, child: const Text('Retry')),
              ]),
            ])
          : s == null
              ? const Center(child: CircularProgressIndicator())
              : Column(children: [
                  Expanded(
                    child: Semantics(
                      label: 'Conversation with Christie',
                      child: ListView(controller: _scroll, padding: const EdgeInsets.all(16), children: [
                        for (final t in _turns)
                          Align(
                            alignment: t.mine ? Alignment.centerRight : Alignment.centerLeft,
                            child: Container(
                              margin: const EdgeInsets.only(bottom: 8),
                              padding: const EdgeInsets.all(12),
                              constraints: const BoxConstraints(maxWidth: 520),
                              decoration: BoxDecoration(
                                color: t.mine ? scheme.primaryContainer : t.kind == 'item' ? scheme.tertiaryContainer : scheme.surfaceContainerHighest,
                                borderRadius: BorderRadius.circular(14),
                              ),
                              child: Semantics(
                                label: '${t.mine ? 'You said' : 'Christie'}: ${t.text}',
                                excludeSemantics: true,
                                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                  Text(t.text),
                                  if (t.kind == 'hint' && t.hintLevel != null) Text('Hint ${t.hintLevel}', style: Theme.of(context).textTheme.bodySmall),
                                  if (t.kind == 'item') Text('Practice problem', style: Theme.of(context).textTheme.bodySmall),
                                ]),
                              ),
                            ),
                          ),
                        const Notice(christieNotice),
                      ]),
                    ),
                  ),
                  SafeArea(
                    top: false,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        TextField(
                          controller: _input,
                          maxLength: 500,
                          textInputAction: TextInputAction.send,
                          onSubmitted: (v) => _send(RegExp(r'\?\s*$').hasMatch(v) ? 'question' : 'attempt'),
                          decoration: const InputDecoration(labelText: 'Your answer or question', counterText: ''),
                        ),
                        const SizedBox(height: 8),
                        Wrap(spacing: 8, runSpacing: 8, children: [
                          FilledButton.icon(onPressed: _busy ? null : () => _send('attempt'), icon: const Icon(Icons.check), label: const Text('Check answer')),
                          OutlinedButton(onPressed: _busy ? null : () => _send('question'), child: const Text('Ask Christie')),
                          TextButton(onPressed: _busy ? null : () => _send('skip'), child: const Text('Skip')),
                        ]),
                      ]),
                    ),
                  ),
                ]),
    );
  }
}

/// News from school (announcements). Messaging is for families and staff.
class NewsScreen extends StatelessWidget {
  const NewsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<List<Announcement>>(
      load: () async => objs((await app.api.get('/api/comms/announcements'))['data']).map(Announcement.fromJson).toList(),
      builder: (context, list, reload) => ListView(padding: const EdgeInsets.all(16), children: [
        SectionCard(title: 'News from school', children: [AnnouncementList(list, onChanged: reload)]),
        const Notice('Students can read school and class news here. Messaging is between families and staff.'),
      ]),
    );
  }
}

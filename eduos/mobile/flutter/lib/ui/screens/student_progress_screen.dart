import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'courses_screen.dart';

/// Student app Phase C: one place for grades, mastery, returned work and
/// feedback. Every number says what kind it is: an official final grade, a
/// current grade calculated from graded work, standards mastery from evidence,
/// or a practice estimate that isn't part of any grade. Ungraded and missing
/// work is listed but never counted as zero.
class StudentProgressScreen extends StatelessWidget {
  const StudentProgressScreen({super.key});

  static const _status = {
    'graded': ('present', 'Graded'),
    'submitted': ('expected', 'Turned in · waiting'),
    'needs_review': ('expected', 'Waiting for your teacher'),
    'in_progress': ('expected', 'Started'),
    'not_started': ('expected', 'Not started'),
  };
  static const _retake = {'highest': 'your best attempt counts', 'latest': 'your latest attempt counts', 'average': 'your attempts are averaged'};

  String _pts(Object? v) {
    final n = number(v);
    if (n == null) return '–';
    return n == n.roundToDouble() ? '${n.toInt()}' : '$n';
  }

  @override
  Widget build(BuildContext context) => Loader<Json>(
        load: () async => obj((await AppScope.read(context).api.get('/api/learning/progress'))['data']),
        builder: (context, p, reload) {
          final courses = objs(p['courses']), finals = objs(p['finalGrades']), practice = objs(p['practice']);
          final small = Theme.of(context).textTheme.bodySmall;
          return ListView(padding: const EdgeInsets.all(16), children: [
            const SectionCard(title: 'How to read this', children: [
              Text('Final grade: official, posted by the school at the end of a course. A correction shows what it replaced.'),
              SizedBox(height: 4),
              Text('Current grade: calculated from work that\'s been graded so far. It changes as more work is graded.'),
              SizedBox(height: 4),
              Text('Standards mastery: how securely each skill is shown across quizzes, rubrics and practice.'),
              SizedBox(height: 4),
              Text('Practice estimate: from practice with Christie only. It isn\'t part of any grade.'),
            ]),
            if (courses.isEmpty) const SectionCard(children: [EmptyState('No current courses.')]),
            for (final c in courses) _course(context, c, small),
            SectionCard(title: 'Final grades', children: [
              if (finals.isEmpty) const EmptyState('None yet.'),
              for (final f in finals)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${str(f['course'])}: ${str(f['letter'])} (${_pts(f['percent'])}%)', style: const TextStyle(fontWeight: FontWeight.w600)),
                    Text([str(f['term']), if (f['course_status'] == 'archived') 'past course', 'posted ${fmtDay(date(f['posted_at']))}'].where((x) => x.isNotEmpty).join(' · '), style: small),
                    if (f['supersedes'] != null)
                      Text('Corrected${f['replaced_letter'] != null ? ' from ${str(f['replaced_letter'])} (${_pts(f['replaced_percent'])}%)' : ''}${f['reason'] != null ? ': ${str(f['reason'])}' : ''}'),
                  ]),
                ),
            ]),
            if (practice.isNotEmpty)
              SectionCard(title: 'Practice estimates', children: [
                Text('From practice with Christie on skills that aren\'t tied to a standard. Not part of any grade.', style: small),
                for (final k in practice)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(str(k['title'])),
                    subtitle: Text('${str(k['subject'])} · ${integer(k['attempts'])} tries'),
                    trailing: Text(k['estimate'] == null ? '–' : 'about ${_pts(k['estimate'])}%'),
                  ),
              ]),
            const Notice('Only you, your family and school staff who teach or lead at your school can see this. Every view is logged.'),
          ]);
        },
      );

  Widget _course(BuildContext context, Json c, TextStyle? small) {
    final g = obj(c['grade']), n = obj(c['counts']), m = obj(c['mastery']), work = objs(c['work']);
    final pct = g['percent'];
    final counts = [
      '${integer(n['graded'])} graded',
      if (integer(n['waiting']) > 0) '${integer(n['waiting'])} waiting for grading',
      if (integer(n['inProgress']) > 0) '${integer(n['inProgress'])} started',
      if (integer(n['missing']) > 0) '${integer(n['missing'])} missing',
      if (integer(n['notStarted']) > 0) '${integer(n['notStarted'])} still to do',
    ].join(' · ');
    return SectionCard(title: str(c['title']), children: [
      Text('${str(c['teacher'])} · ${str(c['term'])}', style: small),
      const SizedBox(height: 8),
      Text(pct == null ? 'Current grade: no graded work yet' : 'Current grade: ${str(g['letter'])} · ${_pts(pct)}%', style: const TextStyle(fontWeight: FontWeight.w600)),
      Text('Calculated from graded work, so it can change. $counts. Work that isn\'t graded doesn\'t count toward the grade.', style: small),
      const SizedBox(height: 6),
      Text('Standards mastery: ${integer(m['mastered'])} of ${integer(m['total'])} mastered'),
      if (work.isNotEmpty)
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          initiallyExpanded: work.any((w) => w['missing'] == true || w['feedback'] != null),
          title: Text('All work and feedback (${work.length})'),
          children: [for (final w in work) _work(context, c, w, small)],
        ),
      Align(
        alignment: Alignment.centerLeft,
        child: TextButton(
          onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CourseScreen(courseId: str(c['id']), title: str(c['title'])))),
          child: const Text('Open course'),
        ),
      ),
    ]);
  }

  Widget _work(BuildContext context, Json c, Json w, TextStyle? small) {
    final quiz = w['kind'] == 'quiz';
    final detail = [
      quiz ? 'Quiz' : str(w['category'], 'Classwork'),
      if (w['dueAt'] != null) 'due ${fmtDay(date(w['dueAt']))}',
      if (quiz && w['maxAttempts'] != null) 'attempt ${integer(w['attempts'])} of ${integer(w['maxAttempts'])} · ${_retake[str(w['retakePolicy'])] ?? str(w['retakePolicy'])}',
    ].join(' · ');
    final chip = w['missing'] == true ? ('absent', 'Missing · not counted yet') : (_status[str(w['status'])] ?? ('expected', str(w['status'])));
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(str(w['title']), style: const TextStyle(fontWeight: FontWeight.w600)),
            Text(detail, style: small),
            if (w['counted'] == true) Text('${_pts(w['earned'])} / ${_pts(w['points'])} points'),
            if (w['feedback'] != null) Text('Teacher: ${str(w['feedback'])}'),
          ]),
        ),
        const SizedBox(width: 8),
        StatusChip(chip.$1, text: chip.$2),
      ]),
    );
  }
}

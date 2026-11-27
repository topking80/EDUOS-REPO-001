import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'courses_screen.dart';

class _WorkItem {
  const _WorkItem({
    required this.courseId, required this.courseTitle,
    required this.title, required this.kind, required this.status,
    this.dueAt, this.earned, this.points, this.missing = false,
  });
  final String courseId, courseTitle, title, kind, status;
  final String? dueAt;
  final num? earned, points;
  final bool missing;
  DateTime? get dueDate => dueAt == null ? null : DateTime.tryParse(dueAt!);
}

class _WorkOverview {
  const _WorkOverview(this.items, this.courseCount);
  final List<_WorkItem> items;
  final int courseCount;
}

/// Cross-course planner using only the signed-in learner's enrolled courses
/// and learner-specific assignment cells returned by the course API.
class StudentWorkScreen extends StatelessWidget {
  const StudentWorkScreen({super.key});

  Future<_WorkOverview> _load(BuildContext context) async {
    final api = AppScope.read(context).api;
    final response = await api.get('/api/learning/courses');
    final courses = objs(obj(response['data'])['courses']);
    if (courses.isEmpty) return const _WorkOverview([], 0);

    final details = await Future.wait(courses.map((course) async {
      final id = str(course['id']);
      if (id.isEmpty) return <String, Object?>{};
      try {
        return obj((await api.get('/api/learning/courses/$id'))['data']);
      } on ApiException catch (e) {
        if (e.isUnauthorized || e.isOffline) rethrow;
        return <String, Object?>{};
      }
    }));

    final items = <_WorkItem>[];
    for (final course in details) {
      if (course.isEmpty) continue;
      final courseId = str(course['id']);
      final courseTitle = str(course['title'], 'Course');
      for (final assignment in objs(course['assignments'])) {
        final mine = obj(assignment['mine']);
        items.add(_WorkItem(
          courseId: courseId,
          courseTitle: courseTitle,
          title: str(assignment['title'], 'Assignment'),
          kind: str(assignment['kind'], 'work'),
          status: str(mine['status'], 'not_started'),
          dueAt: assignment['due_at'] == null ? null : str(assignment['due_at']),
          earned: number(mine['earned']),
          points: number(assignment['points']),
          missing: boolean(mine['missing']),
        ));
      }
    }
    items.sort((a, b) {
      if (a.dueDate == null && b.dueDate == null) return a.title.compareTo(b.title);
      if (a.dueDate == null) return 1;
      if (b.dueDate == null) return -1;
      return a.dueDate!.compareTo(b.dueDate!);
    });
    return _WorkOverview(items, courses.length);
  }

  @override
  Widget build(BuildContext context) => Loader<_WorkOverview>(
        load: () => _load(context),
        builder: (context, overview, reload) {
          final open = overview.items.where((w) => !{'graded', 'submitted', 'needs_review'}.contains(w.status)).toList();
          final submitted = overview.items.where((w) => {'submitted', 'needs_review'}.contains(w.status)).toList();
          final graded = overview.items.where((w) => w.status == 'graded').toList();
          return RefreshIndicator(
            onRefresh: reload,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                SectionCard(title: 'My work', children: [
                  Text('One place for assignments across your ${overview.courseCount} enrolled course${overview.courseCount == 1 ? '' : 's'}.',
                      style: Theme.of(context).textTheme.bodySmall),
                  const SizedBox(height: 12),
                  Row(children: [
                    Expanded(child: _CountTile(label: 'To do', count: open.length, icon: Icons.assignment_outlined)),
                    const SizedBox(width: 8),
                    Expanded(child: _CountTile(label: 'Turned in', count: submitted.length, icon: Icons.upload_file_outlined)),
                    const SizedBox(width: 8),
                    Expanded(child: _CountTile(label: 'Graded', count: graded.length, icon: Icons.check_circle_outline)),
                  ]),
                ]),
                if (overview.items.isEmpty)
                  const SectionCard(children: [EmptyState('No assignments have been published yet.')])
                else ...[
                  if (open.isNotEmpty)
                    SectionCard(title: 'Up next', children: [
                      for (final item in open) _WorkTile(item, onTap: () => _openCourse(context, item)),
                    ]),
                  if (submitted.isNotEmpty)
                    SectionCard(title: 'Turned in · awaiting review', children: [
                      for (final item in submitted) _WorkTile(item, onTap: () => _openCourse(context, item)),
                    ]),
                  if (graded.isNotEmpty)
                    SectionCard(title: 'Graded work', children: [
                      for (final item in graded) _WorkTile(item, onTap: () => _openCourse(context, item)),
                    ]),
                ],
                const Notice('Your course grade is based on work your teacher has graded. Work that has not been graded is not counted as zero. Quiz answers are saved only when the app confirms they were received.'),
              ],
            ),
          );
        },
      );

  void _openCourse(BuildContext context, _WorkItem item) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CourseScreen(courseId: item.courseId, title: item.courseTitle),
    ));
  }
}

class _CountTile extends StatelessWidget {
  const _CountTile({required this.label, required this.count, required this.icon});
  final String label;
  final int count;
  final IconData icon;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(10),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon, size: 20),
          const SizedBox(height: 6),
          Text('$count', style: Theme.of(context).textTheme.titleLarge),
          Text(label, style: Theme.of(context).textTheme.labelSmall),
        ]),
      );
}

class _WorkTile extends StatelessWidget {
  const _WorkTile(this.item, {required this.onTap});
  final _WorkItem item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final due = item.dueAt == null ? 'No due date' : 'Due ${fmtDay(item.dueDate)}';
    final status = item.missing
        ? const StatusChip('attention', text: 'Missing')
        : switch (item.status) {
            'graded' => const StatusChip('present', text: 'Graded'),
            'submitted' => const StatusChip('current', text: 'Submitted'),
            'needs_review' => const StatusChip('current', text: 'Needs review'),
            'in_progress' => const StatusChip('current', text: 'In progress'),
            _ => const StatusChip('expected', text: 'Not started'),
          };
    final score = item.status == 'graded' && item.earned != null && item.points != null
        ? '${item.earned!.toStringAsFixed(item.earned! % 1 == 0 ? 0 : 1)} / ${item.points!.toStringAsFixed(item.points! % 1 == 0 ? 0 : 1)} points'
        : null;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      title: Text(item.title, style: const TextStyle(fontWeight: FontWeight.w600)),
      subtitle: Text('${item.courseTitle} · ${item.kind == 'quiz' ? 'Quiz' : 'Assignment'} · $due${score == null ? '' : ' · $score'}'),
      trailing: status,
      onTap: onTap,
    );
  }
}

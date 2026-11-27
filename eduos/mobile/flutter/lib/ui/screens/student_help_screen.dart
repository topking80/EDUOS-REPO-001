import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Student app Phase E: who to ask, where help with work is, the school's
/// approved resources, and display settings that follow the student to every
/// device. Nothing here lets students message each other or anyone outside school.
class StudentHelpScreen extends StatelessWidget {
  const StudentHelpScreen({super.key});

  static Future<void> Function(Uri) opener = (u) => launchUrl(u, mode: LaunchMode.externalApplication);

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    Future<Map<String, Object?>?> optional(String path) async {
      try {
        return await app.api.get(path);
      } on ApiException catch (e) {
        if (e.isUnauthorized) rethrow;
        return null;
      }
    }

    return Loader<(List<Json>, List<Json>)>(
      load: () async {
        final r = await Future.wait([optional('/api/learning/courses'), optional('/api/resources')]);
        return (objs(obj(r[0]?['data'])['courses']), objs(r[1]?['data']).take(6).toList());
      },
      builder: (context, d, reload) {
        final (courses, resources) = d;
        final teachers = <String, String>{for (final c in courses) str(c['teacher_name']): str(c['title'])}..remove('');
        return ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(title: 'If you need help right now', children: [
            const Text('Tell a teacher, a counselor or any adult at school straight away.'),
            const Text('If someone is in danger, call 911.'),
            const SizedBox(height: 8),
            const Text('To talk to someone about how you\'re feeling, any time, call or text 988.'),
            Wrap(spacing: 8, children: [
              OutlinedButton(onPressed: () => opener(Uri.parse('tel:988')), child: const Text('Call 988')),
              OutlinedButton(onPressed: () => opener(Uri.parse('sms:988')), child: const Text('Text 988')),
            ]),
          ]),
          SectionCard(title: 'Talk to an adult at school', children: [
            for (final MapEntry(key: name, value: course) in teachers.entries) Text('$name · $course'),
            const Text('You can ask any of your teachers before or after class, or visit the school office or counselor.'),
          ]),
          const SectionCard(title: 'Help with your work', children: [
            Text('Each assignment\'s page has your teacher\'s instructions. Open it from Courses.'),
            Text('Grades shows what\'s graded, what\'s waiting and your teacher\'s feedback.'),
            Notice('Christie only uses lessons your school approved and gives hints, not answers. Your teacher can read these chats.'),
          ]),
          SectionCard(title: 'School resources', children: [
            if (resources.isEmpty) const Text('Your school hasn\'t chosen digital resources yet.'),
            for (final r in resources)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(str(r['title'])),
                subtitle: Text(str(obj(r['source'])['name'])),
                trailing: const Icon(Icons.open_in_new),
                onTap: () {
                  final u = Uri.tryParse(str(obj(r['source'])['url']));
                  if (u != null && u.scheme == 'https') opener(u);
                },
              ),
          ]),
          const _DisplayCard(),
          const Notice('There\'s no student-to-student messaging in EduOS. If anything here worries you, tell an adult at school.'),
        ]);
      },
    );
  }
}

class _DisplayCard extends StatefulWidget {
  const _DisplayCard();
  @override
  State<_DisplayCard> createState() => _DisplayCardState();
}

class _DisplayCardState extends State<_DisplayCard> {
  DisplayPrefs? _d;
  bool _saving = false;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    DisplayPrefs cur() => _d ?? app.brand?.display ?? const DisplayPrefs();
    final d = cur();
    // Each change starts from the latest choice, even between rebuilds.
    void set(DisplayPrefs Function(DisplayPrefs) f) => setState(() => _d = f(cur()));
    return SectionCard(title: 'Make EduOS easier to read', children: [
      const Text('Text size'),
      SegmentedButton<String>(
        segments: const [
          ButtonSegment(value: 'standard', label: Text('Standard')),
          ButtonSegment(value: 'large', label: Text('Large')),
          ButtonSegment(value: 'larger', label: Text('Larger')),
        ],
        selected: {d.textSize},
        onSelectionChanged: (s) => set((c) => DisplayPrefs(textSize: s.first, highContrast: c.highContrast, reduceMotion: c.reduceMotion)),
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('High contrast'),
        value: d.highContrast,
        onChanged: (v) => set((c) => DisplayPrefs(textSize: c.textSize, highContrast: v, reduceMotion: c.reduceMotion)),
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: const Text('Reduce motion'),
        value: d.reduceMotion,
        onChanged: (v) => set((c) => DisplayPrefs(textSize: c.textSize, highContrast: c.highContrast, reduceMotion: v)),
      ),
      const Text('Saved with your account, so they follow you to every device. Your device\'s own settings are respected too.'),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: _saving
            ? null
            : () async {
                setState(() => _saving = true);
                final messenger = ScaffoldMessenger.of(context);
                try {
                  await app.saveDisplay(cur());
                  messenger.showSnackBar(const SnackBar(content: Text('Saved.')));
                } on ApiException {
                  messenger.showSnackBar(const SnackBar(content: Text('Couldn\'t save your settings.')));
                } finally {
                  if (mounted) setState(() => _saving = false);
                }
              },
        child: const Text('Save settings'),
      ),
    ]);
  }
}

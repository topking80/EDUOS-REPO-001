import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'messages_screen.dart';
import 'web_fallback_screen.dart';

class _Overview {
  const _Overview({required this.home, required this.routes, required this.flagged, required this.openReports,
      required this.pendingApprovals, required this.announcements});
  final Json home;
  final List<Json> routes;
  final int flagged, openReports, pendingApprovals;
  final List<Announcement> announcements;
}

/// Principal "School" / superintendent "District" overview: today's numbers,
/// buses, what needs attention, and announcements (principals can post).
class OverviewScreen extends StatefulWidget {
  const OverviewScreen({super.key});

  @override
  State<OverviewScreen> createState() => _OverviewScreenState();
}

class _OverviewScreenState extends State<OverviewScreen> {
  Key _key = UniqueKey();

  Future<_Overview> _load() async {
    final api = AppScope.read(context).api;
    Future<Map<String, Object?>?> optional(String path) async {
      try {
        return await api.get(path);
      } on ApiException catch (e) {
        if (e.isUnauthorized) rethrow;
        return null;
      }
    }

    final r = await Future.wait([
      api.get('/api/home'),
      optional('/api/transport/today'),
      optional('/api/christie/review'),
      optional('/api/comms/reports'),
      optional('/api/learning/approvals'),
      optional('/api/comms/announcements'),
    ]);
    final approvals = obj(r[4]?['data']);
    return _Overview(
      home: obj(r[0]?['data']),
      routes: objs(obj(r[1]?['data'])['routes']),
      flagged: objs(r[2]?['data']).where((x) => x['needs_adult'] == true && x['reviewed_at'] == null).length,
      openReports: objs(r[3]?['data']).where((x) => x['status'] == 'open').length,
      pendingApprovals: objs(approvals['lessons']).length + objs(approvals['sources']).length,
      announcements: objs(r[5]?['data']).map(Announcement.fromJson).toList(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final principal = app.me?.role == 'principal';
    return Loader<_Overview>(
      key: _key,
      load: _load,
      builder: (context, o, reload) {
        final d = o.home;
        final onBoard = o.routes.fold<int>(0, (n, r) => n + integer(obj(r['counts'])['onBoard']));
        final riders = o.routes.fold<int>(0, (n, r) => n + integer(obj(r['counts'])['riders']));
        return ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(children: [
            Text(str(d['school_name'], app.brand?.placeName ?? ''), style: Theme.of(context).textTheme.bodySmall),
            Semantics(header: true, child: Text(principal ? 'School overview' : 'District overview', style: Theme.of(context).textTheme.titleLarge)),
            Text('${o.routes.length} bus run${o.routes.length == 1 ? '' : 's'} today · $onBoard of $riders riders on board now'),
            const SizedBox(height: 12),
            Row(children: principal
                ? [
                    Expanded(child: StatTile(integer(d['students']), 'students')),
                    Expanded(child: StatTile(integer(d['absent_today']), 'absent today', warnWhenPositive: true)),
                    Expanded(child: StatTile(integer(d['open_cases']), 'open support cases')),
                    Expanded(child: StatTile(integer(d['overdue_follow_ups']), 'overdue follow-ups', warnWhenPositive: true)),
                  ]
                : [
                    Expanded(child: StatTile(integer(d['schools']), 'schools')),
                    Expanded(child: StatTile(integer(d['students']), 'students')),
                    Expanded(child: StatTile(integer(d['urgent_cases']), 'urgent cases', warnWhenPositive: true)),
                    Expanded(child: StatTile(integer(d['absences_7d']), 'absences (7 days)', warnWhenPositive: true)),
                  ]),
          ]),
          SectionCard(title: 'Needs attention', children: [
            _CountRow('Christie chats where a learner asked for an adult', o.flagged),
            _CountRow('Reported messages to review', o.openReports),
            if (principal) _CountRow('Pending guardian invitations', integer(d['pending_invitations']), tone: ChipTone.waiting),
            _CountRow('Lessons and sources waiting for approval', o.pendingApprovals, tone: ChipTone.waiting),
            const SizedBox(height: 8),
            OutlinedButton.icon(icon: const Icon(Icons.open_in_new), label: const Text('Review approvals on the web'), onPressed: () => openWebApp(context, path: '/app/#/approvals')),
          ]),
          if (principal) SectionCard(title: 'Announce to the school', children: [_AnnounceForm(onPosted: () => setState(() => _key = UniqueKey()))]),
          SectionCard(title: 'Announcements', children: [AnnouncementList(o.announcements.take(3).toList(), onChanged: reload)]),
        ]);
      },
    );
  }
}

class _CountRow extends StatelessWidget {
  const _CountRow(this.label, this.count, {this.tone});
  final String label;
  final int count;
  final ChipTone? tone;

  @override
  Widget build(BuildContext context) => ListTile(
        dense: true,
        contentPadding: EdgeInsets.zero,
        title: Text(label),
        trailing: StatusChip('', text: '$count', tone: count == 0 ? ChipTone.good : (tone ?? ChipTone.bad)),
      );
}

class _AnnounceForm extends StatefulWidget {
  const _AnnounceForm({required this.onPosted});
  final VoidCallback onPosted;

  @override
  State<_AnnounceForm> createState() => _AnnounceFormState();
}

class _AnnounceFormState extends State<_AnnounceForm> {
  final _title = TextEditingController(), _body = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _post() async {
    if (_title.text.trim().isEmpty || _body.text.trim().isEmpty) return toast(context, 'Add a title and a message.');
    setState(() => _busy = true);
    try {
      final r = await AppScope.read(context).api.post('/api/comms/announcements', {
        'scope': 'school',
        'title': _title.text.trim(),
        'body': _body.text.trim(),
        'audience': ['teacher', 'parent', 'pupil', 'driver'],
      });
      if (!mounted) return;
      toast(context, 'Posted to ${integer(obj(r.data)['recipients'])} people');
      _title.clear();
      _body.clear();
      widget.onPosted();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.status == 429 ? 'Too many posts, try again shortly.' : 'Couldn\'t post. Check the title and message.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        TextField(controller: _title, maxLength: 120, decoration: const InputDecoration(labelText: 'Title')),
        TextField(controller: _body, maxLength: 4000, minLines: 3, maxLines: 8, decoration: const InputDecoration(labelText: 'Message')),
        Text('Goes to everyone at your school, in the app.', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        FilledButton(onPressed: _busy ? null : _post, child: const Text('Post')),
      ]);
}

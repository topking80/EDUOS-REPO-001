// TC-05 sharing (GET/POST /api/history/sharing): a learner who holds their
// own rights chooses who else sees which parts of their history, and for how
// long; a parent sees what has been shared with them.
import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/format.dart';
import '../../../core/history_models.dart';
import '../../../core/models.dart';
import '../../widgets.dart';
import 'history_timeline_screen.dart';
import 'history_widgets.dart';

class SharingScreen extends StatelessWidget {
  const SharingScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final parent = app.me?.role == 'parent';
    return Scaffold(
      appBar: AppBar(title: const Text('Sharing')),
      body: Loader<Json>(
        load: () async => obj((await app.api.get('/api/history/sharing'))['data']),
        builder: (context, d, reload) => parent ? _ParentSharing(d) : _LearnerSharing(d, reload),
      ),
    );
  }
}

class _ParentSharing extends StatelessWidget {
  const _ParentSharing(this.d);
  final Json d;

  @override
  Widget build(BuildContext context) {
    final grants = objs(d['grantsToMe']).map(SharingGrant.fromJson).toList();
    final adults = objs(d['holdsOwnRights']);
    return ReadableList(children: [
      if (adults.isNotEmpty)
        SectionCard(title: 'Children who hold their own rights', children: [
          const Notice('Once a student holds the rights to their records, they decide what you can see.'),
          for (final a in adults) Text(str(a['name'])),
        ]),
      SectionCard(title: 'Shared with you', children: [
        if (grants.isEmpty) const EmptyState('Nothing has been shared with you.'),
        for (final g in grants)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(g.who),
            subtitle: Text('${g.classifications.map((c) => shareClassText[c] ?? c).join(', ')} · until ${fmtDay(g.expiresAt)}'),
            trailing: g.studentId == null
                ? null
                : TextButton(
                    onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => HistoryTimelineScreen(studentId: g.studentId, title: '${g.who}\'s history'))),
                    child: const Text('Open'),
                  ),
          ),
      ]),
    ]);
  }
}

class _LearnerSharing extends StatefulWidget {
  const _LearnerSharing(this.d, this.reload);
  final Json d;
  final Future<void> Function() reload;

  @override
  State<_LearnerSharing> createState() => _LearnerSharingState();
}

class _LearnerSharingState extends State<_LearnerSharing> {
  String? _grantee;
  final Set<String> _classes = {'official_record'};
  int _days = 30;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final holds = boolean(widget.d['holdsOwnRights']);
    final guardians = objs(widget.d['guardians']);
    final grants = objs(widget.d['grants']).map(SharingGrant.fromJson).toList();
    if (!holds) {
      return const ReadableList(children: [
        SectionCard(title: 'Sharing', children: [
          Text('Your family manages who sees your history until you hold the rights to your own records (usually at 18, or when you start college).'),
        ]),
      ]);
    }
    Future<void> share() async {
      if (_grantee == null || _classes.isEmpty) return toast(context, 'Choose who, and what to share.');
      try {
        await app.api.post('/api/history/sharing', {'granteeUserId': _grantee, 'classifications': _classes.toList(), 'days': _days});
        if (context.mounted) toast(context, 'Shared.');
        await widget.reload();
      } on ApiException {
        if (context.mounted) toast(context, 'Couldn\'t share.');
      }
    }

    return ReadableList(children: [
      SectionCard(title: 'Share your history', children: [
        const Notice('You hold the rights to your records. Your family sees only what you share, until the date you pick.'),
        DropdownButtonFormField<String>(
          value: _grantee,
          decoration: const InputDecoration(labelText: 'With'),
          items: [for (final g in guardians) DropdownMenuItem(value: str(g['id']), child: Text(str(g['name'])))],
          onChanged: (v) => setState(() => _grantee = v),
        ),
        const SizedBox(height: 8),
        for (final e in shareClassText.entries)
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: _classes.contains(e.key),
            title: Text(e.value),
            onChanged: (v) => setState(() => v == true ? _classes.add(e.key) : _classes.remove(e.key)),
          ),
        DropdownButtonFormField<int>(
          value: _days,
          decoration: const InputDecoration(labelText: 'For'),
          items: const [
            DropdownMenuItem(value: 7, child: Text('1 week')),
            DropdownMenuItem(value: 30, child: Text('30 days')),
            DropdownMenuItem(value: 90, child: Text('90 days')),
            DropdownMenuItem(value: 365, child: Text('1 year')),
          ],
          onChanged: (v) => setState(() => _days = v ?? 30),
        ),
        const SizedBox(height: 12),
        FilledButton(onPressed: share, child: const Text('Share')),
      ]),
      SectionCard(title: 'Shared', children: [
        if (grants.isEmpty) const EmptyState('You haven\'t shared anything.'),
        for (final g in grants)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(g.who),
            subtitle: Text('${g.classifications.map((c) => shareClassText[c] ?? c).join(', ')} · ${g.active ? 'until ${fmtDay(g.expiresAt)}' : 'ended'}'),
            trailing: g.active
                ? TextButton(
                    onPressed: () async {
                      try {
                        await app.api.post('/api/history/sharing/${g.id}/revoke');
                        if (context.mounted) toast(context, 'Stopped sharing.');
                        await widget.reload();
                      } on ApiException {
                        if (context.mounted) toast(context, 'Couldn\'t stop sharing.');
                      }
                    },
                    child: const Text('Stop'),
                  )
                : null,
          ),
      ]),
    ]);
  }
}

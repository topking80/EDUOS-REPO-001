import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../arbiter_links.dart';
import '../widgets.dart';
import 'activity_ops_screens.dart';

/// COACH-01: "My teams" (GET /api/coach/teams): the teams this coach (or
/// teacher who coaches) has at this school — what's coming up, the roster with
/// eligibility and permission-slip answers — and the other schools where they
/// coach, to switch to.
class CoachTeamsScreen extends StatelessWidget {
  const CoachTeamsScreen({super.key});

  static const _eligibility = {
    'eligible': ('present', 'Eligible'),
    'not_eligible': ('absent', 'Not eligible'),
    'not_enough_records': ('expected', 'Not enough records'),
  };
  static const _slip = {
    'granted': ('present', 'Slip signed'),
    'declined': ('absent', 'Slip declined'),
    'pending': ('expected', 'Slip waiting'),
  };

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<Json>(
      load: () async => obj((await app.api.get('/api/coach/teams'))['data']),
      builder: (context, d, reload) {
        final teams = objs(d['teams']);
        final elsewhere = objs(d['elsewhere']);
        return ListView(padding: const EdgeInsets.all(16), children: [
          if (teams.isEmpty)
            SectionCard(children: [
              EmptyState(elsewhere.isEmpty ? 'You aren\'t a coach or advisor yet. A principal assigns coaches.' : 'You don\'t coach a team at this school.'),
            ]),
          for (final e in elsewhere)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: OutlinedButton.icon(
                icon: const Icon(Icons.emoji_events_outlined),
                label: Text('Your teams at ${str(e['school'])}'),
                onPressed: () async {
                  try {
                    await app.switchMembership(str(e['membership_id']));
                  } on ApiException {
                    if (context.mounted) toast(context, 'Couldn\'t switch.');
                  }
                },
              ),
            ),
          for (final t in teams) _team(context, t),
          if (teams.isNotEmpty) const ArbiterLinksCard(),
        ]);
      },
    );
  }

  Widget _team(BuildContext context, Json t) {
    final events = objs(t['events']);
    final roster = objs(t['roster']);
    final slip = t['slip'] is Map ? obj(t['slip']) : null;
    final text = Theme.of(context).textTheme;
    return SectionCard(title: str(t['title']), children: [
      Text('${str(t['kind']) == 'sport' ? 'Team' : 'Club'} · you\'re the ${str(t['role'])}', style: text.bodySmall),
      const SizedBox(height: 8),
      Text('Coming up', style: text.titleSmall),
      if (events.isEmpty) const Text('Nothing scheduled.'),
      for (final e in events)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(str(e['title'])),
          subtitle: Text([fmtDay(date(e['starts_at'])), if (str(e['venue']).isNotEmpty) str(e['venue'])].join(' · ')),
        ),
      if (slip != null)
        Text('Permission slip “${str(slip['title'])}”: ${integer(slip['granted'])} signed, ${integer(slip['pending'])} waiting'
            '${integer(slip['declined']) > 0 ? ', ${integer(slip['declined'])} declined' : ''}.'),
      const SizedBox(height: 8),
      Text('Roster (${roster.length})', style: text.titleSmall),
      if (roster.isEmpty) const Text('No one on the roster yet.'),
      for (final r in roster)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text('${r['jersey'] != null ? '#${r['jersey']} ' : ''}${str(r['name'])}'),
          subtitle: Text('Grade ${str(r['grade'])}'),
          trailing: Wrap(spacing: 6, children: [
            if (_eligibility[str(r['eligibility'])] case final e?) StatusChip(e.$1, text: e.$2),
            if (_slip[str(r['slip'])] case final s?) StatusChip(s.$1, text: s.$2),
          ]),
        ),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final e in events)
          OutlinedButton.icon(
            onPressed: () => ActivityAttendanceScreen.open(context, eventId: str(e['id']), title: str(e['title'], 'Attendance')),
            icon: const Icon(Icons.how_to_reg_outlined),
            label: Text('Attendance: ${str(e['title'])}'),
          ),
        if (str(t['kind']) == 'sport')
          OutlinedButton.icon(
            onPressed: () => ActivityPhysicalsScreen.open(context, activityId: str(t['id']), title: str(t['title'])),
            icon: const Icon(Icons.health_and_safety_outlined),
            label: const Text('Physicals'),
          ),
      ]),
      if (str(t['kind']) == 'sport')
        Text('Eligibility is worked out now from the district\'s rules and isn\'t stored. Only you and the athletic director see it. Physicals show dates only.', style: text.bodySmall),
    ]);
  }
}

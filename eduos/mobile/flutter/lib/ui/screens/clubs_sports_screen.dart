import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'tickets_screen.dart';

class _ClubsSportsData {
  const _ClubsSportsData({required this.activities, required this.events});
  final List<Json> activities;
  final List<Json> events;
}

/// Native learner view of published clubs, teams and their upcoming events.
/// Joining is always confirmed by the district API; this screen does not
/// assume eligibility. Tickets open the 37.7 sandbox ticket screen, where
/// learners can get free tickets but never pay.
class ClubsSportsScreen extends StatelessWidget {
  const ClubsSportsScreen({super.key});

  Future<_ClubsSportsData> _load(BuildContext context) async {
    final api = AppScope.read(context).api;
    final results = await Future.wait([
      api.get('/api/activities'),
      api.get('/api/events'),
    ]);
    return _ClubsSportsData(
      activities: objs(results[0]['data']),
      events: objs(results[1]['data']),
    );
  }

  Future<void> _join(BuildContext context, String activityId, Future<void> Function() reload) async {
    try {
      await AppScope.read(context).api.post('/api/activities/$activityId/join');
      if (!context.mounted) return;
      toast(context, 'Your request to join was accepted.');
      await reload();
    } on ApiException catch (e) {
      if (!context.mounted) return;
      toast(context, switch (e.error) {
        'grade_eligibility_not_met' => 'This activity is not available for your grade.',
        'activity_not_found' => 'This activity is no longer available.',
        _ when e.isOffline => 'You\'re offline. Connect to join an activity.',
        _ => 'Could not join this activity. Please try again or ask your school.',
      });
    }
  }

  @override
  Widget build(BuildContext context) => Loader<_ClubsSportsData>(
        load: () => _load(context),
        builder: (context, data, reload) {
          final eventsByActivity = <String, List<Json>>{};
          for (final event in data.events) {
            eventsByActivity.putIfAbsent(str(event['activity_id']), () => []).add(event);
          }
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              const SectionCard(
                children: [
                  Row(children: [
                    Icon(Icons.emoji_events_outlined, size: 28),
                    SizedBox(width: 10),
                    Expanded(child: Text('Find your people. Try something new.', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 18))),
                  ]),
                  SizedBox(height: 8),
                  Text('Explore school clubs and sports teams. Your school confirms membership and grade eligibility when you join.'),
                ],
              ),
              if (data.activities.isEmpty)
                const SectionCard(title: 'Clubs & Sports', children: [
                  EmptyState('No published clubs or teams are available right now. Check back with your school soon.'),
                ])
              else ...[
                for (final activity in data.activities)
                  SectionCard(
                    title: str(activity['title'], 'School activity'),
                    children: [
                      Row(children: [
                        StatusChip(str(activity['kind']), text: str(activity['kind']) == 'sport' ? 'Sports team' : 'Club'),
                        const SizedBox(width: 8),
                        if (activity['schoolName'] != null)
                          Expanded(child: Text(str(activity['schoolName']), style: Theme.of(context).textTheme.bodySmall)),
                      ]),
                      if (str(activity['description']).isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(str(activity['description'])),
                      ],
                      if (str(activity['meetingDetails']).isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                          const Icon(Icons.schedule, size: 18),
                          const SizedBox(width: 6),
                          Expanded(child: Text(str(activity['meetingDetails']))),
                        ]),
                      ],
                      if (activity['gradeMin'] != null || activity['gradeMax'] != null) ...[
                        const SizedBox(height: 6),
                        Text('Eligible grades: ${activity['gradeMin'] ?? 'K'}–${activity['gradeMax'] ?? '12'}',
                            style: Theme.of(context).textTheme.bodySmall),
                      ],
                      const SizedBox(height: 10),
                      FilledButton.icon(
                        onPressed: str(activity['status']) == 'published'
                            ? () => _join(context, str(activity['id']), reload)
                            : null,
                        icon: const Icon(Icons.group_add_outlined),
                        label: const Text('Join activity'),
                      ),
                      for (final event in eventsByActivity[str(activity['id'])] ?? const <Json>[])
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          leading: const Icon(Icons.event_outlined),
                          title: Text(str(event['title'])),
                          subtitle: Text([
                            str(event['venue']),
                            str(event['starts_at']),
                          ].where((v) => v.isNotEmpty).join(' · ')),
                        ),
                    ],
                  ),
              ],
              SectionCard(title: 'Event tickets', children: [
                const Text('Get free tickets to school events. A parent or guardian buys paid ones.'),
                const SizedBox(height: 8),
                OutlinedButton.icon(
                  onPressed: () => TicketsScreen.open(context),
                  icon: const Icon(Icons.confirmation_number_outlined),
                  label: const Text('Tickets'),
                ),
              ]),
              const Notice('Livestream playback is not enabled in this release. Your school will share event access details.'),
            ],
          );
        },
      );
}

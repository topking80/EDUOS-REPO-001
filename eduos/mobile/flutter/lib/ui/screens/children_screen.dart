import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'tickets_screen.dart';

class ChildCardData {
  const ChildCardData(this.child, this.days, this.ride);
  final ChildSummary child;
  final List<AttendanceDay> days;
  final Rider? ride;
}

/// Parent home: one card per linked child with attendance, work due and the
/// bus status (GET /api/home, /api/family/children/:id/summary, /api/transport/today).
class ChildrenScreen extends StatelessWidget {
  const ChildrenScreen({super.key, this.onOpenArrival});

  final VoidCallback? onOpenArrival;

  static Future<List<ChildCardData>> load(ApiClient api, {DateTime? now}) async {
    final results = await Future.wait([api.get('/api/home'), _optional(() => api.get('/api/transport/today'))]);
    final kids = objs(obj(results[0]?['data'])['children']).map(ChildSummary.fromJson).toList();
    final riders = objs(obj(results[1]?['data'])['riders']).map(Rider.fromJson).toList();
    final direction = (now ?? DateTime.now()).hour < 12 ? 'am' : 'pm';
    return Future.wait(kids.map((k) async {
      final summary = await _optional(() => api.get('/api/family/children/${k.id}/summary'));
      final days = objs(summary?['attendance']).map(AttendanceDay.fromJson).take(5).toList();
      final mine = riders.where((r) => r.studentId == k.id).toList();
      final ride = mine.where((r) => r.direction == direction).firstOrNull ?? mine.firstOrNull;
      return ChildCardData(k, days, ride);
    }));
  }

  static Future<Map<String, Object?>?> _optional(Future<Map<String, Object?>> Function() call) async {
    try {
      return await call();
    } on ApiException catch (e) {
      if (e.isUnauthorized) rethrow;
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<List<ChildCardData>>(
      load: () => load(app.api),
      builder: (context, cards, _) => ListView(
        padding: const EdgeInsets.all(16),
        children: cards.isEmpty
            ? [const EmptyState('No children are linked to your account yet.')]
            : [
                for (final c in cards) _ChildCard(c, onOpenArrival: onOpenArrival),
                // 37.7.0: school event tickets (sandbox payments, receipts).
                SectionCard(title: 'Event tickets', children: [
                  const Text('Tickets for games and school events, and your receipts.'),
                  const SizedBox(height: 8),
                  OutlinedButton.icon(
                    onPressed: () => TicketsScreen.open(context),
                    icon: const Icon(Icons.confirmation_number_outlined),
                    label: const Text('Tickets & receipts'),
                  ),
                ]),
              ],
      ),
    );
  }
}

class _ChildCard extends StatelessWidget {
  const _ChildCard(this.data, {this.onOpenArrival});
  final ChildCardData data;
  final VoidCallback? onOpenArrival;

  @override
  Widget build(BuildContext context) {
    final k = data.child, ride = data.ride;
    return SectionCard(children: [
      Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Semantics(header: true, child: Text(k.name, style: Theme.of(context).textTheme.titleLarge)),
            Text('Grade ${k.grade} · ${k.schoolName}', style: Theme.of(context).textTheme.bodySmall),
          ]),
        ),
        if (ride != null) StatusChip(ride.status),
      ]),
      const SizedBox(height: 12),
      Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
        Expanded(child: StatTile(k.absences30d, 'absences (30 days)', warnWhenPositive: true)),
        Expanded(child: StatTile(k.due7d, 'due this week')),
        Expanded(child: StatTile(k.overdue, 'overdue', warnWhenPositive: true)),
        Expanded(child: StatTile(k.toAcknowledge, 'to acknowledge', warnWhenPositive: true)),
      ]),
      if (data.days.isNotEmpty) ...[
        const SizedBox(height: 12),
        Text('Recent attendance', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 6),
        Wrap(spacing: 6, runSpacing: 6, children: [
          for (final d in data.days) StatusChip(d.status, text: '${fmtDay(d.day)}: ${statusLabel(d.status)}'),
        ]),
      ],
      if (ride != null) ...[
        const SizedBox(height: 12),
        OutlinedButton.icon(
          onPressed: onOpenArrival,
          icon: const Icon(Icons.directions_bus),
          label: Text('Bus: ${statusLabel(ride.status)}'),
        ),
      ],
    ]);
  }
}

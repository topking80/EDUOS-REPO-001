import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Today's bus check-ins for the family's riders (GET /api/transport/today).
class ArrivalScreen extends StatelessWidget {
  const ArrivalScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<List<Rider>>(
      load: () async => objs(obj((await app.api.get('/api/transport/today'))['data'])['riders']).map(Rider.fromJson).toList(),
      builder: (context, riders, _) => ListView(padding: const EdgeInsets.all(16), children: [
        if (riders.isEmpty) const EmptyState('No bus assignments for your children.'),
        for (final r in riders)
          SectionCard(children: [
            Row(children: [
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(r.name, style: Theme.of(context).textTheme.titleMedium),
                  Text('${r.busLabel} · ${r.routeName} · stop ${r.stopName}${r.stopTime == null ? '' : ' (${r.stopTime})'}',
                      style: Theme.of(context).textTheme.bodySmall),
                ]),
              ),
              StatusChip(r.status),
            ]),
            const SizedBox(height: 8),
            if (r.events.isEmpty)
              Text(r.runId != null ? 'The run has started. No check-in for this child yet.' : 'This run hasn\'t started yet.')
            else
              for (final e in r.events)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  leading: Text(fmtTime(e.at)),
                  title: Text('${statusLabel(e.event)} ${e.isSchool ? 'at school' : 'at ${e.stopName}'}'),
                ),
          ]),
        const Notice('These are check-ins the driver taps at each stop. EduOS never tracks your child\'s location, and the app never asks for yours.'),
      ]),
    );
  }
}

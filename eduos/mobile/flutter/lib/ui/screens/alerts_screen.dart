import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

class _Alerts {
  const _Alerts(this.items, this.unread);
  final List<AlertItem> items;
  final int unread;
}

IconData alertIcon(String kind) => switch (kind) {
      'transport' => Icons.directions_bus,
      'christie' => Icons.auto_awesome,
      'announcement' => Icons.newspaper,
      'safety' => Icons.shield_outlined,
      'pickup' => Icons.directions_car,
      _ => Icons.chat_bubble_outline,
    };

/// In-app notifications (GET /api/notifications).
class AlertsScreen extends StatelessWidget {
  const AlertsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<_Alerts>(
      load: () async {
        final d = obj((await app.api.get('/api/notifications'))['data']);
        return _Alerts(objs(d['items']).map(AlertItem.fromJson).toList(), integer(d['unread']));
      },
      builder: (context, alerts, reload) => ListView(padding: const EdgeInsets.all(16), children: [
        if (alerts.unread > 0)
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () async {
                try {
                  await app.api.post('/api/notifications/read');
                  app.markAlertsRead();
                  await reload();
                } on ApiException {
                  if (context.mounted) toast(context, 'Couldn\'t mark alerts as read.');
                }
              },
              child: const Text('Mark all read'),
            ),
          ),
        SectionCard(children: [
          if (alerts.items.isEmpty) const EmptyState('No alerts.'),
          for (final a in alerts.items)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(alertIcon(a.kind)),
              title: Text(a.title, style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text([if (a.body != null) a.body!, ago(a.createdAt)].join('\n')),
              trailing: a.read ? null : const StatusChip('current', text: 'New'),
            ),
        ]),
      ]),
    );
  }
}

// School leads review teachers' history items before families see them
// (GET/POST /api/history-review).
import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/format.dart';
import '../../../core/history_models.dart';
import '../../../core/models.dart';
import '../../widgets.dart';
import 'history_widgets.dart';

class HistoryReviewScreen extends StatelessWidget {
  const HistoryReviewScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Review teachers\' items')),
      body: Loader<List<HistoryItem>>(
        load: () async => objs((await app.api.get('/api/history-review'))['data']).map(HistoryItem.fromJson).toList(),
        builder: (context, items, reload) {
          Future<void> review(HistoryItem i, String decision) async {
            String? reason;
            if (decision != 'approve') {
              reason = await showModalBottomSheet<String>(
                context: context,
                builder: (context) => SafeArea(
                  child: ListView(shrinkWrap: true, children: [
                    ListTile(title: Text(decision == 'reject' ? 'Why reject it?' : 'What needs changing?', style: const TextStyle(fontWeight: FontWeight.w600))),
                    for (final r in historyReasons.where((r) => r.$1 != 'family_preference')) ListTile(title: Text(r.$2), onTap: () => Navigator.pop(context, r.$1)),
                  ]),
                ),
              );
              if (reason == null) return;
            }
            try {
              await app.api.post('/api/history-review/${i.id}', {'decision': decision, if (reason != null) 'reasonCode': reason});
              if (context.mounted) toast(context, const {'approve': 'Approved; the family decides next.', 'request_changes': 'Sent back to the teacher.', 'reject': 'Rejected.'}[decision]!);
              await reload();
            } on ApiException {
              if (context.mounted) toast(context, 'Couldn\'t save the review.');
            }
          }

          return ReadableList(children: [
            SectionCard(children: [
              if (items.isEmpty) const EmptyState('Nothing waiting for review.'),
              for (final i in items)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(i.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                    Text([if (i.studentName != null) i.studentName!, historyTypeText[i.entryType] ?? i.entryType, fmtDay(i.occurredAt)].join(' · '), style: Theme.of(context).textTheme.bodySmall),
                    if (i.body.isNotEmpty) Text(i.body),
                    for (final d in i.decisions) Text(d.label, style: Theme.of(context).textTheme.bodySmall),
                    Wrap(spacing: 8, children: [
                      FilledButton.tonal(onPressed: () => review(i, 'approve'), child: const Text('Approve')),
                      TextButton(onPressed: () => review(i, 'request_changes'), child: const Text('Ask for changes')),
                      TextButton(onPressed: () => review(i, 'reject'), child: const Text('Reject')),
                    ]),
                  ]),
                ),
            ]),
          ]);
        },
      ),
    );
  }
}

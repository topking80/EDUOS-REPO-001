import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Library loans: the family's (GET /api/library/family-loans) or, for a
/// learner, their own (GET /api/library/my-loans).
class FamilyLibraryScreen extends StatelessWidget {
  const FamilyLibraryScreen({super.key, this.mine = false});
  final bool mine;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<List<Loan>>(
      load: () async => objs((await app.api.get(mine ? '/api/library/my-loans' : '/api/library/family-loans'))['data']).map(Loan.fromJson).toList(),
      builder: (context, loans, _) => ListView(padding: const EdgeInsets.all(16), children: [
        const Text('Current loans, due dates, returns and overdue items. Renewals follow your school library\'s rules.'),
        const SizedBox(height: 12),
        if (loans.isEmpty)
          const EmptyState('No library books on loan.')
        else
          SectionCard(children: [
            for (final l in loans)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(l.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text([
                  if (l.studentName != null) l.studentName!,
                  if (l.returnedAt != null) 'Returned ${fmtDay(l.returnedAt)}' else 'Due ${fmtDay(l.dueAt)}',
                ].join(' · ')),
                trailing: l.returnedAt != null
                    ? const StatusChip('present', text: 'Returned')
                    : l.overdue
                        ? const StatusChip('absent', text: 'Overdue')
                        : const StatusChip('expected', text: 'On loan'),
              ),
          ]),
        const Notice('For renewals, returns or questions, contact your school library.'),
      ]),
    );
  }
}

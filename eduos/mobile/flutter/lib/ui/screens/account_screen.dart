import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/role_tabs.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'web_fallback_screen.dart';

/// Account: who's signed in, switch role, send saved changes, sign out.
class AccountScreen extends StatelessWidget {
  const AccountScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final me = app.me;
    return Scaffold(
      appBar: AppBar(title: const Text('Account')),
      body: Loader<List<Membership>>(
        load: app.memberships,
        builder: (context, memberships, _) => ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(children: [
            Text(me?.displayName ?? '', style: Theme.of(context).textTheme.titleLarge),
            Text('${roleNames[me?.role] ?? me?.role ?? ''} · ${app.brand?.placeName ?? ''}'),
            const SizedBox(height: 4),
            Text(app.server?.host ?? '', style: Theme.of(context).textTheme.bodySmall),
          ]),
          if (memberships.length > 1)
            SectionCard(title: 'Switch role', children: [
              for (final m in memberships)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('${roleNames[m.role] ?? m.role} · ${m.schoolName ?? 'District'}'),
                  trailing: m.role == me?.role && m.schoolId == me?.schoolId
                      ? const StatusChip('present', text: 'Current')
                      : OutlinedButton(
                          onPressed: () async {
                            try {
                              await app.switchMembership(m.id);
                              if (context.mounted) Navigator.of(context).pop();
                            } on ApiException {
                              if (context.mounted) toast(context, 'Couldn\'t switch role.');
                            }
                          },
                          child: const Text('Switch'),
                        ),
                ),
            ]),
          if (app.queued > 0)
            SectionCard(title: 'Saved on this phone', children: [
              Text('${app.queued} change${app.queued == 1 ? '' : 's'} waiting to be sent to the school.'),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: () async {
                  final r = await app.flushQueue();
                  if (context.mounted && r != null) toast(context, r.remaining == 0 ? 'All saved changes sent.' : 'Still offline. ${r.remaining} waiting.');
                },
                child: const Text('Send now'),
              ),
            ]),
          OutlinedButton.icon(
            icon: const Icon(Icons.open_in_new),
            label: const Text('Open the full EduOS site'),
            onPressed: () => openWebApp(context, path: '/'),
          ),
          const SizedBox(height: 8),
          FilledButton.tonalIcon(
            style: FilledButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
            icon: const Icon(Icons.logout),
            label: const Text('Sign out'),
            onPressed: () async {
              if (app.queued > 0) {
                final ok = await confirm(context,
                    title: 'Sign out with unsent changes?',
                    text: '${app.queued} saved change${app.queued > 1 ? 's have' : ' has'} not been sent yet. Signing out deletes them from this phone.',
                    action: 'Sign out',
                    danger: true);
                if (!ok) return;
              }
              await app.signOut();
              if (context.mounted) Navigator.of(context).popUntil((r) => r.isFirst);
            },
          ),
        ]),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../app/role_tabs.dart';
import '../../core/models.dart';
import '../profile_switcher.dart';
import '../widgets.dart';
import 'device_approval_screen.dart';
import 'privacy_screen.dart';
import 'web_fallback_screen.dart';

/// Account: who's signed in, switch profile, send saved changes, sign out.
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
          if (app.readOnly)
            const Notice('This TV can view EduOS but not change anything. Use the EduOS app on your phone or the website to make changes.'),
          SectionCard(title: 'Screens and privacy', children: [
            // Only a phone, tablet or browser approves other screens, never a TV or PC signed in by code.
            if (!app.isDeviceSession)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.connected_tv),
                title: const Text('Sign in a TV or computer'),
                subtitle: const Text('Android TV, Google TV, Fire TV, Roku or Windows: enter the code it shows'),
                onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const DeviceApprovalScreen())),
              ),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.lock_outline),
              title: const Text('Screen lock'),
              subtitle: Text(app.privacy.hasPin ? 'On · locks after ${app.privacy.autoLockMinutes} minutes' : 'Off · set a PIN for a shared screen'),
              onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const PrivacyScreen())),
            ),
          ]),
          if (memberships.length > 1)
            SectionCard(title: 'Switch profile', children: [
              ProfileList(profiles: memberships, onSwitched: () { if (context.mounted) Navigator.of(context).pop(); }),
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
            label: Text(app.isTv ? 'Sign out of this TV' : 'Sign out'),
            onPressed: () async {
              final unsent = app.queued + app.heldForOthers;
              if (unsent > 0) {
                final ok = await confirm(context,
                    title: 'Sign out with unsent changes?',
                    text: '$unsent saved change${unsent > 1 ? 's have' : ' has'} not been sent yet'
                        '${app.heldForOthers > 0 ? ' (${app.heldForOthers} from another account on this phone)' : ''}. Signing out deletes them from this phone.',
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

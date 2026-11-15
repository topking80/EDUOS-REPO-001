import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/app_scope.dart';
import '../../app/role_tabs.dart';
import '../widgets.dart';

/// Opens the EduOS web app in the phone's browser (it signs in separately there).
Future<void> openWebApp(BuildContext context, {required String path}) async {
  final server = AppScope.read(context).server;
  if (server == null) return;
  final ok = await launchUrl(server.resolve(path), mode: LaunchMode.externalApplication);
  if (!ok && context.mounted) toast(context, 'Couldn\'t open the browser.');
}

/// Placeholder for a tab whose native screen ships in a later phase.
class WebFallbackScreen extends StatelessWidget {
  const WebFallbackScreen({super.key, required this.tab});
  final RoleTab tab;

  @override
  Widget build(BuildContext context) {
    return ListView(padding: const EdgeInsets.all(16), children: [
      SectionCard(title: tab.label, children: [
        const Text('This part of EduOS isn\'t in the app yet. It\'s coming in a later update.'),
        const SizedBox(height: 12),
        FilledButton.icon(
          icon: const Icon(Icons.open_in_new),
          label: Text('Open ${tab.label} on the web'),
          onPressed: () => openWebApp(context, path: '/app/#/${tab.id}'),
        ),
      ]),
    ]);
  }
}

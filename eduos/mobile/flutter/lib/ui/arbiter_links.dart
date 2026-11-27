import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import 'widgets.dart';

/// Game scheduling and officials assigning happen in Arbiter, which many state
/// associations and conferences use. These are plain links, the same as the
/// web app's (public/app/app.js ARBITER_LINKS; a test keeps them in step):
/// EduOS sends nothing to Arbiter.
const arbiterLinks = [
  ('Arbiter: sign in', 'https://arbiter.io/'),
  ('Game and event scheduling', 'https://arbiter.io/products/scheduling/'),
  ('Officials assigning', 'https://arbiter.io/products/assigningsoftware/'),
];

class ArbiterLinksCard extends StatelessWidget {
  const ArbiterLinksCard({super.key});

  /// Opens a link in the device's browser. Tests replace it.
  static Future<bool> Function(Uri) opener = (uri) => launchUrl(uri, mode: LaunchMode.externalApplication);

  @override
  Widget build(BuildContext context) => SectionCard(title: 'Scheduling & officials', children: [
        Text('Game schedules and officials\' assignments are managed in Arbiter (opens in your browser). '
            'EduOS doesn\'t send your schedules, rosters or student information there.',
            style: Theme.of(context).textTheme.bodySmall),
        for (final (label, url) in arbiterLinks)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.open_in_new),
            title: Text(label),
            onTap: () async {
              var ok = false;
              try { ok = await opener(Uri.parse(url)); } catch (_) {}
              if (!ok && context.mounted) toast(context, 'Couldn\'t open that link.');
            },
          ),
      ]);
}

import 'package:flutter/material.dart';

import '../app/app_controller.dart';
import '../app/app_scope.dart';
import '../app/role_tabs.dart';
import '../core/api_client.dart';
import '../core/models.dart';
import 'widgets.dart';

/// "Teacher · Maple Elementary", with the district added when the person has
/// profiles in more than one district.
String profileLabel(Membership m, List<Membership> all) {
  final role = roleNames[m.role] ?? m.role;
  final place = m.schoolName ?? (m.schoolId == null ? 'District office' : 'School');
  final districts = all.map((p) => p.districtId).toSet();
  return districts.length > 1 && m.districtName != null ? '$role · $place · ${m.districtName}' : '$role · $place';
}

/// The person's profiles; choosing another one switches the session to it.
class ProfileList extends StatelessWidget {
  const ProfileList({super.key, required this.profiles, this.onSwitched});
  final List<Membership> profiles;
  final VoidCallback? onSwitched;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return Column(mainAxisSize: MainAxisSize.min, children: [
      for (final m in profiles)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(profileLabel(m, profiles)),
          trailing: m.current
              ? const StatusChip('present', text: 'Current')
              : OutlinedButton(
                  onPressed: () => switchProfile(context, app, m, profiles, onSwitched: onSwitched),
                  child: Text('Use', semanticsLabel: 'Use ${profileLabel(m, profiles)}'),
                ),
        ),
    ]);
  }
}

Future<void> switchProfile(BuildContext context, AppController app, Membership m, List<Membership> all, {VoidCallback? onSwitched}) async {
  try {
    await app.switchMembership(m.id);
    onSwitched?.call();
    if (context.mounted) toast(context, 'Now using ${profileLabel(m, all)}');
  } on ApiException {
    if (context.mounted) toast(context, 'Couldn\'t switch profile.');
  }
}

/// Opens the profile list from the top bar.
Future<void> showProfileSheet(BuildContext context) {
  final app = AppScope.of(context);
  final messenger = ScaffoldMessenger.of(context);
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheet) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Switch profile', style: Theme.of(sheet).textTheme.titleLarge),
          const SizedBox(height: 8),
          for (final m in app.profiles)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(m.current ? Icons.check_circle : Icons.account_circle_outlined),
              title: Text(profileLabel(m, app.profiles)),
              selected: m.current,
              onTap: m.current
                  ? () => Navigator.pop(sheet)
                  : () async {
                      Navigator.pop(sheet);
                      try {
                        await app.switchMembership(m.id);
                        messenger.showSnackBar(SnackBar(content: Text('Now using ${profileLabel(m, app.profiles)}')));
                      } on ApiException {
                        messenger.showSnackBar(const SnackBar(content: Text('Couldn\'t switch profile.')));
                      }
                    },
            ),
        ]),
      ),
    ),
  );
}

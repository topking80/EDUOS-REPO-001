import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

const _kindText = {'lockdown': 'LOCKDOWN', 'shelter': 'SHELTER IN PLACE', 'evacuate': 'EVACUATE', 'hold': 'HOLD IN ROOMS'};

/// SafetyOS while an incident is live. Like the web app, this takes over the
/// app for families; they can open pick-up once reunification starts.
class SafetyScreen extends StatelessWidget {
  const SafetyScreen({super.key, this.onOpenPickup});

  final VoidCallback? onOpenPickup;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final live = app.liveIncidents;
    final role = app.me?.role;
    return RefreshIndicator(
      onRefresh: app.refreshStatus,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        if (live.isEmpty) const EmptyState('No emergency is active. The school will alert you here if one starts.'),
        for (final i in live) ...[
          IncidentBanner(i),
          if (role == 'parent')
            SectionCard(title: 'Your children at this school', children: [
              if (i.children == null)
                const Text('Students are with school staff. We will tell you here when and where to collect your child.')
              else
                for (final c in i.children!)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(c.name),
                    trailing: c.released
                        ? StatusChip('present', text: 'Released to ${c.releasedTo ?? 'an adult'} · ${fmtTime(c.releasedAt)}')
                        : const StatusChip('expected', text: 'With staff'),
                  ),
              if (i.reunification && onOpenPickup != null) ...[
                const SizedBox(height: 8),
                FilledButton.icon(onPressed: onOpenPickup, icon: const Icon(Icons.qr_code_2), label: const Text('Show my pick-up pass')),
              ],
            ]),
          if (role == 'pupil') const Notice('Stay with your teacher. Your phone does not need to do anything.'),
          if (role != 'parent' && role != 'pupil')
            const Notice('Staff safety tools (roll call, accountability board) arrive in a later phase of the app. Use the EduOS web app on this phone in the meantime.'),
        ],
        if (live.isNotEmpty && role == 'parent')
          const Notice('Please don\'t call or come to the school unless asked. EduOS shares only what you need here; it never tracks anyone\'s location.'),
      ]),
    );
  }
}

class IncidentBanner extends StatelessWidget {
  const IncidentBanner(this.i, {super.key});
  final Incident i;

  @override
  Widget build(BuildContext context) {
    final color = i.reunification ? const Color(0xFF1E3A8A) : const Color(0xFF991B1B);
    const onColor = Colors.white;
    final title = i.reunification ? 'REUNIFICATION' : (_kindText[i.kind] ?? i.kind.toUpperCase());
    return Semantics(
      liveRegion: true,
      container: true,
      child: Card(
        color: color,
        margin: const EdgeInsets.only(bottom: 12),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: DefaultTextStyle(
            style: const TextStyle(color: onColor),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(i.isDrill ? 'DRILL · THIS IS A DRILL' : 'THIS IS NOT A DRILL', style: const TextStyle(fontWeight: FontWeight.w800, letterSpacing: 1)),
              const SizedBox(height: 8),
              Row(children: [
                const Icon(Icons.shield, color: onColor),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(title, style: const TextStyle(color: onColor, fontSize: 22, fontWeight: FontWeight.w800)),
                    Text('${i.schoolName} · since ${fmtTime(i.startedAt)}'),
                  ]),
                ),
              ]),
              const SizedBox(height: 8),
              Text(i.message, style: const TextStyle(color: onColor, fontSize: 16)),
              if (i.instructions != null) ...[const SizedBox(height: 8), Text('From the school: ${i.instructions}')],
              if (i.reunification && i.reunificationPoint != null) ...[const SizedBox(height: 8), Text('Reunification point: ${i.reunificationPoint}')],
            ]),
          ),
        ),
      ),
    );
  }
}

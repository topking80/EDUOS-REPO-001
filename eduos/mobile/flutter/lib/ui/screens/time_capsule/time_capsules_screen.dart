// Time Capsules on phone, tablet and desktop: invitations, milestone
// confirmations, my capsules and capsules opened for me, plus the family's
// way into each child's history. Mirrors VIEWS.capsules in public/app/app.js.
import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/format.dart';
import '../../../core/history_models.dart';
import '../../../core/models.dart';
import '../../widgets.dart';
import 'capsule_detail_screen.dart';
import 'family_history_screens.dart';
import 'history_review_screen.dart';
import 'history_timeline_screen.dart';
import 'history_widgets.dart';
import 'new_capsule_screen.dart';
import 'sharing_screen.dart';

/// Reads that may be refused for this role (403/404) give [fallback] instead.
Future<T> optional<T>(Future<T> Function() call, T fallback) async {
  try {
    return await call();
  } on ApiException catch (e) {
    if (e.isUnauthorized || e.isOffline) rethrow;
    return fallback;
  }
}

const leaderRoles = {'principal', 'vice_principal', 'superintendent'};

class CapsuleHub {
  const CapsuleHub({required this.capsules, required this.invitations, required this.milestones, required this.children, required this.transfers});
  final List<Capsule> capsules;
  final List<CapsuleInvitation> invitations;
  final List<PendingMilestone> milestones;
  final List<ChildSummary> children;
  final List<FamilyTransfer> transfers;
}

Future<CapsuleHub> loadCapsuleHub(ApiClient api, String role) async {
  final parent = role == 'parent';
  final leader = leaderRoles.contains(role);
  final r = await Future.wait<Object>([
    api.get('/api/history/capsules').then((j) => objs(j['data']).map(Capsule.fromJson).toList()),
    optional(() async => objs((await api.get('/api/history/capsule-invitations'))['data']).map(CapsuleInvitation.fromJson).toList(), <CapsuleInvitation>[]),
    leader ? optional(() async => objs((await api.get('/api/history/capsule-milestones'))['data']).map(PendingMilestone.fromJson).toList(), <PendingMilestone>[]) : Future.value(<PendingMilestone>[]),
    parent ? optional(() async => objs(obj((await api.get('/api/home'))['data'])['children']).map(ChildSummary.fromJson).toList(), <ChildSummary>[]) : Future.value(<ChildSummary>[]),
    parent ? optional(() async => objs((await api.get('/api/family/history-transfers'))['data']).map(FamilyTransfer.fromJson).toList(), <FamilyTransfer>[]) : Future.value(<FamilyTransfer>[]),
  ]);
  return CapsuleHub(
    capsules: r[0] as List<Capsule>,
    invitations: r[1] as List<CapsuleInvitation>,
    milestones: r[2] as List<PendingMilestone>,
    children: r[3] as List<ChildSummary>,
    transfers: r[4] as List<FamilyTransfer>,
  );
}

class TimeCapsulesScreen extends StatefulWidget {
  const TimeCapsulesScreen({super.key});

  @override
  State<TimeCapsulesScreen> createState() => _TimeCapsulesScreenState();
}

class _TimeCapsulesScreenState extends State<TimeCapsulesScreen> {
  String? _selected;
  int _detailVersion = 0;

  Future<void> _open(BuildContext context, String id, Future<void> Function() reload) async {
    if (isWide(context)) {
      setState(() {
        _selected = id;
        _detailVersion++;
      });
      return;
    }
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => CapsuleDetailScreen(capsuleId: id)));
    await reload();
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final role = app.me?.role ?? '';
    return Loader<CapsuleHub>(
      load: () => loadCapsuleHub(app.api, role),
      builder: (context, hub, reload) {
        final list = _HubList(hub: hub, role: role, selected: _selected, onOpen: (id) => _open(context, id, reload), reload: reload);
        if (!isWide(context)) return list;
        return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          SizedBox(width: 420, child: list),
          const VerticalDivider(width: 1),
          Expanded(
            child: _selected == null
                ? const Center(child: EmptyState('Choose a capsule to see it here.'))
                : CapsuleDetailView(key: ValueKey('$_selected/$_detailVersion'), capsuleId: _selected!, onChanged: reload),
          ),
        ]);
      },
    );
  }
}

class _HubList extends StatelessWidget {
  const _HubList({required this.hub, required this.role, required this.selected, required this.onOpen, required this.reload});
  final CapsuleHub hub;
  final String role;
  final String? selected;
  final void Function(String id) onOpen;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final mine = hub.capsules.where((c) => c.mine).toList();
    final received = hub.capsules.where((c) => !c.mine).toList();
    final pendingInvites = hub.invitations.where((i) => i.status != 'released' || i.consent != 'approved').toList();

    Future<void> answer(String capsuleId, String decision) async {
      try {
        await app.api.post('/api/history/capsule-invitations/$capsuleId', {'decision': decision});
        if (context.mounted) toast(context, const {'approved': 'Accepted.', 'denied': 'Declined.', 'withdrawn': 'Withdrawn.'}[decision]!);
        await reload();
      } on ApiException {
        if (context.mounted) toast(context, 'Couldn\'t save your answer.');
      }
    }

    Future<void> release(PendingMilestone m) async {
      final ok = await confirm(context,
          title: 'Release this capsule?',
          text: 'Confirm that ${m.studentName} has reached "${milestoneText[m.milestone] ?? m.milestone}". Recipients who accepted will be able to open it.',
          action: 'Release');
      if (!ok) return;
      try {
        await app.api.post('/api/history/capsules/${m.capsuleId}/release');
        if (context.mounted) toast(context, 'Released.');
        await reload();
      } on ApiException {
        if (context.mounted) toast(context, 'Couldn\'t release it.');
      }
    }

    Widget capsuleTile(Capsule c) => ListTile(
          key: ValueKey('capsule-${c.id}'),
          selected: c.id == selected,
          contentPadding: EdgeInsets.zero,
          leading: Icon(c.isReleased
              ? Icons.mark_email_read_outlined
              : c.isDraft
                  ? Icons.edit_note
                  : Icons.lock_clock_outlined),
          title: Text(c.title, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Text('For ${c.studentName} · ${opensText(c.releaseKind, c.releaseAt, c.milestone, fmtDay)}'),
          trailing: StatusChip(c.status,
              text: capsuleStatusText[c.status] ?? c.status,
              tone: c.isReleased
                  ? ChipTone.good
                  : c.status == 'cancelled'
                      ? ChipTone.bad
                      : c.isDraft
                          ? ChipTone.waiting
                          : ChipTone.info),
          onTap: () => onOpen(c.id),
        );

    // A TV is view-only: it shows capsules and history but makes no changes.
    final readOnly = AppScope.of(context).readOnly;
    return ListView(padding: const EdgeInsets.all(16), children: [
      if (readOnly) const Notice('This TV shows Time Capsules and history. Use the EduOS app on your phone to make or answer a capsule.'),
      if (role == 'parent' && hub.children.isNotEmpty && !readOnly)
        Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: FilledButton.icon(
              icon: const Icon(Icons.add),
              label: const Text('New Time Capsule'),
              onPressed: () async {
                final id = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => NewCapsuleScreen(children: hub.children)));
                await reload();
                if (id != null) onOpen(id);
              },
            ),
          ),
        ),
      if (pendingInvites.isNotEmpty)
        SectionCard(title: 'Capsules for you', children: [
          const Notice('Someone has made a Time Capsule you can receive. You\'ll see what\'s inside only once it opens, and only if you accept.'),
          for (final i in pendingInvites)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(child: Text('From ${i.from}', style: const TextStyle(fontWeight: FontWeight.w600))),
                  StatusChip(i.consent, text: consentText[i.consent] ?? i.consent),
                ]),
                Text('For ${i.studentName} · ${opensText(i.releaseKind, i.releaseAt, i.milestone, fmtDay)}'),
                if (i.status == 'released')
                  const Text('This capsule has opened; you withdrew, so it\'s closed to you.')
                else if (!readOnly)
                  Wrap(spacing: 8, children: [
                    if (i.consent != 'approved') FilledButton.tonal(onPressed: () => answer(i.capsuleId, 'approved'), child: const Text('Accept')),
                    if (i.consent == 'pending') TextButton(onPressed: () => answer(i.capsuleId, 'denied'), child: const Text('Decline')),
                    if (i.consent == 'approved') TextButton(onPressed: () => answer(i.capsuleId, 'withdrawn'), child: const Text('Withdraw')),
                  ]),
              ]),
            ),
        ]),
      if (hub.milestones.isNotEmpty)
        SectionCard(title: 'Waiting for a milestone', children: [
          const Notice('These capsules open when the school confirms the milestone.'),
          for (final m in hub.milestones)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${m.studentName}: ${milestoneText[m.milestone] ?? m.milestone}'),
              subtitle: Text('From ${m.from} · ${m.accepted} recipient${m.accepted == 1 ? '' : 's'} accepted'),
              trailing: readOnly ? null : FilledButton.tonal(onPressed: () => release(m), child: const Text('Release')),
            ),
        ]),
      SectionCard(title: 'My capsules', children: [
        if (mine.isEmpty) EmptyState(role == 'parent' ? 'You haven\'t made a Time Capsule yet.' : 'You have no Time Capsules.'),
        for (final c in mine) capsuleTile(c),
      ]),
      if (received.isNotEmpty) SectionCard(title: 'Opened for you', children: [for (final c in received) capsuleTile(c)]),
      if (role == 'parent' && hub.transfers.isNotEmpty) FamilyTransfersCard(transfers: hub.transfers, onDecided: reload),
      if (role == 'parent')
        for (final child in hub.children) ChildHistoryCard(child: child),
      if (role == 'pupil')
        SectionCard(title: 'My history', children: [
          const Text('Your achievements, work and memories, by school year.'),
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: [
            FilledButton.tonal(
                onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const HistoryTimelineScreen(title: 'My history'))), child: const Text('Open my history')),
            OutlinedButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SharingScreen())), child: const Text('Sharing')),
            OutlinedButton(onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const StorageScreen())), child: const Text('Storage')),
          ]),
        ]),
      if (leaderRoles.contains(role))
        SectionCard(title: 'Student history', children: [
          const Text('Teachers\' items waiting for the school\'s review before families see them.'),
          const SizedBox(height: 8),
          FilledButton.tonal(onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const HistoryReviewScreen())), child: const Text('Review teachers\' items')),
        ]),
    ]);
  }
}

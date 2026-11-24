import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/format.dart';
import '../../../core/history_models.dart';
import '../../../core/models.dart';
import '../../widgets.dart';
import 'history_widgets.dart';

const _eventText = {
  'created': 'Created',
  'sealed': 'Sealed',
  'released': 'Opened',
  'release_blocked': 'Couldn\'t open yet',
  'cancelled': 'Cancelled',
  'item_added': 'Item added',
  'recipient_added': 'Recipient added',
  'scheduled': 'Scheduled to open',
  'release_attempted': 'Tried to open',
};

class CapsuleDetailScreen extends StatelessWidget {
  const CapsuleDetailScreen({super.key, required this.capsuleId});
  final String capsuleId;

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('Time Capsule')),
        body: CapsuleDetailView(capsuleId: capsuleId),
      );
}

/// One capsule (GET /api/history/capsules/:id). The owner manages a draft
/// here: edit, add history items and recipients, seal or cancel it.
class CapsuleDetailView extends StatelessWidget {
  const CapsuleDetailView({super.key, required this.capsuleId, this.onChanged});
  final String capsuleId;
  final Future<void> Function()? onChanged;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<CapsuleDetail>(
      load: () async => CapsuleDetail.fromJson(obj((await app.api.get('/api/history/capsules/$capsuleId'))['data'])),
      builder: (context, d, reload) => _CapsuleBody(
          detail: d,
          reload: () async {
            await reload();
            await onChanged?.call();
          }),
    );
  }
}

class _CapsuleBody extends StatelessWidget {
  const _CapsuleBody({required this.detail, required this.reload});
  final CapsuleDetail detail;
  final Future<void> Function() reload;

  Capsule get c => detail.capsule;

  Future<void> _act(BuildContext context, Future<Object?> Function(ApiClient api) call, String done, {String failed = 'Couldn\'t save that.'}) async {
    final app = AppScope.read(context);
    try {
      await call(app.api);
      if (context.mounted) toast(context, done);
      await reload();
    } on ApiException catch (e) {
      if (!context.mounted) return;
      toast(
          context,
          switch (e.error) {
            'capsule_not_a_draft' => 'This capsule is already sealed.',
            'recipient_not_eligible' => 'That person can\'t receive this capsule.',
            'history_item_not_found' => 'That item isn\'t available any more.',
            'legal_hold' => 'This student\'s history is on hold; the capsule can\'t change now.',
            _ => failed,
          });
    }
  }

  Future<void> _edit(BuildContext context) async {
    final title = TextEditingController(text: c.title), message = TextEditingController(text: c.message);
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Edit capsule'),
        content: SizedBox(
          width: 480,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: title, maxLength: 180, decoration: const InputDecoration(labelText: 'Title')),
            TextField(controller: message, maxLength: 12000, minLines: 3, maxLines: 8, decoration: const InputDecoration(labelText: 'Message')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(context, title.text.trim().isNotEmpty), child: const Text('Save')),
        ],
      ),
    );
    if (ok != true || !context.mounted) return;
    await _act(context, (api) => api.patch('/api/history/capsules/${c.id}', {'title': title.text.trim(), 'message': message.text.trim()}), 'Saved.');
  }

  Future<void> _addItem(BuildContext context) async {
    final api = AppScope.read(context).api;
    List<Candidate> options;
    try {
      options = objs((await api.get('/api/history/capsules/${c.id}/candidates'))['data']).map(Candidate.fromJson).toList();
    } on ApiException {
      if (context.mounted) toast(context, 'Couldn\'t load history items.');
      return;
    }
    if (!context.mounted) return;
    final picked = await showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      builder: (context) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.7),
          child: ListView(shrinkWrap: true, children: [
            const ListTile(title: Text('Add from the history', style: TextStyle(fontWeight: FontWeight.w600))),
            if (options.isEmpty) const EmptyState('Every item you can see is already in this capsule.'),
            for (final o in options)
              ListTile(
                title: Text(o.title),
                subtitle: Text([historyKindText[o.kind] ?? o.kind, historyTypeText[o.entryType] ?? o.entryType, fmtDay(o.occurredAt)].join(' · ')),
                onTap: () => Navigator.pop(context, o.id),
              ),
          ]),
        ),
      ),
    );
    if (picked == null || !context.mounted) return;
    await _act(context, (api) => api.post('/api/history/capsules/${c.id}/items', {'entryId': picked}), 'Added to the capsule.');
  }

  Future<void> _addRecipient(BuildContext context) async {
    final api = AppScope.read(context).api;
    List<RecipientOption> options;
    try {
      options = objs((await api.get('/api/history/capsule-recipient-options?studentId=${c.studentId}'))['data']).map(RecipientOption.fromJson).toList();
    } on ApiException {
      if (context.mounted) toast(context, 'Couldn\'t load who can receive it.');
      return;
    }
    final already = detail.recipients.map((r) => r.userId).toSet();
    options = options.where((o) => !already.contains(o.userId)).toList();
    if (!context.mounted) return;
    final picked = await showModalBottomSheet<RecipientOption>(
      context: context,
      builder: (context) => SafeArea(
        child: ListView(shrinkWrap: true, children: [
          const ListTile(title: Text('Who should receive it?', style: TextStyle(fontWeight: FontWeight.w600))),
          if (options.isEmpty) const EmptyState('Everyone who can receive this capsule is already on it.'),
          for (final o in options) ListTile(title: Text(o.name), subtitle: Text(recipientTypeText[o.type] ?? o.type), onTap: () => Navigator.pop(context, o)),
        ]),
      ),
    );
    if (picked == null || !context.mounted) return;
    await _act(context, (api) => api.post('/api/history/capsules/${c.id}/recipients', {'userId': picked.userId, 'type': picked.type}), '${picked.name} was invited. They\'ll be asked to accept.');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final owner = c.mine;
    final draft = c.isDraft;
    final canCancel = owner && (c.status == 'draft' || c.status == 'scheduled' || c.status == 'sealed');
    return ReadableList(children: [
      Semantics(header: true, child: Text(c.title, style: theme.textTheme.headlineSmall)),
      const SizedBox(height: 4),
      Wrap(spacing: 8, runSpacing: 4, crossAxisAlignment: WrapCrossAlignment.center, children: [
        StatusChip(c.status,
            text: capsuleStatusText[c.status] ?? c.status,
            tone: c.isReleased
                ? ChipTone.good
                : c.status == 'cancelled'
                    ? ChipTone.bad
                    : ChipTone.info),
        Text('For ${c.studentName} · ${opensText(c.releaseKind, c.releaseAt, c.milestone, fmtDay)}'),
      ]),
      const SizedBox(height: 12),
      if (c.message.isNotEmpty) SectionCard(title: 'Message', children: [SelectableText(c.message)]),
      if (owner && draft)
        SectionCard(title: 'Get it ready', children: [
          const Notice('Add history items and the people who should receive it, then seal it. After sealing, nothing inside can change.'),
          Wrap(spacing: 8, runSpacing: 8, children: [
            OutlinedButton.icon(onPressed: () => _edit(context), icon: const Icon(Icons.edit_outlined), label: const Text('Edit')),
            OutlinedButton.icon(onPressed: () => _addItem(context), icon: const Icon(Icons.library_add_outlined), label: const Text('Add history item')),
            OutlinedButton.icon(onPressed: () => _addRecipient(context), icon: const Icon(Icons.person_add_alt), label: const Text('Add recipient')),
            FilledButton.icon(
              icon: const Icon(Icons.lock_outline),
              label: const Text('Seal'),
              onPressed: () async {
                final ok = await confirm(context,
                    title: 'Seal this capsule?',
                    text: 'Nothing inside can change after it\'s sealed. It opens ${c.releaseKind == 'milestone' ? 'when the school confirms the milestone' : 'on ${fmtDay(c.releaseAt)}'}.',
                    action: 'Seal');
                if (ok && context.mounted) {
                  await _act(context, (api) => api.post('/api/history/capsules/${c.id}/seal'), 'Sealed.', failed: 'Couldn\'t seal it. A capsule needs at least one item and one recipient.');
                }
              },
            ),
          ]),
        ]),
      if (c.isReleased || owner || detail.items.isNotEmpty)
        SectionCard(title: 'Inside', children: [
          if (detail.items.isEmpty && detail.photos.isEmpty)
            EmptyState(c.isReleased
                ? 'This capsule is empty.'
                : owner
                    ? 'Nothing added yet.'
                    : 'You\'ll see what\'s inside when it opens.'),
          PhotoStrip(detail.photos),
          for (final i in detail.items)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: i.withheld
                  ? const Text('An item here isn\'t shared with you.', style: TextStyle(fontStyle: FontStyle.italic))
                  : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(i.title ?? '', style: const TextStyle(fontWeight: FontWeight.w600)),
                      Text(
                          [if (i.kind != null) historyKindText[i.kind] ?? i.kind!, if (i.entryType != null) historyTypeText[i.entryType] ?? i.entryType!, fmtDay(i.occurredAt)]
                              .where((s) => s.isNotEmpty)
                              .join(' · '),
                          style: theme.textTheme.bodySmall),
                      if ((i.body ?? '').isNotEmpty) Padding(padding: const EdgeInsets.only(top: 4), child: Text(i.body!)),
                      PhotoStrip(i.photos),
                    ]),
            ),
        ]),
      if (owner)
        SectionCard(title: 'Recipients', children: [
          if (detail.recipients.isEmpty) const EmptyState('No one yet.'),
          for (final r in detail.recipients)
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text(r.name),
              subtitle: Text(recipientTypeText[r.type] ?? r.type),
              trailing: StatusChip(r.consent,
                  text: consentText[r.consent] ?? r.consent,
                  tone: r.consent == 'approved'
                      ? ChipTone.good
                      : r.consent == 'pending'
                          ? ChipTone.waiting
                          : ChipTone.bad),
            ),
        ]),
      if (owner && detail.events.isNotEmpty)
        SectionCard(title: 'History of this capsule', children: [
          for (final e in detail.events) Text('${_eventText[e.type] ?? statusLabel(e.type)}${e.reason != null ? ' · ${statusLabel(e.reason!)}' : ''} · ${fmtDay(e.at)} ${fmtTime(e.at)}'),
        ]),
      if (canCancel)
        Align(
          alignment: Alignment.centerLeft,
          child: TextButton.icon(
            style: TextButton.styleFrom(foregroundColor: theme.colorScheme.error),
            icon: const Icon(Icons.delete_outline),
            label: const Text('Cancel this capsule'),
            onPressed: () async {
              final ok = await confirm(context, title: 'Cancel this capsule?', text: 'It won\'t open for anyone, and its own photos are deleted.', action: 'Cancel capsule', danger: true);
              if (ok && context.mounted) await _act(context, (api) => api.post('/api/history/capsules/${c.id}/cancel'), 'Cancelled.');
            },
          ),
        ),
    ]);
  }
}

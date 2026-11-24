// The family side of a child's history: the timeline, family memories the
// family adds, teachers' items waiting for the family, history transfers to
// a new district, and the storage dashboard (TC-11).
import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/format.dart';
import '../../../core/history_models.dart';
import '../../../core/models.dart';
import '../../widgets.dart';
import '../web_fallback_screen.dart' show openWebApp;
import 'history_timeline_screen.dart';
import 'history_widgets.dart';

void _push(BuildContext context, Widget screen) => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));

class ChildHistoryCard extends StatelessWidget {
  const ChildHistoryCard({super.key, required this.child});
  final ChildSummary child;

  @override
  Widget build(BuildContext context) {
    final name = firstName(child.name);
    return SectionCard(title: '${child.name}\'s history', children: [
      Text('$name\'s achievements, school records and family memories, by school year.'),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        FilledButton.tonal(onPressed: () => _push(context, HistoryTimelineScreen(studentId: child.id, title: '$name\'s history')), child: const Text('History')),
        OutlinedButton(onPressed: () => _push(context, FamilyMemoriesScreen(child: child)), child: const Text('Family memories')),
        OutlinedButton(onPressed: () => _push(context, FromTeachersScreen(child: child)), child: const Text('From teachers')),
        OutlinedButton(onPressed: () => _push(context, StorageScreen(studentId: child.id)), child: const Text('Storage')),
      ]),
    ]);
  }
}

const _contributionStatus = {'submitted': 'With the school', 'approved': 'Added to the history', 'rejected': 'Not added', 'withdrawn': 'Withdrawn'};

/// A guardian's own family memories for one child.
class FamilyMemoriesScreen extends StatelessWidget {
  const FamilyMemoriesScreen({super.key, required this.child});
  final ChildSummary child;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final base = '/api/family/children/${child.id}/history-contributions';
    return Scaffold(
      appBar: AppBar(title: const Text('Family memories')),
      body: Loader<List<Contribution>>(
        load: () async => objs((await app.api.get(base))['data']).map(Contribution.fromJson).toList(),
        builder: (context, items, reload) => ReadableList(children: [
          const Notice('Share a memory for the school to add to the history. The school reviews it first.'),
          _NewMemoryForm(path: base, onSaved: reload),
          SectionCard(title: 'What you\'ve shared', children: [
            if (items.isEmpty) const EmptyState('Nothing yet.'),
            for (final m in items)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text(m.title, style: const TextStyle(fontWeight: FontWeight.w600))),
                    StatusChip(m.status,
                        text: _contributionStatus[m.status] ?? statusLabel(m.status),
                        tone: m.status == 'approved'
                            ? ChipTone.good
                            : m.status == 'submitted'
                                ? ChipTone.waiting
                                : ChipTone.bad),
                  ]),
                  Text(fmtDay(m.occurredAt), style: Theme.of(context).textTheme.bodySmall),
                  if (m.body.isNotEmpty) Text(m.body),
                  if (m.reviewNote != null && m.reviewNote!.isNotEmpty) Notice('School: ${m.reviewNote}'),
                  PhotoStrip(m.photos),
                  if (m.status == 'submitted')
                    TextButton(
                      onPressed: () async {
                        if (!await confirm(context, title: 'Withdraw this memory?', action: 'Withdraw')) return;
                        try {
                          await app.api.patch('$base/${m.id}', {'decision': 'withdraw'});
                          if (context.mounted) toast(context, 'Withdrawn.');
                          await reload();
                        } on ApiException {
                          if (context.mounted) toast(context, 'Couldn\'t withdraw it.');
                        }
                      },
                      child: const Text('Withdraw'),
                    ),
                ]),
              ),
          ]),
        ]),
      ),
    );
  }
}

class _NewMemoryForm extends StatefulWidget {
  const _NewMemoryForm({required this.path, required this.onSaved});
  final String path;
  final Future<void> Function() onSaved;

  @override
  State<_NewMemoryForm> createState() => _NewMemoryFormState();
}

class _NewMemoryFormState extends State<_NewMemoryForm> {
  final _title = TextEditingController(), _body = TextEditingController();
  DateTime _when = DateTime.now();
  bool _busy = false;

  @override
  void dispose() {
    _title.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_title.text.trim().isEmpty) return toast(context, 'Give the memory a title.');
    setState(() => _busy = true);
    try {
      await AppScope.read(context).api.post(widget.path, {'title': _title.text.trim(), 'body': _body.text.trim(), 'occurredAt': _when.toUtc().toIso8601String()});
      _title.clear();
      _body.clear();
      if (mounted) toast(context, 'Sent to the school for review.');
      await widget.onSaved();
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t send it.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => SectionCard(title: 'Add a memory', children: [
        TextField(controller: _title, maxLength: 180, decoration: const InputDecoration(labelText: 'Title')),
        TextField(controller: _body, maxLength: 12000, minLines: 2, maxLines: 6, decoration: const InputDecoration(labelText: 'The story (optional)')),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: const Icon(Icons.event),
          title: Text('When: ${fmtDay(_when)} ${_when.year}'),
          trailing: TextButton(
            onPressed: () async {
              final d = await showDatePicker(context: context, firstDate: DateTime(1990), lastDate: DateTime.now(), initialDate: _when);
              if (d != null) setState(() => _when = d);
            },
            child: const Text('Change'),
          ),
        ),
        FilledButton(onPressed: _busy ? null : _save, child: Text(_busy ? 'Sending…' : 'Send to the school')),
      ]);
}

/// Teachers' items the school approved, waiting for the family to keep or decline.
class FromTeachersScreen extends StatelessWidget {
  const FromTeachersScreen({super.key, required this.child});
  final ChildSummary child;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('From teachers')),
      body: Loader<List<HistoryItem>>(
        load: () async => objs((await app.api.get('/api/family/children/${child.id}/history-items/pending'))['data']).map(HistoryItem.fromJson).toList(),
        builder: (context, items, reload) {
          Future<void> decide(HistoryItem i, String decision) async {
            String? reason;
            if (decision == 'decline') {
              reason = await showModalBottomSheet<String>(
                context: context,
                builder: (context) => SafeArea(
                  child: ListView(shrinkWrap: true, children: [
                    const ListTile(title: Text('Why not keep it?', style: TextStyle(fontWeight: FontWeight.w600))),
                    for (final r in historyReasons) ListTile(title: Text(r.$2), onTap: () => Navigator.pop(context, r.$1)),
                  ]),
                ),
              );
              if (reason == null) return;
            }
            try {
              await app.api.post('/api/family/children/${child.id}/history-items/${i.id}', {'decision': decision, if (reason != null) 'reasonCode': reason});
              if (context.mounted) toast(context, decision == 'accept' ? 'Kept in the history.' : 'Declined.');
              await reload();
            } on ApiException {
              if (context.mounted) toast(context, 'Couldn\'t save that.');
            }
          }

          return ReadableList(children: [
            const Notice('Teachers\' items appear here after the school approves them. Nothing is added to the history until you keep it.'),
            SectionCard(children: [
              if (items.isEmpty) const EmptyState('Nothing waiting for you.'),
              for (final i in items)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(i.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                    Text([historyTypeText[i.entryType] ?? i.entryType, if (i.authorName != null) 'from ${i.authorName}', fmtDay(i.occurredAt)].join(' · '),
                        style: Theme.of(context).textTheme.bodySmall),
                    if (i.body.isNotEmpty) Text(i.body),
                    PhotoStrip(i.photos),
                    Wrap(spacing: 8, children: [
                      FilledButton.tonal(onPressed: () => decide(i, 'accept'), child: const Text('Keep')),
                      TextButton(onPressed: () => decide(i, 'decline'), child: const Text('Decline')),
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

/// Requests to send a child's history to a new district.
class FamilyTransfersCard extends StatelessWidget {
  const FamilyTransfersCard({super.key, required this.transfers, required this.onDecided});
  final List<FamilyTransfer> transfers;
  final Future<void> Function() onDecided;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    Future<void> decide(FamilyTransfer t, String decision) async {
      if (decision == 'approve' &&
          !await confirm(context, title: 'Send ${t.studentName}\'s history?', text: 'A copy goes to ${t.receivingDistrict}. ${t.school} keeps its own records.', action: 'Approve')) {
        return;
      }
      try {
        await app.api.post('/api/family/history-transfers/${t.id}', {'decision': decision});
        if (context.mounted) toast(context, decision == 'approve' ? 'Approved.' : 'Declined.');
        await onDecided();
      } on ApiException catch (e) {
        if (context.mounted) toast(context, e.error == 'already_decided' ? 'This was already decided.' : 'Couldn\'t save that.');
      }
    }

    return SectionCard(title: 'History transfers', children: [
      const Notice('A new school district asked for a copy of your child\'s history. Nothing is sent until you approve.'),
      for (final t in transfers)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${t.studentName} → ${t.receivingDistrict}', style: const TextStyle(fontWeight: FontWeight.w600)),
            Text('From ${t.school} · ${statusLabel(t.basis)}${t.note != null && t.note!.isNotEmpty ? ' · ${t.note}' : ''}'),
            Wrap(spacing: 8, children: [
              FilledButton.tonal(onPressed: () => decide(t, 'approve'), child: const Text('Approve')),
              TextButton(onPressed: () => decide(t, 'decline'), child: const Text('Decline')),
            ]),
          ]),
        ),
    ]);
  }
}

/// TC-11: how much of the district's storage limit a child's history uses.
class StorageScreen extends StatelessWidget {
  const StorageScreen({super.key, this.studentId});
  final String? studentId;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final path = studentId == null ? '/api/history/storage' : '/api/history/storage?studentId=$studentId';
    return Scaffold(
      appBar: AppBar(title: const Text('Storage')),
      body: Loader<StorageDashboard?>(
        load: () async {
          try {
            return StorageDashboard.fromJson(obj((await app.api.get(path))['data']));
          } on ApiException catch (e) {
            // Servers without TC-11 (or a history this person can't see).
            if (e.status == 404) return null;
            rethrow;
          }
        },
        builder: (context, d, _) {
          if (d == null) return const ReadableList(children: [EmptyState('Storage details aren\'t available on this school server yet.')]);
          final theme = Theme.of(context);
          return ReadableList(children: [
            SectionCard(title: '${d.studentName}\'s history', children: [
              Text('${fmtBytes(d.usedBytes)} of ${fmtBytes(d.maxBytesPerStudent)} used (${d.percent.toStringAsFixed(d.percent < 10 ? 1 : 0)}%)'),
              const SizedBox(height: 8),
              Semantics(
                label: '${d.percent.round()} percent of the storage limit used',
                child: LinearProgressIndicator(value: (d.percent / 100).clamp(0, 1), minHeight: 10, borderRadius: BorderRadius.circular(5)),
              ),
              const SizedBox(height: 8),
              Text('${d.photos} photo${d.photos == 1 ? '' : 's'}${d.inLongTermStorage > 0 ? ', ${d.inLongTermStorage} in long-term storage' : ''}'),
              if (!d.roomForAnotherPhoto) Text('There isn\'t room for another full-size photo.', style: TextStyle(color: theme.colorScheme.error)),
            ]),
            SectionCard(title: 'Items', children: [
              Wrap(spacing: 24, runSpacing: 12, children: [
                StatTile(d.inHistory, 'In the history'),
                StatTile(d.waitingForReview, 'Waiting for review'),
                StatTile(d.drafts, 'Drafts'),
              ]),
              if (d.myContributions != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text('Your memories: ${d.myContributions!['waiting']} waiting, ${d.myContributions!['accepted']} accepted, '
                      '${d.myContributions!['declined']} declined, ${d.myContributions!['withdrawn']} withdrawn'),
                ),
            ]),
            SectionCard(title: 'The district\'s limits', children: [
              Text(d.photosAllowed ? 'Photos are allowed: up to ${fmtBytes(d.maxPhotoBytes)} each, ${d.maxPhotosPerItem} per item.' : 'The district hasn\'t turned on photos.'),
              for (final g in d.guidance) Notice(g),
            ]),
            if (d.capsules.isNotEmpty)
              SectionCard(title: 'Time Capsules', children: [
                for (final c in d.capsules)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    title: Text(c.title),
                    subtitle: Text(c.on != null ? 'Opens ${fmtDay(c.on)} ${c.on!.year}' : 'Opens at: ${milestoneText[c.milestone] ?? 'a milestone'}'),
                    trailing: StatusChip(c.status, text: capsuleStatusText[c.status] ?? c.status, tone: ChipTone.info),
                  ),
              ]),
            SectionCard(title: 'Keeping records', children: [
              Text(d.retentionText),
              if (d.recordsScheduleRef.isNotEmpty) Text('Records schedule: ${d.recordsScheduleRef}', style: theme.textTheme.bodySmall),
              if (d.exportHref != null)
                TextButton.icon(
                  icon: const Icon(Icons.download_outlined),
                  label: const Text('Download a copy (on the EduOS website)'),
                  onPressed: () => openWebApp(context, path: d.exportHref!),
                ),
            ]),
            Notice(d.donationsText),
          ]);
        },
      ),
    );
  }
}

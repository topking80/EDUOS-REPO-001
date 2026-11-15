import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

class _Inbox {
  const _Inbox(this.threads, this.announcements);
  final List<ThreadSummary> threads;
  final List<Announcement> announcements;
}

/// Conversations and announcements (GET /api/comms/threads, /api/comms/announcements).
class MessagesScreen extends StatefulWidget {
  const MessagesScreen({super.key});

  @override
  State<MessagesScreen> createState() => _MessagesScreenState();
}

class _MessagesScreenState extends State<MessagesScreen> {
  bool _news = false;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<_Inbox>(
      load: () async {
        final threads = objs((await app.api.get('/api/comms/threads'))['data']).map(ThreadSummary.fromJson).toList();
        List<Announcement> news = const [];
        try {
          news = objs((await app.api.get('/api/comms/announcements'))['data']).map(Announcement.fromJson).toList();
        } on ApiException catch (e) {
          if (e.isUnauthorized) rethrow;
        }
        return _Inbox(threads, news);
      },
      builder: (context, inbox, reload) => ListView(padding: const EdgeInsets.all(16), children: [
        SegmentedButton<bool>(
          segments: const [ButtonSegment(value: false, label: Text('Conversations')), ButtonSegment(value: true, label: Text('Announcements'))],
          selected: {_news},
          onSelectionChanged: (v) => setState(() => _news = v.first),
        ),
        const SizedBox(height: 12),
        if (_news)
          SectionCard(children: [AnnouncementList(inbox.announcements, onChanged: reload)])
        else ...[
          FilledButton.icon(
            onPressed: () async {
              await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const ComposeScreen()));
              await reload();
            },
            icon: const Icon(Icons.send),
            label: const Text('New message'),
          ),
          const SizedBox(height: 12),
          SectionCard(children: [
            if (inbox.threads.isEmpty) const EmptyState('No conversations yet.'),
            for (final t in inbox.threads)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(t.subject, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${t.withNames}${t.studentName != null ? ' · about ${firstName(t.studentName!)}' : ''} · ${ago(t.lastMessageAt)}\n'
                    '${t.lastBody ?? '(message hidden by a moderator)'}', maxLines: 3, overflow: TextOverflow.ellipsis),
                isThreeLine: true,
                trailing: t.unread > 0
                    ? StatusChip('current', text: '${t.unread} new')
                    : t.status == 'locked'
                        ? const StatusChip('expected', text: 'Locked')
                        : null,
                onTap: () async {
                  await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ThreadScreen(threadId: t.id)));
                  await reload();
                },
              ),
          ]),
        ],
      ]),
    );
  }
}

class AnnouncementList extends StatelessWidget {
  const AnnouncementList(this.items, {super.key, this.onChanged});
  final List<Announcement> items;
  final Future<void> Function()? onChanged;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const EmptyState('No announcements yet.');
    final app = AppScope.read(context);
    return Column(children: [
      for (final a in items)
        Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Row(children: [
              Expanded(child: Text(a.title, style: Theme.of(context).textTheme.titleSmall)),
              if (a.unread) const StatusChip('current', text: 'New'),
            ]),
            const SizedBox(height: 4),
            Text(a.body),
            const SizedBox(height: 4),
            Text('${a.scope == 'class' ? 'Class · ${a.classTeacherName ?? a.authorName}' : 'Whole school'} · ${a.authorName} · ${ago(a.createdAt)}',
                style: Theme.of(context).textTheme.bodySmall),
            if (a.unread)
              TextButton(
                onPressed: () async {
                  try {
                    await app.api.post('/api/comms/announcements/${a.id}/read');
                    if (context.mounted) toast(context, 'Marked as read');
                    await onChanged?.call();
                  } on ApiException {
                    if (context.mounted) toast(context, 'Couldn\'t mark as read.');
                  }
                },
                child: const Text('Mark read'),
              ),
          ]),
        ),
    ]);
  }
}

/// One conversation with reply, report and read receipts (GET /api/comms/threads/:id).
class ThreadScreen extends StatefulWidget {
  const ThreadScreen({super.key, required this.threadId});
  final String threadId;

  @override
  State<ThreadScreen> createState() => _ThreadScreenState();
}

class _ThreadScreenState extends State<ThreadScreen> {
  final _reply = TextEditingController();
  bool _sending = false;
  Key _loaderKey = UniqueKey();

  @override
  void dispose() {
    _reply.dispose();
    super.dispose();
  }

  void _refresh() => setState(() => _loaderKey = UniqueKey());

  Future<void> _send() async {
    final body = _reply.text.trim();
    if (body.isEmpty) return;
    setState(() => _sending = true);
    try {
      await AppScope.read(context).api.post('/api/comms/threads/${widget.threadId}/messages', {'body': body});
      _reply.clear();
      _refresh();
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t send.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _report(Message m) async {
    final reason = await promptText(context,
        title: 'Report this message',
        text: 'A school leader will review it. The sender is not told who reported it.',
        label: 'Why are you reporting it?',
        action: 'Report');
    if (reason == null || !mounted) return;
    try {
      await AppScope.read(context).api.post('/api/comms/messages/${m.id}/report', {'reason': reason});
      if (mounted) toast(context, 'Reported to the school');
      _refresh();
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t report.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final meId = app.me?.userId;
    return Scaffold(
      appBar: AppBar(title: const Text('Conversation')),
      body: Loader<ThreadDetail>(
        key: _loaderKey,
        load: () async => ThreadDetail.fromJson(obj((await app.api.get('/api/comms/threads/${widget.threadId}'))['data'])),
        builder: (context, t, _) {
          final others = t.participants.entries.where((e) => e.key != meId).map((e) => e.value).join(', ');
          return Column(children: [
            Expanded(
              child: ListView(padding: const EdgeInsets.all(16), children: [
                Text(t.subject, style: Theme.of(context).textTheme.titleLarge),
                Text('${t.kind == 'family' ? 'About ${t.studentName ?? ''} · ' : 'Staff · '}with $others', style: Theme.of(context).textTheme.bodySmall),
                const SizedBox(height: 12),
                for (final m in t.messages) _Bubble(m, mine: m.authorId == meId, onReport: () => _report(m)),
              ]),
            ),
            if (t.status == 'open')
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                  child: Row(children: [
                    Expanded(child: TextField(controller: _reply, maxLength: 4000, minLines: 1, maxLines: 5, decoration: const InputDecoration(labelText: 'Reply', counterText: ''))),
                    IconButton.filled(tooltip: 'Send', onPressed: _sending ? null : _send, icon: const Icon(Icons.send)),
                  ]),
                ),
              )
            else
              Padding(padding: const EdgeInsets.all(16), child: Notice('This conversation was locked by the school${t.lockReason != null ? ': ${t.lockReason}' : ''}.')),
          ]);
        },
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble(this.m, {required this.mine, required this.onReport});
  final Message m;
  final bool mine;
  final VoidCallback onReport;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final meta = '${mine ? 'You' : m.authorName} · ${fmtTime(m.createdAt)}'
        '${mine ? (m.readBy.isNotEmpty ? ' · Read by ${m.readBy.map(firstName).join(', ')}' : ' · Sent') : ''}';
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 320),
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(color: mine ? scheme.primaryContainer : scheme.surfaceContainerHighest, borderRadius: BorderRadius.circular(14)),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          m.hidden ? const Text('Hidden by a moderator', style: TextStyle(fontStyle: FontStyle.italic)) : Text(m.body),
          const SizedBox(height: 4),
          Text(meta, style: Theme.of(context).textTheme.bodySmall),
          if (!mine && !m.hidden)
            Align(alignment: Alignment.centerRight, child: TextButton(onPressed: onReport, child: Text('Report', semanticsLabel: 'Report message from ${m.authorName}'))),
        ]),
      ),
    );
  }
}

/// Start a conversation with someone from GET /api/comms/contacts.
class ComposeScreen extends StatefulWidget {
  const ComposeScreen({super.key});

  @override
  State<ComposeScreen> createState() => _ComposeScreenState();
}

class _ComposeScreenState extends State<ComposeScreen> {
  final _subject = TextEditingController(), _body = TextEditingController();
  Contact? _to;
  bool _sending = false;

  @override
  void dispose() {
    _subject.dispose();
    _body.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final app = AppScope.read(context);
    final to = _to;
    if (to == null || _subject.text.trim().isEmpty || _body.text.trim().isEmpty) {
      toast(context, 'Choose who to message, and add a subject and message.');
      return;
    }
    // Same rule as the web app: family conversations are about a learner.
    final familyRole = const {'parent', 'teacher', 'principal'}.contains(app.me?.role);
    final family = to.studentId != null && familyRole;
    setState(() => _sending = true);
    try {
      final res = await app.api.post('/api/comms/threads', {
        'kind': family ? 'family' : 'staff',
        'subject': _subject.text.trim(),
        'body': _body.text.trim(),
        'participantIds': [to.userId],
        if (family) 'studentId': to.studentId,
      });
      if (!mounted) return;
      final id = str(obj(res.data)['id']);
      Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => ThreadScreen(threadId: id)));
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'participant_not_allowed' ? 'You can\'t message that person here.' : 'Couldn\'t send.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Scaffold(
      appBar: AppBar(title: const Text('New message')),
      body: Loader<List<Contact>>(
        load: () async => objs((await app.api.get('/api/comms/contacts'))['data']).map(Contact.fromJson).toList(),
        builder: (context, contacts, _) => ListView(padding: const EdgeInsets.all(16), children: [
          if (contacts.isEmpty)
            const EmptyState('There\'s nobody you can message yet.')
          else ...[
            DropdownButtonFormField<Contact>(
              value: _to,
              isExpanded: true,
              decoration: const InputDecoration(labelText: 'To'),
              items: [
                for (final c in contacts)
                  DropdownMenuItem(value: c, child: Text('${c.name} (${c.role})${c.studentName != null ? ' · about ${c.studentName}' : ''}', overflow: TextOverflow.ellipsis)),
              ],
              onChanged: (c) => setState(() => _to = c),
            ),
            TextField(controller: _subject, maxLength: 160, decoration: const InputDecoration(labelText: 'Subject')),
            TextField(controller: _body, maxLength: 4000, minLines: 4, maxLines: 10, decoration: const InputDecoration(labelText: 'Message')),
            const Notice('Family conversations are between a learner\'s guardians and the staff who work with them. School leaders can review reported messages.'),
            FilledButton.icon(onPressed: _sending ? null : _send, icon: const Icon(Icons.send), label: const Text('Send')),
          ],
        ]),
      ),
    );
  }
}

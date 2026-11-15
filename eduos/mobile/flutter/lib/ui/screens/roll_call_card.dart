import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

const _rollCallOptions = [('present', 'Present'), ('missing', 'Missing'), ('injured', 'Injured')];

/// SafetyOS roll call for a teacher's class during a live incident
/// (GET/POST /api/safety/incidents/:id/rollcall). Sending is offline-safe:
/// with no signal the roll call is kept on the phone and sent as soon as the
/// phone reconnects, stamped with when it was taken, and the server still
/// accepts it if the incident has since closed.
class RollCallCard extends StatefulWidget {
  const RollCallCard({super.key, required this.incident});
  final Incident incident;

  @override
  State<RollCallCard> createState() => _RollCallCardState();
}

class _RollCallCardState extends State<RollCallCard> {
  RollCall? _data;
  Object? _error;
  final Map<String, String> _marks = {};
  final List<RollCallLearner> _extras = [];
  final _search = TextEditingController();
  DateTime? _submittedAt;
  bool _savedOnPhone = false;
  bool _sending = false;

  String get _base => '/api/safety/incidents/${widget.incident.id}';

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final d = RollCall.fromJson(obj((await AppScope.read(context).api.get('$_base/rollcall'))['data']));
      if (!mounted) return;
      setState(() {
        _data = d;
        _error = null;
        _extras
          ..clear()
          ..addAll(d.extras);
        for (final l in [...d.learners, ...d.extras]) {
          if (l.status != null) _marks.putIfAbsent(l.studentId, () => l.status!);
        }
        _submittedAt = d.submittedAt;
      });
    } on Object catch (e) {
      if (mounted) setState(() => _error = e);
    }
  }

  Future<void> _addExtra() async {
    final q = _search.text.trim();
    final d = _data;
    if (q.length < 2 || d == null) return;
    try {
      final found = objs((await AppScope.read(context).api.get('$_base/students?q=${Uri.encodeQueryComponent(q)}'))['data'])
          .map(RollCallLearner.fromJson)
          .where((f) => !d.learners.any((l) => l.studentId == f.studentId) && !_extras.any((x) => x.studentId == f.studentId))
          .toList();
      if (!mounted) return;
      if (found.isEmpty) return toast(context, 'No learner found at this school.');
      setState(() {
        _extras.add(found.first);
        _marks[found.first.studentId] = 'extra';
        _search.clear();
      });
    } on ApiException catch (e) {
      if (mounted) toast(context, e.isOffline ? 'Searching needs a connection. Mark your own class and send.' : 'Couldn\'t search.');
    }
  }

  Future<void> _send() async {
    final d = _data!;
    final entries = [for (final e in _marks.entries) {'studentId': e.key, 'status': e.value}];
    if (entries.isEmpty) return toast(context, 'Mark at least one learner.');
    final unmarked = d.learners.where((l) => !_marks.containsKey(l.studentId)).length;
    if (unmarked > 0) {
      final ok = await confirm(context,
          title: 'Send roll call?',
          text: '$unmarked learner${unmarked > 1 ? 's are' : ' is'} not marked yet. You can send now and update later.',
          action: 'Send now');
      if (!ok || !mounted) return;
    }
    setState(() => _sending = true);
    final app = AppScope.read(context);
    try {
      final sent = await app.api.post('$_base/rollcall', {'entries': entries});
      if (!mounted) return;
      setState(() {
        _submittedAt = DateTime.now();
        _savedOnPhone = sent.queued;
      });
      if (sent.queued) {
        await app.refreshStatus();
        if (mounted) toast(context, 'Roll call saved on this phone. It sends as soon as you\'re back online.');
      } else {
        final c = obj(obj(sent.data)['counts']);
        toast(context, 'Roll call sent: ${integer(c['present'])} present, ${integer(c['missing'])} missing, ${integer(c['injured'])} injured');
      }
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t send. Try again.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final d = _data;
    if (d == null) {
      return SectionCard(title: 'Roll call · my class', children: [
        if (_error == null)
          const Center(child: Padding(padding: EdgeInsets.all(16), child: CircularProgressIndicator()))
        else ...[
          Text(_error is ApiException && (_error as ApiException).isOffline
              ? 'You\'re offline, so your class list can\'t load. Keep your class together and try again when you have signal.'
              : 'Couldn\'t load your class list.'),
          TextButton(onPressed: _load, child: const Text('Retry')),
        ],
      ]);
    }
    return SectionCard(title: 'Roll call · my class', children: [
      Text(_savedOnPhone
          ? 'Saved on this phone ${fmtTime(_submittedAt)}. It sends as soon as you\'re back online.'
          : _submittedAt != null
              ? 'Last sent ${fmtTime(_submittedAt)}. You can update it any time.'
              : 'Mark everyone, then send. The office sees it right away.'),
      const SizedBox(height: 8),
      if (d.learners.isEmpty) const EmptyState('No learners on your roster.'),
      for (final l in d.learners)
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(l.name, style: const TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            SegmentedButton<String>(
              emptySelectionAllowed: true,
              showSelectedIcon: false,
              segments: [for (final (v, t) in _rollCallOptions) ButtonSegment(value: v, label: Text(t))],
              selected: {if (_marks[l.studentId] case final s? when _rollCallOptions.any((o) => o.$1 == s)) s},
              onSelectionChanged: (v) {
                if (v.isNotEmpty) setState(() => _marks[l.studentId] = v.first);
              },
            ),
          ]),
        ),
      if (_extras.isNotEmpty) ...[
        const SizedBox(height: 8),
        Text('Also in my room', style: Theme.of(context).textTheme.titleSmall),
        for (final x in _extras)
          ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(x.name), trailing: const StatusChip('current', text: 'Extra')),
      ],
      Row(children: [
        Expanded(
          child: TextField(
            controller: _search,
            maxLength: 60,
            textInputAction: TextInputAction.search,
            onSubmitted: (_) => _addExtra(),
            decoration: const InputDecoration(labelText: 'Add a learner who is with you', counterText: ''),
          ),
        ),
        TextButton(onPressed: _addExtra, child: const Text('Add')),
      ]),
      const SizedBox(height: 8),
      FilledButton.icon(
        style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
        onPressed: _sending ? null : _send,
        icon: const Icon(Icons.check),
        label: const Text('Send roll call'),
      ),
    ]);
  }
}

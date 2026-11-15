import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

const _kindText = {'lockdown': 'LOCKDOWN', 'shelter': 'SHELTER IN PLACE', 'evacuate': 'EVACUATE', 'hold': 'HOLD IN ROOMS'};
const _reasonText = {
  'pass_expired': 'Pass expired',
  'pass_revoked': 'Pass replaced or cancelled',
  'adult_not_approved': 'Adult not approved',
  'safety_incident_live': 'Paused: safety alert',
  'do_not_release': 'Do not release',
};

/// Staff pick-up (GET /api/pickup/queue, POST /api/pickup/verify|release|deny).
/// Always online: identity is checked live and nothing is queued. Leaders also
/// get the Approvals view.
class StaffPickupScreen extends StatefulWidget {
  const StaffPickupScreen({super.key});

  @override
  State<StaffPickupScreen> createState() => _StaffPickupScreenState();
}

class _StaffPickupScreenState extends State<StaffPickupScreen> {
  bool _approvals = false;

  @override
  Widget build(BuildContext context) {
    final role = AppScope.of(context).me?.role;
    final lead = role == 'principal' || role == 'superintendent';
    return Column(children: [
      if (lead)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
          child: SegmentedButton<bool>(
            segments: const [ButtonSegment(value: false, label: Text('Pick-up line')), ButtonSegment(value: true, label: Text('Approvals'))],
            selected: {_approvals},
            onSelectionChanged: (v) => setState(() => _approvals = v.first),
          ),
        ),
      Expanded(
        child: _approvals
            ? const PickupApprovals()
            : role == 'superintendent'
                ? ListView(padding: const EdgeInsets.all(16), children: const [Notice('Pick-up is verified by staff at each school.')])
                : const _PickupLine(),
      ),
    ]);
  }
}

class _PickupLine extends StatefulWidget {
  const _PickupLine();

  @override
  State<_PickupLine> createState() => _PickupLineState();
}

class _PickupLineState extends State<_PickupLine> {
  final _code = TextEditingController();
  PassCheck? _check;
  String? _checkedCode;
  String? _error;
  bool _busy = false;
  Key _queueKey = UniqueKey();

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  void _reset() => setState(() {
        _check = null;
        _checkedCode = null;
        _error = null;
        _code.clear();
        _queueKey = UniqueKey();
      });

  Future<void> _verify() async {
    final code = _code.text.trim();
    if (code.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
      _check = null;
    });
    try {
      final res = await AppScope.read(context).api.post('/api/pickup/verify', {'code': code});
      if (!mounted) return;
      setState(() {
        _check = PassCheck.fromJson(obj(res.data));
        _checkedCode = code;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _error = switch (e.status) {
              404 => 'not_recognised',
              429 => 'too_many',
              _ => e.isOffline ? 'offline' : 'error',
            });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return ListView(padding: const EdgeInsets.all(16), children: [
      SectionCard(title: 'Check a pick-up pass', children: [
        TextField(
          controller: _code,
          autocorrect: false,
          enableSuggestions: false,
          textCapitalization: TextCapitalization.characters,
          maxLength: 16,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) => _verify(),
          decoration: const InputDecoration(labelText: 'Pass code (type it or use a handheld scanner)', hintText: 'e.g. 7KQ2M-X9PDA'),
        ),
        FilledButton.icon(
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          onPressed: _busy ? null : _verify,
          icon: const Icon(Icons.qr_code_2),
          label: const Text('Check pass'),
        ),
      ]),
      if (_error != null)
        Semantics(
          liveRegion: true,
          child: SectionCard(color: const Color(0xFFFDE2E1), children: [
            Text(switch (_error) {
              'not_recognised' => 'Pass not recognised',
              'too_many' => 'Too many tries',
              _ => 'Couldn\'t check',
            }, style: Theme.of(context).textTheme.titleLarge),
            Text(switch (_error) {
              'not_recognised' => 'Do not release. Ask for another pass or call the office.',
              'offline' => 'You\'re offline. Releases need a connection; do not release until the pass is checked.',
              _ => 'Wait a moment and try again.',
            }),
          ]),
        ),
      if (_check != null) _PassResult(check: _check!, code: _checkedCode!, onDone: _reset),
      InlineLoader<PickupQueue>(
        key: _queueKey,
        load: () async => PickupQueue.fromJson(obj((await app.api.get('/api/pickup/queue'))['data'])),
        builder: (context, q) => Column(children: [
          if (q.incidentStatus != null)
            Notice(q.incidentStatus == 'reunification'
                ? 'Reunification in progress: releases are logged to the incident.'
                : '${_kindText[q.incidentKind] ?? 'Safety alert'} in effect: releases are paused until reunification or all clear.'),
          SectionCard(title: 'Waiting (${q.waiting.length})', children: [
            if (q.waiting.isEmpty) const EmptyState('Nobody waiting.'),
            for (final w in q.waiting)
              ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${w.name} · ${w.adult}'), trailing: StatusChip('expected', text: fmtTime(w.at))),
          ]),
          SectionCard(title: 'Released today (${q.released.length})', children: [
            if (q.released.isEmpty) const EmptyState('No releases yet today.'),
            for (final w in q.released.take(20))
              ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text('${w.name} → ${w.adult} (${w.relationship ?? ''})'), trailing: StatusChip('present', text: fmtTime(w.at))),
            if (q.blocked > 0 || q.denied > 0) Text('${q.blocked} blocked · ${q.denied} refused today', style: Theme.of(context).textTheme.bodySmall),
          ]),
          if (q.earlyDismissals.isNotEmpty)
            SectionCard(title: 'Early dismissals today', children: [
              for (final e in q.earlyDismissals)
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text('${str(e['time'])} · ${str(e['student_name'])} → ${str(e['adult_name'])}'),
                  trailing: e['status'] == 'released' ? const StatusChip('present', text: 'Released') : const StatusChip('expected', text: 'Approved'),
                ),
            ]),
        ]),
      ),
      const Notice('Look at the adult\'s photo ID and compare the name. EduOS stores only that you checked: no photos, ID numbers or face data.'),
    ]);
  }
}

class _PassResult extends StatefulWidget {
  const _PassResult({required this.check, required this.code, required this.onDone});
  final PassCheck check;
  final String code;
  final VoidCallback onDone;

  @override
  State<_PassResult> createState() => _PassResultState();
}

class _PassResultState extends State<_PassResult> {
  late final Set<String> _picked = widget.check.eligible.map((s) => s.studentId).toSet();
  bool _idChecked = false;
  bool _custodyChecked = false;
  bool _busy = false;

  Future<void> _release() async {
    final v = widget.check;
    final custody = v.eligible.any((s) => s.custodyOrder);
    if (!_idChecked) return toast(context, 'Check the photo ID first.');
    if (custody && !_custodyChecked) return toast(context, 'Confirm the custody order first.');
    if (_picked.isEmpty) return toast(context, 'Choose who is going home.');
    setState(() => _busy = true);
    try {
      final res = await AppScope.read(context).api.post('/api/pickup/release', {
        'code': widget.code,
        'studentIds': _picked.toList(),
        'idChecked': true,
        'custodyAcknowledged': custody && _custodyChecked,
      });
      if (!mounted) return;
      final names = objs(obj(res.data)['released']).map((x) => firstName(str(x['name']))).join(', ');
      toast(context, 'Released: $names');
      widget.onDone();
    } on ApiException catch (e) {
      if (mounted) {
        toast(context, switch (e.error) {
          'release_blocked' => 'Blocked. Do not release.',
          'custody_order_acknowledgement_required' => 'Confirm the custody order first.',
          _ => e.isOffline ? 'You\'re offline. Do not release until it goes through.' : 'Couldn\'t release.',
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _refuse() async {
    final reason = await promptText(context, title: 'Refuse this release?', label: 'Reason (e.g. ID didn\'t match)', action: 'Refuse');
    if (reason == null || !mounted) return;
    try {
      await AppScope.read(context).api.post('/api/pickup/deny', {'code': widget.code, 'reason': reason});
      if (!mounted) return;
      toast(context, 'Refused and logged. The office was told.');
      widget.onDone();
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t log the refusal. Keep the learner with staff.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final v = widget.check;
    if (v.blocked) {
      return Semantics(
        liveRegion: true,
        child: SectionCard(color: const Color(0xFF991B1B), children: [
          const Text('DO NOT RELEASE', style: TextStyle(color: Colors.white, fontSize: 26, fontWeight: FontWeight.w800)),
          const SizedBox(height: 8),
          Text(v.instructions, style: const TextStyle(color: Colors.white)),
          Text('${v.adultName} · ${v.relationship}', style: const TextStyle(color: Colors.white70)),
        ]),
      );
    }
    final eligible = v.eligible;
    final custody = eligible.any((s) => s.custodyOrder);
    return Semantics(
      liveRegion: true,
      container: true,
      child: SectionCard(color: eligible.isEmpty ? const Color(0xFFFDE2E1) : const Color(0xFFDDF3E4), children: [
        Text(v.reunification ? 'Reunification release' : v.pass == 'valid' ? 'Valid pass' : 'Pass ${v.pass}', style: Theme.of(context).textTheme.bodySmall),
        Text(v.adultName, style: Theme.of(context).textTheme.headlineSmall),
        Text('${v.relationship} · ${v.adultKind == 'guardian' ? 'guardian' : 'authorized adult'}'),
        const SizedBox(height: 8),
        for (final s in v.students) ...[
          if (s.eligible)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _picked.contains(s.studentId),
              onChanged: (on) => setState(() => on == true ? _picked.add(s.studentId) : _picked.remove(s.studentId)),
              title: Text('${s.name} · gr ${s.grade}'),
              secondary: StatusChip('present', text: s.earlyDismissalTime != null ? 'Early dismissal ${s.earlyDismissalTime}' : 'Can go'),
            )
          else
            ListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('${s.name} · gr ${s.grade}'),
              trailing: StatusChip('absent', text: _reasonText[s.reason] ?? s.reason ?? 'Not eligible'),
            ),
          if (s.custodyOrder) Text('Custody order: ${s.flagDetail ?? 'check the documents on file'}', style: const TextStyle(fontWeight: FontWeight.w700)),
        ],
        if (eligible.isEmpty)
          const Text('Nobody can be released with this pass.')
        else ...[
          if (custody)
            CheckboxListTile(
              contentPadding: EdgeInsets.zero,
              value: _custodyChecked,
              onChanged: (on) => setState(() => _custodyChecked = on ?? false),
              title: const Text('I checked the custody order allows this release'),
            ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: _idChecked,
            onChanged: (on) => setState(() => _idChecked = on ?? false),
            title: Text('I checked a photo ID and it matches ${v.adultName}'),
          ),
          Row(children: [
            Expanded(
              child: FilledButton(
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
                onPressed: _busy ? null : _release,
                child: const Text('Release'),
              ),
            ),
            const SizedBox(width: 8),
            OutlinedButton(
              style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error, minimumSize: const Size(0, 52)),
              onPressed: _busy ? null : _refuse,
              child: const Text('Refuse'),
            ),
          ]),
        ],
      ]),
    );
  }
}

/// Leaders: adults to approve, early dismissal requests, custody and
/// do-not-release restrictions (GET /api/pickup/admin).
class PickupApprovals extends StatefulWidget {
  const PickupApprovals({super.key});

  @override
  State<PickupApprovals> createState() => _PickupApprovalsState();
}

class _PickupApprovalsState extends State<PickupApprovals> {
  Key _key = UniqueKey();

  void _reload() => setState(() => _key = UniqueKey());

  Future<void> _act(String path, Map<String, Object?> body, String done) async {
    try {
      await AppScope.read(context).api.post(path, body);
      if (mounted) toast(context, done);
      _reload();
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t save. Try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<(Json, List<Json>)>(
      key: _key,
      load: () async {
        final admin = obj((await app.api.get('/api/pickup/admin'))['data']);
        List<Json> students = const [];
        try {
          students = objs((await app.api.get('/api/students?limit=200'))['data']);
        } on ApiException catch (e) {
          if (e.isUnauthorized) rethrow;
        }
        return (admin, students);
      },
      builder: (context, data, _) {
        final (d, students) = data;
        final pending = objs(d['pendingAdults']), early = objs(d['earlyDismissals']), restrictions = objs(d['restrictions']);
        return ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(title: 'Adults to approve (${pending.length})', children: [
            if (pending.isEmpty) const EmptyState('Nothing to approve.'),
            for (final a in pending) ...[
              Text('${str(a['full_name'])} · ${str(a['relationship'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
              Text('For ${str(a['student_name'])} · asked by ${str(a['requested_by_name'])} · ${ago(date(a['requested_at']))}', style: Theme.of(context).textTheme.bodySmall),
              Row(children: [
                FilledButton(onPressed: () => _act('/api/pickup/adults/${str(a['id'])}/decision', {'decision': 'approve'}, 'Approved'), child: const Text('Approve')),
                const SizedBox(width: 8),
                OutlinedButton(
                  onPressed: () async {
                    final note = await promptText(context, title: 'Don\'t approve ${str(a['full_name'])}?', label: 'Note for the family', action: 'Don\'t approve');
                    if (note != null) await _act('/api/pickup/adults/${str(a['id'])}/decision', {'decision': 'reject', 'note': note}, 'Declined');
                  },
                  child: const Text('Decline'),
                ),
              ]),
              const Divider(),
            ],
          ]),
          SectionCard(title: 'Early dismissal requests (${early.length})', children: [
            if (early.isEmpty) const EmptyState('No requests.'),
            for (final e in early) ...[
              Text('${str(e['student_name'])} · ${fmtDay(date(e['dismissal_date']))} ${str(e['time'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
              Text('${str(e['adult_name'])} · ${str(e['reason'])}', style: Theme.of(context).textTheme.bodySmall),
              Row(children: [
                FilledButton(onPressed: () => _act('/api/pickup/early-dismissals/${str(e['id'])}/decision', {'decision': 'approve'}, 'Approved'), child: const Text('Approve')),
                const SizedBox(width: 8),
                OutlinedButton(onPressed: () => _act('/api/pickup/early-dismissals/${str(e['id'])}/decision', {'decision': 'decline'}, 'Declined'), child: const Text('Decline')),
              ]),
              const Divider(),
            ],
          ]),
          SectionCard(title: 'Custody and do-not-release', children: [
            if (restrictions.isEmpty) const EmptyState('None on file.'),
            for (final r in restrictions)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text('${str(r['student_name'])}: ${r['kind'] == 'do_not_release' ? 'do not release to ${str(r['person_name'], 'named adult')}' : 'custody order'}'),
                subtitle: Text('${str(r['detail'])}${boolean(r['document_on_file']) ? ' · document on file' : ''}'),
                trailing: TextButton(
                  onPressed: () async {
                    if (await confirm(context, title: 'Lift this restriction?', action: 'Lift', danger: true)) {
                      await _act('/api/pickup/restrictions/${str(r['id'])}/lift', const {}, 'Lifted');
                    }
                  },
                  child: Text('Lift', semanticsLabel: 'Lift restriction for ${str(r['student_name'])}'),
                ),
              ),
            const Divider(),
            _RestrictionForm(students: students, onSaved: _reload),
            const Notice('Only school leaders see these. Staff on the pick-up line see a flag, never the file.'),
          ]),
        ]);
      },
    );
  }
}

class _RestrictionForm extends StatefulWidget {
  const _RestrictionForm({required this.students, required this.onSaved});
  final List<Json> students;
  final VoidCallback onSaved;

  @override
  State<_RestrictionForm> createState() => _RestrictionFormState();
}

class _RestrictionFormState extends State<_RestrictionForm> {
  String? _student;
  String _kind = 'do_not_release';
  final _person = TextEditingController(), _detail = TextEditingController();
  bool _document = false;

  @override
  void dispose() {
    _person.dispose();
    _detail.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_student == null || _detail.text.trim().isEmpty) return toast(context, 'Choose a learner and add the detail.');
    try {
      await AppScope.read(context).api.post('/api/pickup/restrictions', {
        'studentId': _student,
        'kind': _kind,
        'personName': _person.text.trim().isEmpty ? null : _person.text.trim(),
        'detail': _detail.text.trim(),
        'documentOnFile': _document,
      });
      if (!mounted) return;
      toast(context, 'Saved');
      widget.onSaved();
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t save. A do-not-release needs a name.');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Add a restriction', style: Theme.of(context).textTheme.titleSmall),
      DropdownButtonFormField<String>(
        value: _student,
        isExpanded: true,
        decoration: const InputDecoration(labelText: 'Learner'),
        items: [
          for (final s in widget.students)
            DropdownMenuItem(value: str(s['id']), child: Text('${str(s['display_name'])} (${str(s['grade_level'], '-')})', overflow: TextOverflow.ellipsis)),
        ],
        onChanged: (v) => setState(() => _student = v),
      ),
      DropdownButtonFormField<String>(
        value: _kind,
        decoration: const InputDecoration(labelText: 'Type'),
        items: const [
          DropdownMenuItem(value: 'do_not_release', child: Text('Do not release to')),
          DropdownMenuItem(value: 'custody_order', child: Text('Custody order on file')),
        ],
        onChanged: (v) => setState(() => _kind = v ?? _kind),
      ),
      TextField(controller: _person, maxLength: 120, decoration: const InputDecoration(labelText: 'Person\'s full name (for do-not-release)')),
      TextField(controller: _detail, maxLength: 500, decoration: const InputDecoration(labelText: 'Detail (e.g. court order number)')),
      CheckboxListTile(contentPadding: EdgeInsets.zero, value: _document, onChanged: (v) => setState(() => _document = v ?? false), title: const Text('Document on file')),
      OutlinedButton(onPressed: _save, child: const Text('Add restriction')),
    ]);
  }
}

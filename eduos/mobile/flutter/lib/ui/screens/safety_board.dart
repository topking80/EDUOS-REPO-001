import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

const kindText = {'lockdown': 'LOCKDOWN', 'shelter': 'SHELTER IN PLACE', 'evacuate': 'EVACUATE', 'hold': 'HOLD IN ROOMS'};
const kindHelp = {
  'lockdown': 'Threat inside or near the building',
  'shelter': 'Weather or hazardous air',
  'evacuate': 'Leave the building',
  'hold': 'Keep halls clear',
};
const _eventText = {
  'initiated': 'Started',
  'confirmed': 'Confirmed and alerted',
  'cancelled': 'Cancelled',
  'expired': 'Expired unconfirmed',
  'rollcall': 'Roll call',
  'responders': 'First responders',
  'note': 'Note',
  'reunification': 'Reunification started',
  'released': 'Released at pick-up',
  'all_clear': 'All clear',
  'debrief': 'Debrief written',
};

/// School leaders during a live incident: accountability from teachers' roll
/// calls, missing and injured, the incident log, and the actions (responders,
/// note, reunification, all clear). GET /api/safety/incidents/:id/board.
class SafetyBoardCards extends StatefulWidget {
  const SafetyBoardCards({super.key, required this.incident, this.onOpenPickup});
  final Incident incident;
  final VoidCallback? onOpenPickup;

  @override
  State<SafetyBoardCards> createState() => _SafetyBoardCardsState();
}

class _SafetyBoardCardsState extends State<SafetyBoardCards> {
  Key _key = UniqueKey();

  String get _base => '/api/safety/incidents/${widget.incident.id}';

  void _reload() => setState(() => _key = UniqueKey());

  Future<void> _post(String path, Map<String, Object?> body, {String? done, bool refreshStatus = false}) async {
    final app = AppScope.read(context);
    try {
      await app.api.post(path, body);
      if (mounted && done != null) toast(context, done);
      if (refreshStatus) await app.refreshStatus();
      _reload();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.isOffline ? 'You\'re offline. This needs a connection.' : 'Couldn\'t save. Try again.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final i = widget.incident;
    final app = AppScope.read(context);
    return InlineLoader<SafetyBoard>(
      key: _key,
      load: () async => SafetyBoard.fromJson(obj((await app.api.get('$_base/board'))['data'])),
      builder: (context, b) {
        final enrolled = b.total('enrolled'), accounted = b.total('accounted');
        final done = b.teachers.where((t) => t.submittedAt != null).length;
        List<Widget> names(List<BoardPerson> list, String empty) => list.isEmpty
            ? [EmptyState(empty)]
            : [for (final p in list) ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(p.name, style: const TextStyle(fontWeight: FontWeight.w600)), subtitle: p.detail.isEmpty ? null : Text(p.detail))];
        return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          SectionCard(title: 'Accountability', children: [
            Text('$accounted of $enrolled accounted for'),
            const SizedBox(height: 8),
            Semantics(
              label: '$accounted of $enrolled accounted for',
              child: LinearProgressIndicator(value: enrolled == 0 ? 0 : accounted / enrolled, minHeight: 10),
            ),
            const SizedBox(height: 12),
            Wrap(runSpacing: 12, children: [
              for (final (k, label, warn) in [
                ('present', 'present', false),
                ('missing', 'missing', true),
                ('injured', 'injured', true),
                ('unaccounted', 'not reported yet', true),
                ('extra', 'in another room', false),
                ('released', 'released to family', false),
              ])
                SizedBox(width: 104, child: StatTile(b.total(k), label, warnWhenPositive: warn)),
            ]),
          ]),
          SectionCard(title: 'Missing', children: names(b.missing, 'No one reported missing.')),
          SectionCard(title: 'Injured', children: names(b.injured, 'No injuries reported.')),
          SectionCard(title: 'Roll call by class ($done/${b.teachers.length})', children: [
            for (final t in b.teachers)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text('${t.name} · ${t.roster} learners'),
                trailing: t.submittedAt != null ? StatusChip('present', text: 'Sent ${fmtTime(t.submittedAt)}') : const StatusChip('expected', text: 'Waiting'),
              ),
          ]),
          if (b.unaccounted.isNotEmpty)
            SectionCard(title: 'Not reported yet', children: [
              ...names(b.unaccounted.take(12).toList(), ''),
              if (b.unaccounted.length > 12) Text('and ${b.unaccounted.length - 12} more', style: Theme.of(context).textTheme.bodySmall),
            ]),
          SectionCard(title: 'Actions', children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              OutlinedButton(
                onPressed: () async {
                  final d = await promptText(context, title: 'Log first responders', label: 'What happened? (e.g. police on scene)', action: 'Log it');
                  if (d != null) await _post('$_base/events', {'event': 'responders', 'detail': d}, done: 'Logged');
                },
                child: const Text('First responders'),
              ),
              OutlinedButton(
                onPressed: () async {
                  final d = await promptText(context, title: 'Add to the incident log', label: 'Note (no student details)', action: 'Add note');
                  if (d != null) await _post('$_base/events', {'event': 'note', 'detail': d}, done: 'Added');
                },
                child: const Text('Log a note'),
              ),
              if (i.status == 'active')
                FilledButton.tonal(
                  onPressed: () async {
                    final point = await promptText(context,
                        title: 'Start reunification',
                        text: 'Families are told where to go and to bring photo ID and their pick-up pass. Students are released only through pick-up verification.',
                        label: 'Reunification point',
                        action: 'Start reunification');
                    if (point != null) await _post('$_base/reunification', {'point': point}, done: 'Reunification started', refreshStatus: true);
                  },
                  child: const Text('Start reunification'),
                )
              else if (widget.onOpenPickup != null)
                FilledButton.tonalIcon(onPressed: widget.onOpenPickup, icon: const Icon(Icons.directions_car), label: const Text('Release at pick-up')),
              FilledButton(
                onPressed: () async {
                  final what = i.isDrill ? 'drill' : (kindText[i.kind] ?? i.kind).toLowerCase();
                  final ok = await confirm(context,
                      title: 'All clear: end the $what?',
                      text: 'Everyone at the school, its drivers and families are told that normal operations resume.',
                      action: 'Yes, all clear',
                      danger: true);
                  if (ok) await _post('$_base/all-clear', {'kind': i.kind}, done: 'All clear sent', refreshStatus: true);
                },
                child: const Text('All clear'),
              ),
            ]),
          ]),
          if (b.delivery case final d?)
            SectionCard(title: 'Alert delivery', children: [
              Wrap(runSpacing: 12, children: [
                SizedBox(width: 104, child: StatTile(d.inApp, 'in the EduOS app')),
                SizedBox(width: 104, child: StatTile(d.opened, 'opened')),
                if (d.externalTotal > 0) SizedBox(width: 104, child: StatTile(d.externalConfirmed, 'email/SMS/push confirmed')),
                if (d.externalTotal > 0) SizedBox(width: 104, child: StatTile(d.externalWaiting, 'email/SMS/push waiting', warnWhenPositive: true)),
                if (d.externalFailed > 0) SizedBox(width: 104, child: StatTile(d.externalFailed, 'email/SMS/push failed', warnWhenPositive: true)),
              ]),
              const SizedBox(height: 8),
              Text(d.externalTotal > 0
                  ? 'Email, SMS and push count as delivered only when the channel confirms it.'
                  : 'Email, SMS and push are not set up, so alerts go to the EduOS app only.'),
              const Text('EduOS does not contact 911 or other emergency services. Call them directly.'),
            ]),
          SectionCard(title: 'Incident log', children: [
            for (final e in b.events)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: Text(fmtTime(e.at)),
                title: Text('${_eventText[e.event] ?? e.event}${e.detail != null ? ': ${e.detail}' : ''} · ${e.actorName}'),
              ),
          ]),
          const Notice('Counts come from teachers\' roll calls. EduOS does not use cameras, location, facial recognition or threat scores.'),
        ]);
      },
    );
  }
}

/// Start an alert (two steps: create, then confirm within 2 minutes) and,
/// for leaders, recent incidents with debriefs. POST /api/safety/incidents.
class SafetyCenterScreen extends StatefulWidget {
  const SafetyCenterScreen({super.key, this.embedded = false});

  /// Shown inside a tab (no app bar of its own).
  final bool embedded;

  @override
  State<SafetyCenterScreen> createState() => _SafetyCenterScreenState();
}

class _SafetyCenterScreenState extends State<SafetyCenterScreen> {
  String _kind = 'lockdown';
  bool _drill = true;
  String? _schoolId;
  final _notes = TextEditingController();
  bool _busy = false;
  Key _pastKey = UniqueKey();

  @override
  void dispose() {
    _notes.dispose();
    super.dispose();
  }

  Future<void> _start() async {
    final app = AppScope.read(context);
    setState(() => _busy = true);
    try {
      final created = obj((await app.api.post('/api/safety/incidents', {
        'kind': _kind,
        'isDrill': _drill,
        if (_notes.text.trim().isNotEmpty) 'instructions': _notes.text.trim(),
        if (_schoolId != null) 'schoolId': _schoolId,
      }))
          .data);
      if (!mounted) return;
      final id = str(created['id']);
      final label = kindText[_kind]!;
      final yes = await confirm(context,
          title: 'Start ${_drill ? 'a DRILL' : 'a REAL'} $label?',
          text: 'Everyone at ${str(created['schoolName'], 'the school')}, its bus drivers and families are alerted now${_drill ? ', marked as a drill' : ''}. Confirm within 2 minutes.',
          action: 'Yes, start ${_drill ? 'drill' : label.toLowerCase()}',
          danger: true);
      if (!yes) {
        try {
          await app.api.post('/api/safety/incidents/$id/cancel');
        } on ApiException {
          // An unconfirmed alert expires on its own after 2 minutes.
        }
        if (mounted) toast(context, 'Not started');
        return;
      }
      await app.api.post('/api/safety/incidents/$id/confirm', {'kind': _kind, 'isDrill': _drill});
      await app.refreshStatus();
      if (mounted && !widget.embedded) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) {
        toast(context, switch (e) {
          ApiException(error: 'incident_already_live') => 'An alert is already active.',
          ApiException(status: 410) => 'Took too long. Start again.',
          ApiException(isOffline: true) => 'You\'re offline. Call 911 in an emergency; alerts need a connection.',
          _ => 'Couldn\'t start the alert.',
        });
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final superintendent = app.me?.role == 'superintendent';
    final body = ListView(padding: const EdgeInsets.all(16), children: [
        if (app.canInitiateSafety)
          SectionCard(title: 'Start an alert', children: [
            for (final k in kindText.keys)
              Card(
                color: k == _kind ? Theme.of(context).colorScheme.errorContainer : null,
                child: RadioListTile<String>(
                  value: k,
                  groupValue: _kind,
                  onChanged: (v) => setState(() => _kind = v ?? _kind),
                  title: Text(kindText[k]!, style: const TextStyle(fontWeight: FontWeight.w800)),
                  subtitle: Text(kindHelp[k]!),
                ),
              ),
            const SizedBox(height: 8),
            SegmentedButton<bool>(
              segments: const [ButtonSegment(value: true, label: Text('Drill')), ButtonSegment(value: false, label: Text('Real emergency'))],
              selected: {_drill},
              onSelectionChanged: (v) => setState(() => _drill = v.first),
            ),
            if (superintendent)
              InlineLoader<List<Json>>(
                load: () async => objs((await app.api.get('/api/schools'))['data']).where((s) => s['status'] != 'inactive').toList(),
                builder: (context, schools) => DropdownButtonFormField<String>(
                  value: _schoolId,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: 'School'),
                  items: [for (final s in schools) DropdownMenuItem(value: str(s['id']), child: Text(str(s['name'])))],
                  onChanged: (v) => setState(() => _schoolId = v),
                ),
              ),
            TextField(controller: _notes, maxLength: 500, minLines: 2, maxLines: 4, decoration: const InputDecoration(labelText: 'Short note for staff (optional, not sent to families)')),
            FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error, minimumSize: const Size.fromHeight(56)),
              onPressed: _busy || (superintendent && _schoolId == null) ? null : _start,
              icon: const Icon(Icons.shield),
              label: const Text('Continue'),
            ),
            Text('Step 1 of 2. Nothing is sent until you confirm.', style: Theme.of(context).textTheme.bodySmall),
          ])
        else
          const SectionCard(children: [Text('Your school leaders start safety alerts. Call 911 in an emergency.')]),
        if (app.canLeadSafety)
          InlineLoader<List<PastIncident>>(
            key: _pastKey,
            load: () async => objs((await app.api.get('/api/safety/incidents'))['data']).map(PastIncident.fromJson).toList(),
            builder: (context, past) => SectionCard(title: 'Recent incidents and drills', children: [
              if (past.isEmpty) const EmptyState('No incidents or drills yet.'),
              for (final x in past.take(8))
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('${x.label}${x.isDrill ? ' (drill)' : ''}'),
                  subtitle: Text('${x.schoolName} · ${fmtDay(x.startedAt)} ${fmtTime(x.startedAt)} · ${x.status}'),
                  trailing: x.debriefed
                      ? const StatusChip('present', text: 'Debriefed')
                      : x.status == 'closed'
                          ? TextButton(
                              onPressed: () async {
                                final t = await promptText(context,
                                    title: 'Debrief', text: 'What went well and what to fix. No student names.', label: 'Debrief notes', action: 'Save debrief', maxLength: 4000);
                                if (t == null || !context.mounted) return;
                                try {
                                  await app.api.post('/api/safety/incidents/${x.id}/debrief', {'text': t});
                                  if (context.mounted) toast(context, 'Debrief saved');
                                  setState(() => _pastKey = UniqueKey());
                                } on ApiException {
                                  if (context.mounted) toast(context, 'Couldn\'t save the debrief.');
                                }
                              },
                              child: const Text('Debrief'),
                            )
                          : null,
                ),
            ]),
          ),
        const Notice('A person starts every alert. EduOS has no cameras, location tracking, facial recognition or threat scoring.'),
      ]);
    return widget.embedded ? body : Scaffold(appBar: AppBar(title: const Text('Safety')), body: body);
  }
}

const sroStatuses = {
  'requested': 'Requested',
  'notified': 'Notified',
  'responding': 'Responding',
  'on_scene': 'On scene',
  'cleared': 'Cleared',
  'unavailable': 'Unavailable',
};

/// School Resource Officer coordination status for a live incident
/// (GET/POST /api/safety/incidents/:id/sro-status). The officer records their
/// own status; leaders can record it for them. Coordination only: it never
/// contacts or dispatches law enforcement.
class SroStatusCard extends StatefulWidget {
  const SroStatusCard({super.key, required this.incident, required this.officer});
  final Incident incident;

  /// The officer's own limited workspace (no rosters or release details).
  final bool officer;

  @override
  State<SroStatusCard> createState() => _SroStatusCardState();
}

class _SroStatusCardState extends State<SroStatusCard> {
  Key _key = UniqueKey();
  String _status = 'responding';
  final _name = TextEditingController(), _unit = TextEditingController(), _note = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _unit.dispose();
    _note.dispose();
    super.dispose();
  }

  String? _opt(TextEditingController c) => c.text.trim().isEmpty ? null : c.text.trim();

  Future<void> _record() async {
    setState(() => _busy = true);
    try {
      await AppScope.read(context).api.post('/api/safety/incidents/${widget.incident.id}/sro-status',
          {'status': _status, 'officerName': _opt(_name), 'unit': _opt(_unit), 'note': _opt(_note)});
      if (!mounted) return;
      toast(context, 'SRO status recorded.');
      _note.clear();
      setState(() => _key = UniqueKey());
    } on ApiException catch (e) {
      if (mounted) toast(context, e.isOffline ? 'You\'re offline. This needs a connection.' : 'Couldn\'t record the SRO status.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final i = widget.incident;
    final title = widget.officer ? 'SRO incident workspace' : 'School Resource Officer (SRO) coordination';
    return InlineLoader<List<Json>>(
      key: _key,
      load: () async => objs(obj((await AppScope.read(context).api.get('/api/safety/incidents/${i.id}/sro-status'))['data'])['updates']),
      builder: (context, updates) {
        final latest = updates.firstOrNull;
        return SectionCard(title: title, children: [
          if (widget.officer) Text('${i.schoolName} · ${i.isDrill ? 'DRILL: ' : ''}${kindText[i.kind] ?? i.kind} · ${i.status}'),
          if (latest == null)
            const EmptyState('No SRO status has been recorded for this incident.')
          else
            Notice('Latest status: ${sroStatuses[latest['status']] ?? str(latest['status'])}'
                '${strOrNull(latest['officerName']) != null ? ' · ${latest['officerName']}' : ''}'
                '${strOrNull(latest['unit']) != null ? ' · ${latest['unit']}' : ''} · ${fmtTime(date(latest['recordedAt']))}'),
          Text(
            widget.officer
                ? 'This limited workspace shows coordination status only. It does not show student rosters, roll call, guardian information or release authorization.'
                : 'Records the SRO coordination status for this incident. It does not contact or dispatch law enforcement.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          DropdownButtonFormField<String>(
            value: _status,
            decoration: const InputDecoration(labelText: 'SRO status'),
            items: [for (final e in sroStatuses.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
            onChanged: (v) => setState(() => _status = v ?? _status),
          ),
          TextField(controller: _name, maxLength: 100, decoration: const InputDecoration(labelText: 'Officer name (optional)', counterText: '')),
          TextField(controller: _unit, maxLength: 100, decoration: const InputDecoration(labelText: 'Agency / unit (optional)', counterText: '')),
          TextField(controller: _note, maxLength: 300, minLines: 1, maxLines: 3, decoration: const InputDecoration(labelText: 'Operational note (optional)')),
          FilledButton(onPressed: _busy ? null : _record, child: const Text('Update SRO status')),
        ]);
      },
    );
  }
}

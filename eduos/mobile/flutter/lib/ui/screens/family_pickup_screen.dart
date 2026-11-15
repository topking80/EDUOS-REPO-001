import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Family pick-up: passes, approved adults, early dismissals and recent
/// pick-ups (GET /api/pickup/family). Every action here is online-only: the
/// school checks identity live, so nothing is queued on the phone.
class FamilyPickupScreen extends StatelessWidget {
  const FamilyPickupScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<List<PickupChild>>(
      load: () async => objs(obj((await app.api.get('/api/pickup/family'))['data'])['children']).map(PickupChild.fromJson).toList(),
      builder: (context, kids, reload) => ListView(padding: const EdgeInsets.all(16), children: [
        if (kids.isEmpty) const EmptyState('No children are linked to your account yet.'),
        for (final k in kids) _PickupChildCard(k, reload: reload),
        const Notice('Staff check the pass and a photo ID. EduOS stores no photos, ID numbers or face data.'),
      ]),
    );
  }
}

Future<void> showPickupPass(BuildContext context, PickupAdult adult) async {
  final app = AppScope.read(context);
  try {
    final res = await app.api.post('/api/pickup/tags', {'adultId': adult.id});
    if (!context.mounted) return;
    final pass = PickupPass.fromJson(obj(res.data));
    await Navigator.of(context).push(MaterialPageRoute<void>(fullscreenDialog: true, builder: (_) => PickupPassScreen(pass: pass)));
  } on ApiException catch (e) {
    if (context.mounted) toast(context, e.isOffline ? 'You\'re offline. A pass needs a connection.' : 'Couldn\'t make a pass.');
  }
}

/// Full-screen pass: QR, code, holder and expiry. Shown once; the server keeps
/// only a fingerprint of the code.
class PickupPassScreen extends StatefulWidget {
  const PickupPassScreen({super.key, required this.pass});
  final PickupPass pass;

  @override
  State<PickupPassScreen> createState() => _PickupPassScreenState();
}

class _PickupPassScreenState extends State<PickupPassScreen> {
  @override
  void initState() {
    super.initState();
    // Hide the system bars so the code gets the whole screen at the gate.
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  }

  @override
  void dispose() {
    SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.pass;
    return Scaffold(
      appBar: AppBar(title: const Text('Pick-up pass')),
      body: ListView(padding: const EdgeInsets.all(24), children: [
        Center(child: QrMatrix(p.qrRows, semanticLabel: 'QR code for the pick-up pass of ${p.adultName}', size: 260)),
        const SizedBox(height: 16),
        Center(child: SelectableText(p.code, style: Theme.of(context).textTheme.headlineMedium?.copyWith(letterSpacing: 4, fontWeight: FontWeight.w700))),
        const SizedBox(height: 8),
        Center(child: Text('${p.adultName} · valid until ${fmtDay(p.expiresAt)} ${fmtTime(p.expiresAt)}')),
        const SizedBox(height: 16),
        const Notice('Show this at pick-up with a photo ID. It\'s shown once: EduOS keeps only a fingerprint of the code, so make a new pass if you lose it.'),
      ]),
    );
  }
}

class _PickupChildCard extends StatelessWidget {
  const _PickupChildCard(this.k, {required this.reload});
  final PickupChild k;
  final Future<void> Function() reload;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final me = k.adults.where((a) => a.isMe).firstOrNull;
    final approved = k.adults.where((a) => a.approved).toList();
    return SectionCard(children: [
      Semantics(header: true, child: Text(k.name, style: Theme.of(context).textTheme.titleLarge)),
      Text(k.schoolName, style: Theme.of(context).textTheme.bodySmall),
      const SizedBox(height: 12),
      if (me != null && me.approved)
        FilledButton.icon(
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          onPressed: () => showPickupPass(context, me),
          icon: const Icon(Icons.qr_code_2),
          label: Text(me.passExpiresAt != null ? 'New pass for me (current ends ${fmtDay(me.passExpiresAt)})' : 'Show my pick-up pass'),
        ),
      const SizedBox(height: 12),
      Text('Who can pick up', style: Theme.of(context).textTheme.titleSmall),
      for (final a in k.adults)
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(a.fullName, style: const TextStyle(fontWeight: FontWeight.w600)),
          subtitle: Text([
            '${a.relationship}${a.isMe ? ' (you)' : ''}',
            if (a.status == 'rejected' && a.decisionNote != null) a.decisionNote!,
          ].join('\n')),
          trailing: Wrap(spacing: 6, crossAxisAlignment: WrapCrossAlignment.center, children: [
            StatusChip(a.status, text: a.approved ? 'Approved' : a.status == 'pending' ? 'Waiting for school' : 'Not approved'),
            if (a.approved && !a.isMe)
              IconButton(tooltip: 'One-day pass for ${a.fullName}', icon: const Icon(Icons.qr_code), onPressed: () => showPickupPass(context, a)),
            if (a.kind != 'guardian' && a.status != 'rejected')
              IconButton(
                tooltip: 'Remove ${a.fullName}',
                icon: const Icon(Icons.person_remove_outlined),
                onPressed: () async {
                  final ok = await confirm(context, title: 'Remove ${a.fullName}?', text: 'They can no longer pick up and any pass stops working.', action: 'Remove', danger: true);
                  if (!ok || !context.mounted) return;
                  try {
                    await app.api.post('/api/pickup/adults/${a.id}/revoke');
                    if (context.mounted) toast(context, 'Removed');
                    await reload();
                  } on ApiException {
                    if (context.mounted) toast(context, 'Couldn\'t remove.');
                  }
                },
              ),
          ]),
        ),
      const Divider(height: 24),
      _AddAdultForm(studentId: k.id, reload: reload),
      if (approved.isNotEmpty) ...[
        const Divider(height: 24),
        _EarlyDismissalForm(child: k, approved: approved, reload: reload),
      ],
      if (k.log.isNotEmpty) ...[
        const Divider(height: 24),
        Text('Recent pick-ups', style: Theme.of(context).textTheme.titleSmall),
        for (final l in k.log)
          ListTile(dense: true, contentPadding: EdgeInsets.zero, leading: Text('${fmtDay(l.at)}\n${fmtTime(l.at)}'), title: Text('${l.adultName} (${l.relationship})')),
      ],
    ]);
  }
}

class _AddAdultForm extends StatefulWidget {
  const _AddAdultForm({required this.studentId, required this.reload});
  final String studentId;
  final Future<void> Function() reload;

  @override
  State<_AddAdultForm> createState() => _AddAdultFormState();
}

class _AddAdultFormState extends State<_AddAdultForm> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController(), _relationship = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _name.dispose();
    _relationship.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_form.currentState!.validate()) return;
    setState(() => _busy = true);
    try {
      await AppScope.read(context).api.post('/api/pickup/adults', {
        'studentId': widget.studentId,
        'fullName': _name.text.trim(),
        'relationship': _relationship.text.trim(),
      });
      if (!mounted) return;
      toast(context, 'Sent to the school for approval');
      await widget.reload();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'adult_already_listed' ? 'That person is already listed.' : 'Couldn\'t send.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    String? required(String? v) => (v == null || v.trim().isEmpty) ? 'Required' : null;
    return Form(
      key: _form,
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Text('Add an adult', style: Theme.of(context).textTheme.titleSmall),
        TextFormField(controller: _name, maxLength: 120, validator: required, decoration: const InputDecoration(labelText: 'Full name (as on their photo ID)')),
        TextFormField(controller: _relationship, maxLength: 40, validator: required, decoration: const InputDecoration(labelText: 'Relationship')),
        OutlinedButton(onPressed: _busy ? null : _submit, child: const Text('Send to school for approval')),
      ]),
    );
  }
}

class _EarlyDismissalForm extends StatefulWidget {
  const _EarlyDismissalForm({required this.child, required this.approved, required this.reload});
  final PickupChild child;
  final List<PickupAdult> approved;
  final Future<void> Function() reload;

  @override
  State<_EarlyDismissalForm> createState() => _EarlyDismissalFormState();
}

class _EarlyDismissalFormState extends State<_EarlyDismissalForm> {
  late String _adultId = widget.approved.first.id;
  DateTime? _date;
  TimeOfDay? _time;
  final _reason = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_date == null || _time == null || _reason.text.trim().isEmpty) {
      toast(context, 'Choose a date and time, and give a reason.');
      return;
    }
    setState(() => _busy = true);
    try {
      await AppScope.read(context).api.post('/api/pickup/early-dismissals', {
        'studentId': widget.child.id,
        'adultId': _adultId,
        'date': isoDate(_date!),
        'time': '${_time!.hour.toString().padLeft(2, '0')}:${_time!.minute.toString().padLeft(2, '0')}',
        'reason': _reason.text.trim(),
      });
      if (!mounted) return;
      toast(context, 'Early dismissal requested');
      await widget.reload();
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t request early dismissal.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      Text('Early dismissal', style: Theme.of(context).textTheme.titleSmall),
      DropdownButtonFormField<String>(
        value: _adultId,
        decoration: const InputDecoration(labelText: 'Who will collect'),
        items: [for (final a in widget.approved) DropdownMenuItem(value: a.id, child: Text('${a.fullName} (${a.relationship})'))],
        onChanged: (v) => setState(() => _adultId = v ?? _adultId),
      ),
      Row(children: [
        Expanded(
          child: TextButton.icon(
            icon: const Icon(Icons.event),
            label: Text(_date == null ? 'Date' : fmtDay(_date)),
            onPressed: () async {
              final d = await showDatePicker(context: context, firstDate: DateTime(now.year, now.month, now.day), lastDate: now.add(const Duration(days: 60)));
              if (d != null) setState(() => _date = d);
            },
          ),
        ),
        Expanded(
          child: TextButton.icon(
            icon: const Icon(Icons.schedule),
            label: Text(_time == null ? 'Time' : _time!.format(context)),
            onPressed: () async {
              final t = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 12, minute: 0));
              if (t != null) setState(() => _time = t);
            },
          ),
        ),
      ]),
      TextField(controller: _reason, maxLength: 200, decoration: const InputDecoration(labelText: 'Reason')),
      OutlinedButton(onPressed: _busy ? null : _submit, child: const Text('Request early dismissal')),
      for (final e in widget.child.earlyDismissals)
        ListTile(
          dense: true,
          contentPadding: EdgeInsets.zero,
          title: Text('${fmtDay(e.day)} ${e.time} · ${e.adultName}'),
          subtitle: Text(e.reason),
          trailing: StatusChip(e.status, tone: e.status == 'approved' ? ChipTone.good : e.status == 'requested' ? ChipTone.waiting : ChipTone.bad),
        ),
    ]);
  }
}

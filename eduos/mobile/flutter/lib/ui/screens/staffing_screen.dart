import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

const _reasons = {'personal': 'Personal', 'professional_development': 'Professional development', 'other': 'Other'};
const _departments = ['instruction', 'transport', 'facilities', 'health_office', 'counseling', 'meal_service', 'library', 'administration', 'other'];
const staffLeadRoles = {'superintendent', 'it_admin', 'principal', 'vice_principal'};

String _words(Object? v) => str(v).replaceAll('_', ' ');
String _iso(DateTime day, int hour, int minute) => DateTime(day.year, day.month, day.day, hour, minute).toUtc().toIso8601String();

/// Staffing: request time away, see shifts and substitute coverage; leaders
/// approve absences and create or decide coverage. GET /api/staff-management.
class StaffingScreen extends StatefulWidget {
  const StaffingScreen({super.key});

  @override
  State<StaffingScreen> createState() => _StaffingScreenState();
}

class _StaffingScreenState extends State<StaffingScreen> {
  Key _key = UniqueKey();
  late DateTime _from = _today, _to = _today, _coverDay = _today;
  String _reason = 'personal', _dept = 'instruction';
  TimeOfDay _start = const TimeOfDay(hour: 8, minute: 0), _end = const TimeOfDay(hour: 15, minute: 0);
  final _role = TextEditingController(), _notes = TextEditingController();

  DateTime get _today => DateUtils.dateOnly(DateTime.now());

  @override
  void dispose() {
    _role.dispose();
    _notes.dispose();
    super.dispose();
  }

  Future<void> _post(String path, Map<String, Object?> body, String done, String failed) async {
    try {
      await AppScope.read(context).api.post(path, body);
      if (!mounted) return;
      toast(context, done);
      setState(() => _key = UniqueKey());
    } on ApiException catch (e) {
      if (mounted) toast(context, e.isOffline ? 'You\'re offline. This needs a connection.' : failed);
    }
  }

  Future<void> _pickDay(DateTime current, ValueChanged<DateTime> set) async {
    final d = await showDatePicker(context: context, initialDate: current, firstDate: _today.subtract(const Duration(days: 30)), lastDate: _today.add(const Duration(days: 365)));
    if (d != null) setState(() => set(d));
  }

  Future<void> _pickTime(TimeOfDay current, ValueChanged<TimeOfDay> set) async {
    final t = await showTimePicker(context: context, initialTime: current);
    if (t != null) setState(() => set(t));
  }

  Widget _dayButton(String label, DateTime value, ValueChanged<DateTime> set) =>
      OutlinedButton.icon(icon: const Icon(Icons.event), label: Text('$label: ${fmtDay(value)}'), onPressed: () => _pickDay(value, set));

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final lead = staffLeadRoles.contains(app.me?.role);
    return Loader<Json>(
      key: _key,
      load: () async => obj((await app.api.get('/api/staff-management'))['data']),
      builder: (context, d, _) {
        final absences = objs(d['absences']), coverage = objs(d['coverage']), shifts = objs(d['shifts']);
        return ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(children: [
            Semantics(header: true, child: Text('Staffing', style: Theme.of(context).textTheme.titleLarge)),
            const Text('Absence requests, substitute coverage and scheduled shifts.'),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: StatTile(absences.length, 'absence requests')),
              Expanded(child: StatTile(absences.where((a) => a['status'] == 'pending').length, 'awaiting review', warnWhenPositive: true)),
              Expanded(child: StatTile(coverage.length, 'coverage requests')),
              Expanded(child: StatTile(shifts.length, 'upcoming shifts')),
            ]),
          ]),
          SectionCard(title: 'Request time away', children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              _dayButton('First day', _from, (v) => _from = v),
              _dayButton('Last day', _to, (v) => _to = v),
            ]),
            DropdownButtonFormField<String>(
              value: _reason,
              decoration: const InputDecoration(labelText: 'Category'),
              items: [for (final e in _reasons.entries) DropdownMenuItem(value: e.key, child: Text(e.value))],
              onChanged: (v) => setState(() => _reason = v ?? _reason),
            ),
            Text('Do not include medical details or sensitive personal information.', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            FilledButton(
              onPressed: () {
                if (_to.isBefore(_from)) return toast(context, 'The last day must be on or after the first day.');
                _post('/api/staff-management/absences', {'startsAt': _iso(_from, 0, 0), 'endsAt': _iso(_to, 23, 59), 'reasonCategory': _reason},
                    'Absence request submitted.', 'Couldn\'t submit the absence request.');
              },
              child: const Text('Submit absence'),
            ),
          ]),
          SectionCard(title: lead ? 'Absence requests' : 'My absence requests', children: [
            if (absences.isEmpty) const EmptyState('No absence requests.'),
            for (final a in absences)
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('${fmtDay(date(a['starts_at']))} – ${fmtDay(date(a['ends_at']))}', style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text('${lead && strOrNull(a['display_name']) != null ? '${a['display_name']} · ' : ''}${_words(a['reason_category'])} · submitted ${fmtDay(date(a['created_at']))}'),
                  trailing: StatusChip(str(a['status'])),
                ),
                if (lead && a['status'] == 'pending')
                  Wrap(spacing: 8, children: [
                    FilledButton(
                        onPressed: () => _post('/api/staff-management/absences/${a['id']}/review', {'decision': 'approved'}, 'Absence approved.', 'Couldn\'t update the request.'),
                        child: const Text('Approve')),
                    OutlinedButton(
                        onPressed: () => _post('/api/staff-management/absences/${a['id']}/review', {'decision': 'denied'}, 'Absence denied.', 'Couldn\'t update the request.'),
                        child: const Text('Deny')),
                  ]),
              ]),
          ]),
          if (lead)
            SectionCard(title: 'Request substitute coverage', children: [
              Wrap(spacing: 8, runSpacing: 8, children: [
                _dayButton('Date', _coverDay, (v) => _coverDay = v),
                OutlinedButton(onPressed: () => _pickTime(_start, (v) => _start = v), child: Text('From ${_start.format(context)}')),
                OutlinedButton(onPressed: () => _pickTime(_end, (v) => _end = v), child: Text('To ${_end.format(context)}')),
              ]),
              TextField(controller: _role, maxLength: 100, decoration: const InputDecoration(labelText: 'Role needed (e.g. Substitute teacher)', counterText: '')),
              DropdownButtonFormField<String>(
                value: _dept,
                decoration: const InputDecoration(labelText: 'Department'),
                items: [for (final v in _departments) DropdownMenuItem(value: v, child: Text(_words(v)))],
                onChanged: (v) => setState(() => _dept = v ?? _dept),
              ),
              TextField(controller: _notes, maxLength: 500, minLines: 2, maxLines: 4, decoration: const InputDecoration(labelText: 'Notes (non-sensitive)')),
              FilledButton(
                onPressed: () async {
                  if (_role.text.trim().isEmpty) return toast(context, 'Say which role is needed.');
                  if (_end.hour * 60 + _end.minute <= _start.hour * 60 + _start.minute) return toast(context, 'The end time must be after the start time.');
                  await _post('/api/staff-management/coverage', {
                    'startsAt': _iso(_coverDay, _start.hour, _start.minute),
                    'endsAt': _iso(_coverDay, _end.hour, _end.minute),
                    'department': _dept,
                    'roleNeeded': _role.text.trim(),
                    'details': _notes.text.trim(),
                  }, 'Coverage request created.', 'Couldn\'t create the coverage request.');
                  _role.clear();
                  _notes.clear();
                },
                child: const Text('Create coverage request'),
              ),
            ]),
          SectionCard(title: 'Substitute coverage', children: [
            if (coverage.isEmpty) const EmptyState('No coverage requests.'),
            for (final c in coverage)
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(str(c['role_needed']), style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text('${_words(c['department'])} · ${fmtDay(date(c['starts_at']))} · ${fmtTime(date(c['starts_at']))}–${fmtTime(date(c['ends_at']))}'),
                  trailing: StatusChip(str(c['status'])),
                ),
                if (lead && (c['status'] == 'requested' || c['status'] == 'approved'))
                  Wrap(spacing: 8, children: [
                    FilledButton.tonal(
                        onPressed: () => _post('/api/staff-management/coverage/${c['id']}/decision', {'decision': 'approved'}, 'Coverage approved.', 'Couldn\'t update the coverage request.'),
                        child: const Text('Approve coverage')),
                    OutlinedButton(
                        onPressed: () => _post('/api/staff-management/coverage/${c['id']}/decision', {'decision': 'declined'}, 'Coverage declined.', 'Couldn\'t update the coverage request.'),
                        child: const Text('Decline')),
                  ]),
              ]),
          ]),
          SectionCard(title: 'Upcoming shifts', children: [
            if (shifts.isEmpty) const EmptyState('No shifts scheduled in the next 30 days.'),
            for (final x in shifts)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(str(x['display_name'], 'Staff member'), style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${fmtDay(date(x['shift_date']))} · ${fmtTime(date(x['starts_at']))}–${fmtTime(date(x['ends_at']))} · ${_words(x['department'])}\n${str(x['assignment'])}'),
                isThreeLine: true,
                trailing: StatusChip(str(x['status'])),
              ),
          ]),
        ]);
      },
    );
  }
}

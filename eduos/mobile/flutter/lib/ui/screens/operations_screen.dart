import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Tab id -> work-queue domain. Operations (vice principal) covers every domain.
const opsTabDomains = {'guidance': 'counseling', 'healthoffice': 'health_office', 'facilities': 'facilities', 'meals': 'meal_service'};
const _domainText = {'counseling': 'Counseling', 'health_office': 'Health office', 'facilities': 'Facilities', 'meal_service': 'Meal service'};
const _sensitive = {'counseling', 'health_office'};
const _kinds = {
  'facilities': ['repair', 'cleaning', 'safety_hazard', 'setup', 'other'],
  'meal_service': ['supply', 'equipment', 'menu', 'staffing', 'other'],
  'counseling': ['check_in_request', 'referral_follow_up', 'schedule_change', 'other'],
  'health_office': ['supply', 'screening_logistics', 'room_coverage', 'other'],
};
const _canCreate = {
  'facilities': {'maintenance', 'principal', 'vice_principal'},
  'health_office': {'nurse'},
  'counseling': {'counselor'},
  'meal_service': {'lunch_staff', 'principal', 'vice_principal'},
};
const _roleText = {
  'vice_principal': ('Vice Principal Operations', 'Coordinate school-day exceptions, attendance follow-up, safety coordination and facilities escalations.'),
  'counselor': ('Guidance Counselor Console', 'A routing queue for non-confidential follow-ups. Keep counseling narratives and student clinical details in the district-approved case system.'),
  'nurse': ('School Nurse Console', 'Health-office operational tasks only. Do not enter diagnoses, medications, treatment notes or student-identifying health details here.'),
  'maintenance': ('Maintenance Console', 'Submit and track facility work orders, safety repairs and building service requests.'),
  'lunch_staff': ('Meal Service Console', 'Coordinate meal service tasks, stock issues, equipment problems and daily service operations.'),
};
const _leads = {'principal', 'vice_principal', 'superintendent', 'it_admin'};

String _words(Object? v) => str(v).replaceAll('_', ' ');

/// School operations work queues (GET /api/school-operations/...): counts,
/// add a work item, start/complete/cancel, and escalate for leaders.
class OperationsScreen extends StatefulWidget {
  const OperationsScreen({super.key, this.domain});

  /// null: every domain (the vice principal's Operations tab).
  final String? domain;

  @override
  State<OperationsScreen> createState() => _OperationsScreenState();
}

class _OperationsScreenState extends State<OperationsScreen> {
  Key _key = UniqueKey();
  late String _area = widget.domain ?? 'facilities';
  late String _kind = _kinds[_area]!.first;
  String _priority = 'normal';
  final _summary = TextEditingController(), _details = TextEditingController();
  bool _busy = false;
  // Work items with a request in flight: their buttons are disabled so a
  // double tap can't send the same change twice.
  final Set<String> _pending = {};

  @override
  void dispose() {
    _summary.dispose();
    _details.dispose();
    super.dispose();
  }

  void _reload() => setState(() => _key = UniqueKey());

  /// Sends one change; true only when the server accepted it.
  Future<bool> _act(String path, Map<String, Object?> body, String done, String failed) async {
    try {
      await AppScope.read(context).api.post(path, body);
      if (!mounted) return true;
      toast(context, done);
      _reload();
      return true;
    } on ApiException catch (e) {
      if (mounted) toast(context, e.isOffline ? 'You\'re offline. Nothing was sent; try again when you\'re connected.' : failed);
      return false;
    }
  }

  /// A row action (start, complete, cancel, escalate), at most one at a time per item.
  Future<void> _item(Json it, String action, Map<String, Object?> body, String done, String failed) async {
    final id = str(it['id']);
    if (_pending.contains(id)) return;
    setState(() => _pending.add(id));
    await _act('/api/school-operations/${it['domain']}/$id/$action', body, done, failed);
    if (mounted) setState(() => _pending.remove(id));
  }

  Future<void> _add() async {
    if (_busy) return;
    if (_summary.text.trim().isEmpty) return toast(context, 'Add a short summary.');
    setState(() => _busy = true);
    final ok = await _act(
        '/api/school-operations/$_area',
        {
          'kind': _kind,
          'priority': _priority,
          'summary': _summary.text.trim(),
          // The server refuses free text for health and counseling items.
          if (!_sensitive.contains(_area) && _details.text.trim().isNotEmpty) 'details': _details.text.trim(),
        },
        'Work item added.',
        'Couldn\'t add that work item. Your text is still here.');
    // Clear only what the server accepted; a failure keeps the staff member's text.
    if (ok) {
      _summary.clear();
      _details.clear();
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final role = app.me?.role ?? '';
    final d = widget.domain;
    final lead = _leads.contains(role);
    final areas = d != null ? [d] : const ['facilities', 'meal_service'];
    final creatable = areas.where((a) => _canCreate[a]!.contains(role)).toList();
    if (creatable.isNotEmpty && !creatable.contains(_area)) _area = creatable.first;
    final title = _roleText[role]?.$1 ?? (d != null ? _domainText[d]! : 'Operations');
    final blurb = _roleText[role]?.$2 ?? (d != null ? 'Your team\'s work queue.' : 'Work queues for facilities, meal service, counseling and the health office.');
    return Loader<(List<Json>, List<Json>)>(
      key: _key,
      load: () async {
        final center = obj((await app.api.get('/api/school-operations/command-center'))['data']);
        final items = d != null ? objs((await app.api.get('/api/school-operations/$d'))['data']) : objs(center['work']);
        return (objs(center['summary']).where((r) => d == null || r['domain'] == d).toList(), items);
      },
      builder: (context, data, _) {
        final (summary, items) = data;
        int sum(String k) => summary.fold(0, (n, r) => n + (k == 'active' ? ((r['status'] == 'open' || r['status'] == 'in_progress') ? integer(r['count']) : 0) : integer(r[k])));
        return ListView(padding: const EdgeInsets.all(16), children: [
          SectionCard(children: [
            Text('SCHOOL OPERATIONS', style: Theme.of(context).textTheme.bodySmall),
            Semantics(header: true, child: Text(title, style: Theme.of(context).textTheme.titleLarge)),
            Text(blurb),
            const SizedBox(height: 12),
            Row(children: [
              Expanded(child: StatTile(sum('active'), 'open')),
              Expanded(child: StatTile(sum('urgent'), 'urgent', warnWhenPositive: true)),
              Expanded(child: StatTile(sum('overdue'), 'overdue', warnWhenPositive: true)),
            ]),
          ]),
          if (creatable.isNotEmpty)
            SectionCard(title: 'New work item', children: [
              if (creatable.length > 1)
                DropdownButtonFormField<String>(
                  value: _area,
                  decoration: const InputDecoration(labelText: 'Area'),
                  items: [for (final a in creatable) DropdownMenuItem(value: a, child: Text(_domainText[a]!))],
                  onChanged: (v) => setState(() {
                    _area = v ?? _area;
                    _kind = _kinds[_area]!.first;
                  }),
                ),
              DropdownButtonFormField<String>(
                key: ValueKey('kind-$_area'),
                value: _kind,
                decoration: const InputDecoration(labelText: 'Kind'),
                items: [for (final k in _kinds[_area]!) DropdownMenuItem(value: k, child: Text(_words(k)))],
                onChanged: (v) => setState(() => _kind = v ?? _kind),
              ),
              DropdownButtonFormField<String>(
                value: _priority,
                decoration: const InputDecoration(labelText: 'Priority'),
                items: [
                  for (final p in const ['normal', 'low', 'high', 'urgent']) DropdownMenuItem(value: p, child: Text(p))
                ],
                onChanged: (v) => setState(() => _priority = v ?? _priority),
              ),
              TextField(controller: _summary, maxLength: 300, decoration: const InputDecoration(labelText: 'Summary', counterText: '')),
              if (_sensitive.contains(_area))
                Text('Routing only. Never enter student names, health details or counseling notes here; use the approved student health or counseling system.',
                    style: Theme.of(context).textTheme.bodySmall)
              else
                TextField(controller: _details, maxLength: 500, minLines: 2, maxLines: 4, decoration: const InputDecoration(labelText: 'Details (optional)')),
              const SizedBox(height: 8),
              FilledButton(onPressed: _busy ? null : _add, child: const Text('Add work item')),
            ]),
          SectionCard(title: d != null ? 'Work queue' : 'Open work', children: [
            if (items.isEmpty) const EmptyState('Nothing in the queue.'),
            for (final it in items)
              Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(str(it['summary']), style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text([
                    if (d == null) _domainText[str(it['domain'])] ?? _words(it['domain']),
                    _words(it['kind']),
                    str(it['priority']),
                    if (integer(it['escalation_level']) > 0) 'escalated ×${integer(it['escalation_level'])}',
                    ago(date(it['created_at'])),
                    if (it['due_at'] != null) 'due ${fmtDay(date(it['due_at']))}',
                  ].join(' · ')),
                  trailing: StatusChip(switch (str(it['status'])) { 'completed' => 'present', 'cancelled' => 'none', 'in_progress' => 'current', _ => 'expected' }, text: _words(it['status'])),
                ),
                if (it['status'] == 'open' || it['status'] == 'in_progress')
                  () {
                    final busy = _pending.contains(str(it['id']));
                    return Wrap(spacing: 8, children: [
                      if (it['status'] == 'open')
                        OutlinedButton(
                          onPressed: busy ? null : () => _item(it, 'status', {'status': 'in_progress'}, 'Started.', 'Couldn\'t update that work item.'),
                          child: Text('Start', semanticsLabel: 'Start: ${it['summary']}'),
                        ),
                      FilledButton(
                        onPressed: busy ? null : () => _item(it, 'status', {'status': 'completed'}, 'Completed.', 'Couldn\'t update that work item.'),
                        child: Text('Complete', semanticsLabel: 'Complete: ${it['summary']}'),
                      ),
                      TextButton(
                        onPressed: busy ? null : () => _item(it, 'status', {'status': 'cancelled'}, 'Cancelled.', 'Couldn\'t update that work item.'),
                        child: Text('Cancel', semanticsLabel: 'Cancel: ${it['summary']}'),
                      ),
                      if (lead)
                        OutlinedButton(
                          style: OutlinedButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
                          onPressed: busy ? null : () => _item(it, 'escalate', {}, 'Escalated.', 'Couldn\'t escalate that work item.'),
                          child: Text('Escalate', semanticsLabel: 'Escalate: ${it['summary']}'),
                        ),
                    ]);
                  }(),
                const Divider(),
              ]),
          ]),
        ]);
      },
    );
  }
}

/// The vice principal's Attendance tab: today's marks at their school.
///
/// One small request (GET /api/attendance/day): each student's status today
/// counted on the server, plus the students who weren't present. It used to
/// download the latest 500 marks of every day and filter on the phone, which
/// missed marks at a big school and counted a corrected mark twice.
class AttendanceTodayScreen extends StatelessWidget {
  const AttendanceTodayScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<Json>(
      load: () async {
        // The counts cover the day; the students who weren't present come a
        // page at a time (a snow day can be thousands).
        // Every page is fetched (no ceiling); if a later page fails, what
        // arrived is shown with a notice instead of silently stopping short.
        final base = '/api/attendance/day?date=${isoDate(DateTime.now())}';
        final day = obj((await app.api.get(base))['data']);
        final all = [...objs(day['exceptions'])];
        var next = obj(day['page'])['nextOffset'];
        var incomplete = false;
        while (next is int && next >= all.length && next > 0) {
          try {
            final more = obj((await app.api.get('$base&offset=$next'))['data']);
            final page = objs(more['exceptions']);
            all.addAll(page);
            final after = obj(more['page'])['nextOffset'];
            next = page.isEmpty ? null : after;
          } on ApiException {
            incomplete = true;
            break;
          }
        }
        return {...day, 'exceptions': all, 'incomplete': incomplete};
      },
      builder: (context, day, _) {
        final counts = obj(day['counts']), exceptions = objs(day['exceptions']);
        final absent = exceptions.where((e) => e['status'] == 'absent').toList();
        final tardy = exceptions.where((e) => e['status'] == 'tardy').toList();
        // Rows are built as they scroll into view: a school's absences can run
        // to hundreds on a snow day.
        final rows = <Widget Function(BuildContext)>[
          (c) => Semantics(header: true, child: Text('Attendance today', style: Theme.of(c).textTheme.titleLarge)),
          (_) => const SizedBox(height: 8),
          (_) => Row(children: [
                Expanded(child: StatTile(integer(counts['present']), 'present')),
                Expanded(child: StatTile(integer(counts['absent']), 'absent', warnWhenPositive: true)),
                Expanded(child: StatTile(integer(counts['tardy']), 'tardy', warnWhenPositive: true)),
              ]),
          (_) => const SizedBox(height: 8),
          if (day['incomplete'] == true)
            (_) => Notice('Showing ${exceptions.length} of ${integer(counts['absent']) + integer(counts['tardy']) + integer(counts['excused'])} students who weren\'t present; '
                'the rest didn\'t load. Pull down to try again.'),
          ..._section('Absent', absent, 'No absences marked today.'),
          ..._section('Tardy', tardy, 'No tardies marked today.'),
          (_) => const Notice('Marks come from teachers\' class registers. Follow-ups go in the Operations queue.'),
        ];
        return ListView.builder(padding: const EdgeInsets.all(16), itemCount: rows.length, itemBuilder: (c, i) => rows[i](c));
      },
    );
  }

  static List<Widget Function(BuildContext)> _section(String title, List<Json> list, String none) => [
        (c) => Padding(padding: const EdgeInsets.only(top: 12, bottom: 4), child: Text(title, style: Theme.of(c).textTheme.titleMedium)),
        if (list.isEmpty) (_) => EmptyState(none),
        for (final e in list)
          (_) => ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text(str(e['display_name'])),
                subtitle: e['family_acknowledged_at'] != null ? const Text('Family acknowledged') : null,
                trailing: StatusChip(str(e['status'])),
              ),
      ];
}

/// Transport for school leaders: every bus run today with live counts.
class TransportScreen extends StatelessWidget {
  const TransportScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<List<Json>>(
      load: () async => objs(obj((await app.api.get('/api/transport/today'))['data'])['routes']),
      builder: (context, routes, _) => ListView(padding: const EdgeInsets.all(16), children: [
        Semantics(header: true, child: Text('Transport status', style: Theme.of(context).textTheme.titleLarge)),
        const SizedBox(height: 8),
        if (routes.isEmpty) const SectionCard(children: [EmptyState('No routes set up.')]),
        for (final r in routes)
          () {
            final run = r['run'] is Map ? obj(r['run']) : null;
            final c = obj(r['counts']);
            final done = run?['status'] == 'completed';
            return SectionCard(children: [
              Row(children: [
                const Icon(Icons.directions_bus),
                const SizedBox(width: 8),
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('${str(r['bus_label'])} · ${str(r['name'])}', style: Theme.of(context).textTheme.titleMedium),
                    Text('${str(r['school_name'])} · driver ${str(r['driver_name'], 'unassigned')}', style: Theme.of(context).textTheme.bodySmall),
                  ]),
                ),
                StatusChip(
                    run == null
                        ? 'not_started'
                        : done
                            ? 'alighted'
                            : 'boarded',
                    text: run == null
                        ? 'Not started'
                        : done
                            ? 'Completed'
                            : 'In progress'),
              ]),
              const SizedBox(height: 8),
              Row(children: [
                Expanded(child: StatTile(integer(c['onBoard']), 'on board')),
                Expanded(child: StatTile(integer(c['expected']), 'expected')),
                Expanded(child: StatTile(integer(c['alighted']), 'dropped off')),
                Expanded(child: StatTile(integer(c['notRiding']), 'not riding')),
              ]),
              Text('${objs(r['stops']).length} stops${run != null ? ' · started ${fmtTime(date(run['started_at']))}' : ''}', style: Theme.of(context).textTheme.bodySmall),
            ]);
          }(),
        const Notice('Counts come from driver check-ins at stops. No GPS or location data is collected.'),
      ]),
    );
  }
}

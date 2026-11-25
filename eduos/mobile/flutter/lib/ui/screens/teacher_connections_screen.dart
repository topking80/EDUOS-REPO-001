import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'messages_screen.dart';

class _ClassroomPairDialog extends StatefulWidget {
  const _ClassroomPairDialog({required this.roomName});
  final String roomName;

  @override
  State<_ClassroomPairDialog> createState() => _ClassroomPairDialogState();
}

class _ClassroomPairDialogState extends State<_ClassroomPairDialog> {
  final _code = TextEditingController();
  final _deviceName = TextEditingController(text: 'Teacher mobile app');

  @override
  void dispose() {
    _code.dispose();
    _deviceName.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text('Connect to ${widget.roomName}'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Enter the six-digit code currently displayed by the classroom device.'),
          TextField(controller: _code, keyboardType: TextInputType.number, maxLength: 6, decoration: const InputDecoration(labelText: 'Classroom code')),
          TextField(controller: _deviceName, maxLength: 60, decoration: const InputDecoration(labelText: 'This device name')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final code = _code.text.trim();
              final deviceName = _deviceName.text.trim();
              if (code.length == 6 && deviceName.isNotEmpty) {
                Navigator.pop(context, {'code': code, 'controllerName': deviceName});
              }
            },
            child: const Text('Connect'),
          ),
        ],
      );
}

class _ColleagueMessageDialog extends StatefulWidget {
  const _ColleagueMessageDialog({required this.name});
  final String name;

  @override
  State<_ColleagueMessageDialog> createState() => _ColleagueMessageDialogState();
}

class _ColleagueMessageDialogState extends State<_ColleagueMessageDialog> {
  final _subject = TextEditingController(text: 'School collaboration');
  final _body = TextEditingController();

  @override
  void dispose() {
    _subject.dispose();
    _body.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: Text('Message ${widget.name}'),
        content: SizedBox(
          width: 460,
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: _subject, maxLength: 160, decoration: const InputDecoration(labelText: 'Subject')),
            TextField(controller: _body, maxLength: 4000, minLines: 3, maxLines: 6, decoration: const InputDecoration(labelText: 'Message')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(
            onPressed: () {
              final subject = _subject.text.trim();
              final body = _body.text.trim();
              if (subject.isNotEmpty && body.isNotEmpty) {
                Navigator.pop(context, {'subject': subject, 'body': body});
              }
            },
            child: const Text('Send'),
          ),
        ],
      );
}

class _TeacherDay {
  const _TeacherDay({required this.rooms, required this.mediaRooms, required this.arrivals, required this.pickup, required this.workspace, required this.checkins, required this.riders, required this.shifts});
  final List<Json> rooms, mediaRooms, arrivals, checkins, riders, shifts;
  final Json pickup, workspace;
}

class _TeacherNetwork {
  const _TeacherNetwork(this.colleagues, this.schools, this.groups);
  final List<Json> colleagues, schools, groups;
}

/// Teacher's school-day connections: classrooms, arrival and dismissal,
/// shared duty checklists, and the district educator network.
class TeacherConnectionsScreen extends StatefulWidget {
  const TeacherConnectionsScreen({super.key});

  @override
  State<TeacherConnectionsScreen> createState() => _TeacherConnectionsScreenState();
}

class _TeacherConnectionsScreenState extends State<TeacherConnectionsScreen> {
  int _section = 0;
  Key _dayKey = UniqueKey(), _networkKey = UniqueKey();
  String _search = '';

  Future<Map<String, Object?>?> _optional(String path) async {
    try {
      return await AppScope.read(context).api.get(path);
    } on ApiException catch (e) {
      if (e.isUnauthorized) rethrow;
      return null;
    }
  }

  Future<_TeacherDay> _loadDay() async {
    final r = await Future.wait([
      _optional('/api/my/rooms'),
      _optional('/api/rooms?kind=media_center&schoolId=${AppScope.read(context).me?.schoolId}'),
      _optional('/api/arrival/today'),
      _optional('/api/pickup/queue'),
      _optional('/api/staff-workspace'),
      _optional('/api/my/checkins'),
      _optional('/api/transport/today'),
      _optional('/api/staff-management'),
    ]);
    return _TeacherDay(
      rooms: objs(r[0]?['data']),
      mediaRooms: objs(r[1]?['data']),
      arrivals: objs(r[2]?['data']),
      pickup: obj(r[3]?['data']),
      workspace: obj(r[4]?['data']),
      checkins: objs(r[5]?['data']),
      riders: objs(obj(r[6]?['data'])['riders']),
      shifts: objs(obj(r[7]?['data'])['shifts']),
    );
  }

  Future<_TeacherNetwork> _loadNetwork() async {
    final r = await Future.wait([_optional('/api/network/colleagues'), _optional('/api/network/groups')]);
    final d = obj(r[0]?['data']);
    return _TeacherNetwork(objs(d['colleagues']), objs(d['schools']), objs(r[1]?['data']));
  }

  void _refreshDay() => setState(() => _dayKey = UniqueKey());
  void _refreshNetwork() => setState(() => _networkKey = UniqueKey());

  Future<void> _receive(Json handoff) async {
    final id = str(handoff['id']);
    try {
      await AppScope.read(context).api.post('/api/arrival/handoffs/$id/receive', {});
      if (!mounted) return;
      toast(context, 'Student handoff confirmed. Record first attendance in Classes.');
      _refreshDay();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'independent_receipt_required' ? 'A different staff member must confirm this handoff.' : 'Could not confirm the handoff.');
    }
  }

  Future<void> _pair(Json room) async {
    final result = await showDialog<Map<String, String>>(
      context: context,
      builder: (_) => _ClassroomPairDialog(roomName: str(room['name'])),
    );
    if (result == null || !mounted) return;
    try {
      await AppScope.read(context).api.post('/api/rooms/${room['id']}/pair', result);
      if (!mounted) return;
      toast(context, 'Connected to ${str(room['name'])}.');
      _refreshDay();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'wrong_code' ? 'That classroom code is incorrect or expired.' : 'Could not connect to this classroom.');
    }
  }

  Future<void> _endPairing(Json room) async {
    final pairing = obj(room['pairing']);
    try {
      await AppScope.read(context).api.post('/api/pairings/${pairing['id']}/end', {});
      if (!mounted) return;
      toast(context, 'Classroom connection ended.');
      _refreshDay();
    } on ApiException {
      if (mounted) toast(context, 'Could not end the classroom connection.');
    }
  }

  Future<void> _sendDeviceCommand(Json device, String capability, Json args) async {
    try {
      await AppScope.read(context).api.post('/api/devices/${device['id']}/commands', {'capability': capability, 'args': args});
      if (!mounted) return;
      toast(context, capability == 'show' ? 'Classroom display command sent.' : 'Device command sent.');
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'paused_for_safety' ? 'Classroom controls are paused during a safety alert.' : 'Pair your teacher device with this room before controlling equipment.');
    }
  }

  Future<void> _controlDevice(Json device) async {
    final capabilities = (device['capabilities'] as List? ?? const []).whereType<String>().toSet();
    final actions = <Map<String, Object?>>[];
    void add(String label, String capability, Json args) {
      if (capabilities.contains(capability)) actions.add({'label': label, 'capability': capability, 'args': args});
    }
    add('Share teacher screen', 'show', {});
    add('Blank display', 'blank', {'on': true});
    add('Restore display', 'blank', {'on': false});
    add('Power on', 'power', {'on': true});
    add('Power off', 'power', {'on': false});
    add('Lights on', 'lights', {'on': true});
    add('Lights off', 'lights', {'on': false});
    add('Lock student devices', 'lock', {});
    add('Unlock student devices', 'unlock', {});
    add('Exit focus mode', 'focus', {'off': true});
    if (actions.isEmpty && !capabilities.any((c) => ['volume', 'input', 'open_link', 'focus'].contains(c))) {
      if (mounted) toast(context, 'This device has no supported teacher controls.');
      return;
    }
    final selected = await showDialog<Map<String, Object?>>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(str(device['name'], 'Classroom device')),
        content: SizedBox(
          width: 420,
          child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (final action in actions)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.tune),
                title: Text(str(action['label'])),
                onTap: () => Navigator.pop(dialogContext, action),
              ),
            if (capabilities.contains('volume'))
              ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.volume_up), title: const Text('Set volume'), onTap: () => Navigator.pop(dialogContext, {'prompt': 'volume'})),
            if (capabilities.contains('input'))
              ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.input), title: const Text('Switch input'), onTap: () => Navigator.pop(dialogContext, {'prompt': 'input'})),
            if (capabilities.contains('open_link'))
              ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.link), title: const Text('Open secure link'), onTap: () => Navigator.pop(dialogContext, {'prompt': 'open_link'})),
            if (capabilities.contains('focus'))
              ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.center_focus_strong), title: const Text('Open focus link'), onTap: () => Navigator.pop(dialogContext, {'prompt': 'focus'})),
          ])),
        ),
        actions: [TextButton(onPressed: () => Navigator.pop(dialogContext), child: const Text('Cancel'))],
      ),
    );
    if (selected == null || !mounted) return;
    final prompt = str(selected['prompt']);
    if (prompt.isNotEmpty) {
      final value = await promptText(context,
        title: prompt == 'volume' ? 'Set device volume' : prompt == 'input' ? 'Switch device input' : prompt == 'focus' ? 'Open focus link' : 'Open secure link',
        text: prompt == 'volume' ? 'Enter a volume from 0 to 100.' : prompt == 'input' ? 'Enter the input source name.' : 'Enter an HTTPS URL approved by your school.',
        label: prompt == 'volume' ? 'Volume (0–100)' : prompt == 'input' ? 'Input source' : 'HTTPS URL',
        action: 'Send',
        maxLength: 500,
      );
      if (value == null || !mounted) return;
      if (prompt == 'volume') {
        final level = int.tryParse(value.trim());
        if (level == null || level < 0 || level > 100) {
          toast(context, 'Volume must be a whole number from 0 to 100.');
          return;
        }
        await _sendDeviceCommand(device, 'volume', {'level': level});
      } else if (prompt == 'input') {
        await _sendDeviceCommand(device, 'input', {'source': value.trim()});
      } else {
        final uri = Uri.tryParse(value.trim());
        if (uri == null || uri.scheme != 'https' || uri.host.isEmpty || uri.userInfo.isNotEmpty) {
          toast(context, 'Enter a valid HTTPS URL.');
          return;
        }
        await _sendDeviceCommand(device, prompt, {'url': value.trim()});
      }
      return;
    }
    await _sendDeviceCommand(device, str(selected['capability']), obj(selected['args']));
  }

  Future<void> _openRoll(Json room) async {
    final id = str(room['id']);
    try {
      final result = await AppScope.read(context).api.get('/api/rooms/$id/roll');
      if (!mounted) return;
      final roll = obj(result['data']);
      await showDialog<void>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(str(roll['name'], str(room['name']))),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Room activity · ${str(roll['date'])}'),
              for (final period in objs(roll['periods'])) ...[
                const Divider(),
                Text('${str(period['starts'])}–${str(period['ends'])} · ${str(period['class'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
                for (final learner in objs(period['roster']))
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    title: Text(str(learner['name'])),
                    subtitle: Text(str(learner['attendance'], 'Attendance not recorded')),
                    trailing: StatusChip(str(learner['checkedInAt'] == null ? 'expected' : 'present'), text: learner['checkedInAt'] == null ? 'Not checked in' : 'Checked in'),
                  ),
              ],
              if (objs(roll['periods']).isEmpty) const EmptyState('No class periods are assigned to you in this room today.'),
            ])),
          ),
          actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('Close'))],
        ),
      );
    } on ApiException catch (e) {
      if (mounted) toast(context, e.status == 404 ? 'This room is not assigned to your timetable.' : 'Could not load the classroom roll.');
    }
  }

  Future<void> _complete(Json item) async {
    try {
      await AppScope.read(context).api.post('/api/staff-workspace/checklists/${item['item_id']}/complete', {});
      if (!mounted) return;
      toast(context, 'Duty checklist updated.');
      _refreshDay();
    } on ApiException {
      if (mounted) toast(context, 'Could not update this checklist.');
    }
  }

  Future<void> _message(Json colleague) async {
    final message = await showDialog<Map<String, String>>(
      context: context,
      builder: (_) => _ColleagueMessageDialog(name: str(colleague['name'])),
    );
    if (message == null || !mounted) return;
    try {
      final result = await AppScope.read(context).api.post('/api/network/threads', {
        'subject': message['subject'],
        'body': message['body'],
        'participantIds': [str(colleague['user_id'])],
      });
      if (!mounted) return;
      final id = str(obj(result.data)['id']);
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ThreadScreen(threadId: id)));
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'participant_not_in_network' ? 'That colleague is no longer in your educator network.' : 'Could not start the conversation.');
    }
  }

  Future<void> _join(Json group) async {
    try {
      await AppScope.read(context).api.post('/api/network/groups/${group['id']}/join', {});
      if (!mounted) return;
      toast(context, 'Joined ${str(group['name'])}.');
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => ThreadScreen(threadId: str(group['id']))));
      _refreshNetwork();
    } on ApiException catch (e) {
      if (mounted) toast(context, e.error == 'thread_locked' ? 'This group is currently locked.' : 'Could not join this group.');
    }
  }

  @override
  Widget build(BuildContext context) => Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: SegmentedButton<int>(
            segments: const [
              ButtonSegment(value: 0, icon: Icon(Icons.today_outlined), label: Text('School day')),
              ButtonSegment(value: 1, icon: Icon(Icons.people_outline), label: Text('Colleagues')),
            ],
            selected: {_section},
            onSelectionChanged: (v) => setState(() => _section = v.first),
          ),
        ),
        Expanded(
          child: _section == 0
              ? Loader<_TeacherDay>(key: _dayKey, load: _loadDay, builder: (context, day, reload) => _dayView(day))
              : Loader<_TeacherNetwork>(key: _networkKey, load: _loadNetwork, builder: (context, network, reload) => _networkView(network)),
        ),
      ]);

  Widget _dayView(_TeacherDay d) {
    final bus = d.arrivals.where((a) => str(a['method']) == 'bus').toList();
    final car = d.arrivals.where((a) => str(a['method']) == 'car_rider').toList();
    final checklists = objs(d.workspace['checklists']);
    final tasks = objs(d.workspace['tasks']);
    final handoffs = objs(d.workspace['handoffs']);
    final waiting = objs(d.pickup['waiting']);
    return ListView(padding: const EdgeInsets.all(16), children: [
      SectionCard(title: 'Classroom connections', children: [
        const Text('Your school classrooms and media center, connected devices and authorized class rolls.'),
        if (d.rooms.isEmpty) const EmptyState('No classrooms are assigned to your timetable.'),
        for (final room in d.rooms) ...[
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.meeting_room_outlined),
            title: Text(str(room['name'])),
            subtitle: Text('${objs(room['slots']).map((s) => '${str(s['starts'])}–${str(s['ends'])}').join(', ')} · ${objs(room['devices']).length} connected devices'),
            trailing: room['pairing'] == null
                ? OutlinedButton(onPressed: () => _pair(room), child: const Text('Connect'))
                : TextButton(onPressed: () => _endPairing(room), child: const Text('Disconnect')),
            onTap: () => _openRoll(room),
          ),
          if (room['pairing'] != null) Padding(
            padding: const EdgeInsets.only(left: 12, bottom: 8),
            child: Text('Connected as ${str(obj(room['pairing'])['controller'])}', style: Theme.of(context).textTheme.bodySmall),
          ),
          for (final device in objs(room['devices']).where((d) => (d['capabilities'] as List? ?? const []).isNotEmpty))
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: room['pairing'] == null ? null : () => _controlDevice(device),
                icon: const Icon(Icons.tune),
                label: Text('Control ${str(device['name'])}'),
              ),
            ),
        ],
        if (d.mediaRooms.isNotEmpty) ...[
          const Divider(),
          const Text('Library / media center', style: TextStyle(fontWeight: FontWeight.w600)),
          for (final room in d.mediaRooms)
            ListTile(contentPadding: EdgeInsets.zero, leading: const Icon(Icons.local_library_outlined), title: Text(str(room['name'])), subtitle: Text('${objs(room['devices']).length} connected devices')),
        ],
        if (d.checkins.isNotEmpty) Text('Your room check-ins today: ${d.checkins.map((x) => str(x['room'])).where((x) => x.isNotEmpty).join(', ')}'),
      ]),
      SectionCard(title: 'Bus riders and handoffs', children: [
        const Text('Bus assignments for students on your roster, with the latest driver check-in.'),
        if (d.riders.isEmpty) const EmptyState('No bus riders are assigned to your roster.'),
        for (final rider in d.riders)
          ListTile(contentPadding: EdgeInsets.zero, title: Text(str(rider['display_name'])), subtitle: Text('${str(rider['bus_label'])} · ${str(rider['route_name'])} · stop ${str(rider['stop_name'])}'), trailing: StatusChip(str(rider['status']))),
        const Divider(),
        const Text('Arrival handoffs awaiting your confirmation:'),
        if (bus.isEmpty) const EmptyState('No bus handoffs assigned to you today.'),
        for (final h in bus) _arrivalTile(h),
      ]),
      SectionCard(title: 'Car rider arrivals', children: [
        if (car.isEmpty) const EmptyState('No car-rider arrivals assigned to you today.'),
        for (final h in car) _arrivalTile(h),
      ]),
      SectionCard(title: 'Car rider dismissal', children: [
        Text('${waiting.length} student release(s) waiting at the school pick-up point.'),
        for (final rider in waiting.take(12))
          ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(str(rider['name'])), subtitle: Text('${str(rider['grade'])} · awaiting authorized release'), trailing: const StatusChip('expected', text: 'Waiting')),
        const Notice('This is the school pick-up duty queue. Pass verification, photo-ID checks, custody safeguards and release authorization remain in the dedicated pick-up workflow.'),
      ]),
      _dutyDashboard(
        title: 'Library / media center duty',
        domain: 'library',
        icon: Icons.local_library_outlined,
        shifts: d.shifts,
        checklists: checklists,
        tasks: tasks,
      ),
      _dutyDashboard(
        title: 'Lunchroom duty',
        domain: 'meal_service',
        icon: Icons.restaurant_outlined,
        shifts: d.shifts,
        checklists: checklists,
        tasks: tasks,
      ),
      _dutyDashboard(
        title: 'Transport duty',
        domain: 'transport',
        icon: Icons.directions_bus_outlined,
        shifts: d.shifts,
        checklists: checklists,
        tasks: tasks,
      ),
      SectionCard(title: 'General staff checklist', children: [
        for (final item in checklists.where((x) => str(x['domain']) == 'general'))
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: item['completed_at'] != null,
            onChanged: item['completed_at'] != null ? null : (_) => _complete(item),
            title: Text(str(item['label'])),
            subtitle: Text(str(item['title'])),
          ),
        if (checklists.every((x) => str(x['domain']) != 'general'))
          const EmptyState('No general staff checklist items are assigned.'),
      ]),
      SectionCard(title: 'Staff handoffs', children: [
        if (handoffs.isEmpty) const EmptyState('No staff handoffs waiting.'),
        for (final h in handoffs)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(str(h['summary'])),
            subtitle: Text('${str(h['domain']).replaceAll('_', ' ')} · ${str(h['next_action'])}'),
            trailing: h['acknowledged_at'] == null && h['to_user_id'] != null
                ? TextButton(onPressed: () async {
                    try {
                      await AppScope.read(context).api.post('/api/staff-workspace/handoffs/${h['id']}/acknowledge', {});
                      if (mounted) { toast(context, 'Handoff acknowledged.'); _refreshDay(); }
                    } on ApiException { if (mounted) toast(context, 'Could not acknowledge handoff.'); }
                  }, child: const Text('Acknowledge'))
                : null,
          ),
      ]),
    ]);
  }

  Widget _dutyDashboard({
    required String title,
    required String domain,
    required IconData icon,
    required List<Json> shifts,
    required List<Json> checklists,
    required List<Json> tasks,
  }) {
    final assignedShifts = shifts.where((x) => str(x['department']) == domain).toList();
    final assignedChecklists = checklists.where((x) => str(x['domain']) == domain).toList();
    final assignedTasks = tasks.where((x) => str(x['domain']) == domain).toList();
    final completed = assignedChecklists.where((x) => x['completed_at'] != null).length;
    return SectionCard(title: title, children: [
      Row(children: [
        Icon(icon),
        const SizedBox(width: 8),
        Expanded(child: Text('${assignedShifts.length} shift(s) · ${completed}/${assignedChecklists.length} checklist items complete · ${assignedTasks.length} task(s)')),
      ]),
      if (assignedShifts.isNotEmpty) ...[
        const SizedBox(height: 8),
        const Text('Your assignments', style: TextStyle(fontWeight: FontWeight.w600)),
        for (final shift in assignedShifts)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.schedule_outlined),
            title: Text(str(shift['assignment'])),
            subtitle: Text('${str(shift['shift_date'])} · ${str(shift['starts_at'])}–${str(shift['ends_at'])}'),
          ),
      ],
      if (assignedChecklists.isNotEmpty) ...[
        const Divider(),
        const Text('Duty checklist', style: TextStyle(fontWeight: FontWeight.w600)),
        for (final item in assignedChecklists)
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: item['completed_at'] != null,
            onChanged: item['completed_at'] != null ? null : (_) => _complete(item),
            title: Text(str(item['label'])),
            subtitle: Text(str(item['title'])),
          ),
      ],
      if (assignedTasks.isNotEmpty) ...[
        const Divider(),
        const Text('Open work', style: TextStyle(fontWeight: FontWeight.w600)),
        for (final task in assignedTasks)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.assignment_outlined),
            title: Text(str(task['summary'])),
            subtitle: Text(str(task['status'])),
          ),
      ],
      if (assignedShifts.isEmpty && assignedChecklists.isEmpty && assignedTasks.isEmpty)
        const EmptyState('No assignments, checklists or tasks are assigned here today.'),
    ]);
  }

  Widget _arrivalTile(Json h) => ListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(str(h['display_name'])),
        subtitle: Text('${str(h['grade_level'])} · ${str(h['status'])} · ${str(h['initiated_at'])}'),
        trailing: str(h['status']) == 'pending'
            ? FilledButton.tonal(onPressed: () => _receive(h), child: const Text('Confirm handoff'))
            : StatusChip(str(h['status'])),
      );

  Widget _networkView(_TeacherNetwork n) {
    final colleagues = n.colleagues.where((c) => _search.isEmpty || str(c['name']).toLowerCase().contains(_search.toLowerCase()) ||
        objs(c['schools']).any((s) => str(s['name']).toLowerCase().contains(_search.toLowerCase()))).toList();
    return ListView(padding: const EdgeInsets.all(16), children: [
      SectionCard(title: 'Educator network', children: [
        const Text('Find verified teachers and principals across your district. Learners and families cannot join this network.'),
        TextField(
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), labelText: 'Search colleagues or schools'),
          onChanged: (v) => setState(() => _search = v),
        ),
        if (colleagues.isEmpty) const EmptyState('No matching colleagues found.'),
        for (final c in colleagues)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const CircleAvatar(child: Icon(Icons.person_outline)),
            title: Text(str(c['name'])),
            subtitle: Text('${str(c['roles'])} · ${objs(c['schools']).map((s) => str(s['name'])).join(', ')}'),
            trailing: IconButton(tooltip: 'Message colleague', onPressed: () => _message(c), icon: const Icon(Icons.chat_outlined)),
          ),
      ]),
      SectionCard(title: 'Professional learning and groups', children: [
        if (n.groups.isEmpty) const EmptyState('No discoverable educator groups yet.'),
        for (final g in n.groups)
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(str(g['name'])),
            subtitle: Text('${str(g['description'])} · ${integer(g['members'])} members · ${str(g['started_at_school'])}'),
            trailing: g['joined'] == true ? const StatusChip('present', text: 'Joined') : TextButton(onPressed: () => _join(g), child: const Text('Join')),
          ),
      ]),
    ]);
  }
}

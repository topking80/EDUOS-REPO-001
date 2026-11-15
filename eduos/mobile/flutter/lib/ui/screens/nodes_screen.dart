import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';
import 'web_fallback_screen.dart';

const _foState = {
  'authorized': ('absent', 'Authorized'),
  'active': ('absent', 'Covering'),
  'handing_back': ('expected', 'Handing back'),
  'returned': ('expected', 'Returned'),
  'purged': ('present', 'Closed'),
  'expired': ('present', 'Expired'),
};

/// EDEN nodes, at a glance: a district hub's school nodes and failovers
/// (end one), or this school node's link to the district (sync now). Setting
/// up partners, authorizing failover, enrollment and signed updates stay on
/// the web, where there's room to read what each step does.
class NodesScreen extends StatefulWidget {
  const NodesScreen({super.key});

  @override
  State<NodesScreen> createState() => _NodesScreenState();
}

class _NodesScreenState extends State<NodesScreen> {
  Key _key = UniqueKey();

  late final _api = AppScope.read(context).api;

  Future<Map<String, Object?>?> _optional(String path) async {
    try {
      return await _api.get(path);
    } on ApiException catch (e) {
      if (e.isUnauthorized || e.isOffline) rethrow;
      return null;
    }
  }

  Future<(String, Json)> _load() async {
    final tier = str(obj((await _optional('/api/eden/tier'))?['data'])['tier']);
    if (tier == 'district') return ('district', obj((await _api.get('/api/eden/admin/overview'))['data']));
    if (tier == 'school') {
      final s = await _optional('/api/node/status');
      return s == null ? ('none', <String, Object?>{}) : ('school', obj(s['data']));
    }
    return ('none', <String, Object?>{});
  }

  Widget _webLink(String label) => OutlinedButton.icon(
        icon: const Icon(Icons.open_in_new),
        label: Text(label),
        onPressed: () => openWebApp(context, path: '/app/#/nodes'),
      );

  Widget _district(Json o) {
    final nodes = objs(o['nodes']), failovers = objs(o['failovers']), hub = obj(o['hub']);
    final byId = {for (final n in nodes) str(n['id']): n};
    final open = failovers.where((f) => const {'authorized', 'active', 'handing_back', 'returned'}.contains(f['status'])).toList();
    final online = nodes.where((n) => n['online'] == true).length;
    final superintendent = AppScope.of(context).me?.role == 'superintendent';
    return ListView(padding: const EdgeInsets.all(16), children: [
      SectionCard(children: [
        Text('EDEN district hub', style: Theme.of(context).textTheme.bodySmall),
        Semantics(header: true, child: Text('$online of ${nodes.length} school node${nodes.length == 1 ? '' : 's'} online', style: Theme.of(context).textTheme.titleLarge)),
        Text('Trust root ${str(hub['rootFingerprint'], 'not set')} · district certificate until ${hub['districtCertExpires'] == null ? '—' : fmtDay(date(hub['districtCertExpires']))}',
            style: Theme.of(context).textTheme.bodySmall),
      ]),
      if (open.isNotEmpty)
        SectionCard(title: 'Failover in progress', color: Theme.of(context).colorScheme.errorContainer, children: [
          for (final f in open)
            Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(str(f['school_name']), style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${str(byId[str(f['partner_node_id'])]?['school_name'], 'Partner')} is covering · until ${fmtTime(date(f['expires_at']))} ${fmtDay(date(f['expires_at']))} · by ${str(f['authorized_by_name'])}'),
                trailing: StatusChip(_foState[f['status']]?.$1 ?? 'expected', text: _foState[f['status']]?.$2 ?? str(f['status'])),
              ),
              if (superintendent && (f['status'] == 'authorized' || f['status'] == 'active'))
                Align(
                  alignment: Alignment.centerLeft,
                  child: OutlinedButton(
                    onPressed: () async {
                      final ok = await confirm(context,
                          title: 'End the failover for ${f['school_name']}?', text: 'The partner hands everything back to the school node, then deletes its copy.', action: 'End failover');
                      if (!ok || !mounted) return;
                      try {
                        await AppScope.read(context).api.post('/api/eden/admin/failovers/${f['id']}/end');
                        if (!mounted) return;
                        toast(context, 'Handback started');
                        setState(() => _key = UniqueKey());
                      } on ApiException {
                        if (mounted) toast(context, 'Couldn\'t end the failover.');
                      }
                    },
                    child: Text('End failover', semanticsLabel: 'End failover for ${f['school_name']}'),
                  ),
                ),
            ]),
        ]),
      SectionCard(title: 'Nodes', children: [
        if (nodes.isEmpty) const EmptyState('No school nodes yet.'),
        for (final n in nodes)
          () {
            final health = obj(obj(n['last_health'])['metrics']);
            final revoked = n['status'] == 'revoked';
            return ListTile(
              contentPadding: EdgeInsets.zero,
              isThreeLine: true,
              title: Text(str(n['school_name']), style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text([
                '${str(n['name'])} · v${str(n['version'], '?')} · seen ${n['last_seen_at'] == null ? 'never' : ago(date(n['last_seen_at']))}',
                if (health['outbox_pending'] != null) '${integer(health['outbox_pending'])} waiting',
                'partner: ${str(byId[str(n['partner_node_id'])]?['school_name'], 'none')}',
              ].join(' · ')),
              trailing: StatusChip(revoked ? 'absent' : n['online'] == true ? 'present' : 'absent', text: revoked ? 'Revoked' : n['online'] == true ? 'Online' : 'Offline'),
            );
          }(),
      ]),
      _webLink('Partners, failover, enrollment and updates (web)'),
    ]);
  }

  Widget _school(Json s) {
    final up = str(obj(s['uplink'])['state']);
    final outbox = obj(s['outbox']);
    final hosting = objs(s['hosting']).where((x) => x['status'] == 'active').toList();
    return ListView(padding: const EdgeInsets.all(16), children: [
      SectionCard(color: up == 'offline' ? Theme.of(context).colorScheme.errorContainer : null, children: [
        Text('${str(obj(s['school'])['name'])} · EduOS ${str(s['version'])}', style: Theme.of(context).textTheme.bodySmall),
        Semantics(
          header: true,
          child: Text(up == 'online' ? 'Connected to the district' : up == 'offline' ? 'District link is down' : 'Not set up', style: Theme.of(context).textTheme.titleLarge),
        ),
        Text(up == 'offline'
            ? 'Working locally. Attendance, bus check-ins, roll call, pick-up and gradebook all keep working here. ${integer(outbox['pending'])} update${integer(outbox['pending']) == 1 ? '' : 's'} for the district waiting.'
            : up == 'online'
                ? 'Last synced ${obj(s['uplink'])['lastOkAt'] == null ? '—' : ago(date(obj(s['uplink'])['lastOkAt']))}.'
                : str(s['reason'])),
        if (s['enabled'] == true) ...[
          const SizedBox(height: 8),
          FilledButton.icon(
            icon: const Icon(Icons.sync),
            label: const Text('Sync now'),
            onPressed: () async {
              try {
                final r = obj((await AppScope.read(context).api.post('/api/node/sync-now')).data);
                if (mounted) toast(context, r['uplink'] == 'online' ? 'Synced' : 'District still unreachable');
              } on ApiException {
                if (mounted) toast(context, 'Couldn\'t sync.');
              }
              if (mounted) setState(() => _key = UniqueKey());
            },
          ),
        ],
      ]),
      SectionCard(title: 'Sync', children: [
        for (final (k, v) in [
          ('Waiting to send', '${integer(outbox['pending'])}'),
          ('Sent', '${integer(outbox['sent'])}'),
          ('Failed attempts in a row', '${integer(obj(s['uplink'])['consecutiveFailures'])}'),
          ('Partner school', str(obj(s['partner'])['name'], 'none')),
        ])
          ListTile(dense: true, contentPadding: EdgeInsets.zero, title: Text(k), trailing: Text(v)),
      ]),
      if (hosting.isNotEmpty)
        SectionCard(title: 'Covering for another school', color: Theme.of(context).colorScheme.errorContainer, children: [
          for (final x in hosting) ListTile(contentPadding: EdgeInsets.zero, title: Text(str(x['school_name'])), subtitle: Text('Until ${fmtTime(date(x['expires_at']))}')),
        ]),
      _webLink('Egress log and device details (web)'),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    return Loader<(String, Json)>(
      key: _key,
      load: _load,
      builder: (context, d, _) => switch (d.$1) {
        'district' => _district(d.$2),
        'school' => _school(d.$2),
        _ => ListView(padding: const EdgeInsets.all(16), children: const [
            SectionCard(title: 'School nodes', children: [Text('This EduOS server is not set up as an EDEN district hub or school node, so there are no nodes to manage.')]),
          ]),
      },
    );
  }
}

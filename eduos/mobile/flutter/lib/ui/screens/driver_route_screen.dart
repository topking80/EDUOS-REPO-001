import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// Bus driver: today's run, stop by stop (GET /api/transport/today).
/// Check-ins are the offline-safe write: with no signal they are kept on the
/// phone and sent later with their original time, so the driver never has to
/// stop and wait for the network. Starting and finishing a run need a
/// connection.
class DriverRouteScreen extends StatefulWidget {
  const DriverRouteScreen({super.key});

  @override
  State<DriverRouteScreen> createState() => _DriverRouteScreenState();
}

class _DriverRouteScreenState extends State<DriverRouteScreen> {
  String? _routeId;
  Key _loaderKey = UniqueKey();

  /// Check-ins saved on this phone but not yet confirmed by the server,
  /// shown on screen only while this screen is open (never persisted here).
  final Map<String, String> _pending = {};

  void _reload() => setState(() => _loaderKey = UniqueKey());

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Once the phone has sent everything it saved, show the server's view again.
    final queued = AppScope.of(context).queued;
    if (queued == 0 && _pending.isNotEmpty) {
      _pending.clear();
      _loaderKey = UniqueKey();
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    return Loader<List<DriverRoute>>(
      key: _loaderKey,
      load: () async => objs(obj((await app.api.get('/api/transport/today'))['data'])['routes']).map(DriverRoute.fromJson).toList(),
      builder: (context, routes, reload) {
        if (routes.isEmpty) return ListView(children: const [EmptyState('No routes are assigned to you.')]);
        final route = routes.where((r) => r.id == _routeId).firstOrNull ??
            routes.where((r) => r.run?.live ?? false).firstOrNull ??
            routes.first;
        return _RouteView(
          key: ValueKey(route.id),
          route: route,
          routes: routes,
          pending: _pending,
          onPickRoute: (id) => setState(() => _routeId = id),
          onChanged: _reload,
          onPending: (studentId, event) => setState(() => _pending[studentId] = event),
        );
      },
    );
  }
}

class _RouteView extends StatelessWidget {
  const _RouteView({super.key, required this.route, required this.routes, required this.pending,
      required this.onPickRoute, required this.onChanged, required this.onPending});

  final DriverRoute route;
  final List<DriverRoute> routes;
  final Map<String, String> pending;
  final ValueChanged<String> onPickRoute;
  final VoidCallback onChanged;
  final void Function(String studentId, String event) onPending;

  String _status(RouteRider r) => pending[r.studentId] ?? r.status;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final run = route.run;
    final live = run?.live ?? false;
    final riders = route.stops.expand((s) => s.riders).toList();
    final onBoard = riders.where((r) => _status(r) == 'boarded').toList();
    final dropped = riders.where((r) => _status(r) == 'alighted').length;
    final expected = riders.where((r) => _status(r) == 'expected').length;

    Future<void> checkin(RouteRider rider, RouteStop stop, String event) async {
      try {
        final sent = await app.api.post('/api/transport/runs/${run!.id}/checkins', {'studentId': rider.studentId, 'stopId': stop.id, 'event': event});
        if (!context.mounted) return;
        if (sent.queued) {
          onPending(rider.studentId, event);
          await app.refreshStatus();
          if (context.mounted) toast(context, '${firstName(rider.name)}: saved on this phone, sends when back online');
          return;
        }
        toast(context, '${firstName(rider.name)}: ${statusLabel(event)}');
        onChanged();
      } on ApiException catch (e) {
        if (context.mounted) toast(context, e.status == 429 ? 'Too many taps, wait a moment.' : 'Check-in failed. Try again.');
      }
    }

    return ListView(padding: const EdgeInsets.all(16), children: [
      if (routes.length > 1)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: SegmentedButton<String>(
            segments: [for (final r in routes) ButtonSegment(value: r.id, label: Text(r.direction == 'am' ? 'Morning' : 'Afternoon'))],
            selected: {route.id},
            onSelectionChanged: (v) => onPickRoute(v.first),
          ),
        ),
      SectionCard(children: [
        Text(route.schoolName, style: Theme.of(context).textTheme.bodySmall),
        Semantics(header: true, child: Text('${route.busLabel} · ${route.name}', style: Theme.of(context).textTheme.titleLarge)),
        const SizedBox(height: 12),
        Row(children: [
          Expanded(child: StatTile(onBoard.length, 'ON BOARD')),
          Expanded(child: StatTile(expected, 'expected')),
          Expanded(child: StatTile(dropped, 'dropped off')),
        ]),
        if (pending.isNotEmpty) Notice('${pending.length} check-in${pending.length == 1 ? '' : 's'} saved on this phone, waiting for signal.'),
      ]),
      if (run == null)
        FilledButton(
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
          onPressed: () async {
            try {
              await app.api.post('/api/transport/runs', {'routeId': route.id});
              if (context.mounted) toast(context, 'Run started');
              onChanged();
            } on ApiException catch (e) {
              if (context.mounted) toast(context, e.isOffline ? 'Starting a run needs a connection.' : 'Couldn\'t start the run.');
            }
          },
          child: const Text('Start run'),
        )
      else if (run.status == 'completed')
        SectionCard(children: [Text('Run completed at ${fmtTime(run.completedAt)}.')]),
      const SizedBox(height: 12),
      for (final stop in route.stops)
        SectionCard(
          color: stop.isSchool ? Theme.of(context).colorScheme.secondaryContainer : null,
          children: [
            Semantics(
              header: true,
              child: Text('${stop.seq}. ${stop.name}', style: Theme.of(context).textTheme.titleMedium),
            ),
            Text([if (stop.time != null) stop.time!, if (stop.riders.isNotEmpty) '${stop.riders.length} rider${stop.riders.length > 1 ? 's' : ''}'].join(' · '),
                style: Theme.of(context).textTheme.bodySmall),
            for (final rider in stop.riders)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${rider.name} · gr ${rider.grade}', style: const TextStyle(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 4),
                      Row(children: [
                        StatusChip(_status(rider)),
                        if (pending.containsKey(rider.studentId)) ...[
                          const SizedBox(width: 6),
                          const Icon(Icons.cloud_off, size: 16, semanticLabel: 'Saved on this phone'),
                        ],
                      ]),
                    ]),
                  ),
                  if (live && _status(rider) != 'boarded')
                    FilledButton(
                      style: FilledButton.styleFrom(minimumSize: const Size(112, 52)),
                      onPressed: () => checkin(rider, stop, 'boarded'),
                      child: Text('ON BOARD', semanticsLabel: '${rider.name}: on board'),
                    ),
                  if (live && _status(rider) == 'expected') ...[
                    const SizedBox(width: 8),
                    OutlinedButton(
                      style: OutlinedButton.styleFrom(minimumSize: const Size(0, 52)),
                      onPressed: () => checkin(rider, stop, 'not_riding'),
                      child: Text('Not riding', semanticsLabel: '${rider.name}: not riding'),
                    ),
                  ],
                ]),
              ),
            if (live && stop.isSchool) ...[
              const Divider(),
              if (onBoard.isEmpty)
                const Text('No riders on board.')
              else ...[
                Text('Drop off at ${stop.name}:'),
                for (final rider in onBoard)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    child: Row(children: [
                      Expanded(child: Text(rider.name)),
                      OutlinedButton(
                        style: OutlinedButton.styleFrom(minimumSize: const Size(96, 52)),
                        onPressed: () => checkin(rider, stop, 'alighted'),
                        child: Text('OFF', semanticsLabel: '${rider.name}: off the bus'),
                      ),
                    ]),
                  ),
              ],
            ],
          ],
        ),
      if (live)
        FilledButton.tonal(
          style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
          onPressed: () async {
            try {
              await app.api.post('/api/transport/runs/${run!.id}/complete');
              if (context.mounted) toast(context, 'Run completed');
              onChanged();
            } on ApiException catch (e) {
              if (!context.mounted) return;
              toast(context, switch (e) {
                ApiException(error: 'riders_still_on_board') => 'Riders still on board. Check everyone off first.',
                ApiException(isOffline: true) => 'Finishing a run needs a connection.',
                _ => 'Couldn\'t finish the run.',
              });
            }
          },
          child: const Text('Finish run'),
        ),
      const Notice('Tap ON BOARD when a rider gets on and OFF when they get off. EduOS records only these taps at named stops; it does not use GPS or track anyone\'s location.'),
    ]);
  }
}

// Performance benchmarks for the app's network and storage paths, with a
// simulated network round trip and keystore cost, so changes can be compared
// and regressions caught. Run: flutter test test/performance_test.dart
//
// These measure the app's own work and waiting (round trips in sequence,
// keystore reads/writes, bytes downloaded); they are not device frame timings.
import 'dart:convert';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/core/api_client.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/offline_queue.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const rtt = Duration(milliseconds: 60); // one network round trip
const keystoreCost = Duration(milliseconds: 3); // one keystore read or write
final server = Uri.parse('https://eduos.district.test');

/// A keystore that counts operations and takes [keystoreCost] for each.
class CountingStore implements KeyValueStore {
  final MemoryKeyValueStore inner = MemoryKeyValueStore();
  int reads = 0, writes = 0;
  int get ops => reads + writes;

  @override
  Future<String?> read(String key) async {
    reads++;
    await Future<void>.delayed(keystoreCost);
    return inner.read(key);
  }

  @override
  Future<void> write(String key, String value) async {
    writes++;
    await Future<void>.delayed(keystoreCost);
    await inner.write(key, value);
  }

  @override
  Future<void> delete(String key) async {
    writes++;
    await inner.delete(key);
  }
}

/// A district server with [rtt] latency per request; counts requests and bytes.
class SlowServer {
  int requests = 0, bytes = 0;
  final Map<String, int> byPath = {};

  http.Client client() => MockClient((r) async {
        requests++;
        byPath[r.url.path] = (byPath[r.url.path] ?? 0) + 1;
        await Future<void>.delayed(rtt);
        final body = _route(r);
        final text = jsonEncode(body);
        bytes += utf8.encode(text).length;
        return http.Response(text, r.method == 'POST' ? 201 : 200, headers: {'content-type': 'application/json'});
      });

  Object _route(http.Request r) {
    switch (r.url.path) {
      case '/api/me':
        return {'userId': 'u-t', 'displayName': 'Ms. Rivera', 'role': 'teacher', 'districtId': 'd1', 'schoolId': 's1'};
      case '/api/branding/current':
        return {'data': {'school': {'name': 'Maple Elementary'}, 'branding': {}}};
      case '/api/safety/status':
        return {'data': {'incidents': [], 'canInitiate': false, 'canLead': false}};
      case '/api/notifications':
        if (r.url.queryParameters['summary'] == '1') return {'data': {'unread': 3}};
        return {
          'data': {
            'unread': 3,
            'items': [
              for (var i = 0; i < 50; i++)
                {'id': 'n$i', 'kind': 'announcement', 'title': 'School announcement $i', 'body': 'x' * 400, 'created_at': '2026-11-16T08:00:00Z', 'read_at': null}
            ]
          }
        };
      default:
        return {'data': {'ok': true}};
    }
  }
}

Future<(AppController, SlowServer, CountingStore)> signedIn() async {
  final store = CountingStore();
  final sessions = SessionStore(store.inner);
  await sessions.saveServer(server);
  await sessions.save(Session(serverUrl: server, token: 'tok', csrfToken: 'csrf', expiresAt: DateTime.now().add(const Duration(hours: 8))));
  final fake = SlowServer();
  final app = AppController(store: store, httpClientFactory: fake.client, safetyPollInterval: null);
  return (app, fake, store);
}

String report(String name, Map<String, Object> values) {
  final line = '[perf] $name: ${values.entries.map((e) => '${e.key}=${e.value}').join(' ')}';
  // ignore: avoid_print
  print(line);
  return line;
}

void main() {
  test('app start: signed-in launch to a ready home', () async {
    final (app, fake, store) = await signedIn();
    final sw = Stopwatch()..start();
    await app.start();
    sw.stop();
    expect(app.stage, AppStage.signedIn);
    report('start', {'ms': sw.elapsedMilliseconds, 'requests': fake.requests, 'roundTripsInSequence': (sw.elapsedMilliseconds / rtt.inMilliseconds).round(), 'keystoreOps': store.ops});
    // Budget: everything at launch goes out together (it was 4 round trips in a row).
    expect(sw.elapsedMilliseconds, lessThan(rtt.inMilliseconds * 2 + 60));
    app.dispose();
  });

  test('status poll (every 30 s while the app is open)', () async {
    final (app, fake, store) = await signedIn();
    await app.start();
    final before = (fake.requests, fake.bytes, store.ops);
    final sw = Stopwatch()..start();
    await app.refreshStatus();
    sw.stop();
    final bytes = fake.bytes - before.$2;
    report('poll', {'ms': sw.elapsedMilliseconds, 'requests': fake.requests - before.$1, 'bytes': bytes, 'keystoreOps': store.ops - before.$3});
    expect(app.unread, 3);
    expect(sw.elapsedMilliseconds, lessThan(rtt.inMilliseconds * 2), reason: 'status and unread count in parallel');
    expect(bytes, lessThan(1000), reason: 'the poll needs the unread count, not 50 notifications');
    expect(store.ops - before.$3, lessThanOrEqualTo(1));
    app.dispose();
  });

  test('offline: queue 200 marks, then send them when the signal returns', () async {
    final store = CountingStore();
    final queue = OfflineQueue(store);
    const owner = QueueOwner(server: 'https://eduos.district.test', userId: 'u-t', districtId: 'd1', role: 'teacher', schoolId: 's1');
    final at = DateTime.now();
    final sw = Stopwatch()..start();
    for (var i = 0; i < 200; i++) {
      await queue.enqueue(QueuedWrite(path: '/api/attendance', body: {'studentId': 's$i', 'eventDate': '2026-11-16', 'status': 'present'}, idempotencyKey: 'k$i', queuedAt: at, owner: owner));
    }
    sw.stop();
    final enqueueOps = store.ops, enqueueMs = sw.elapsedMilliseconds;
    store.reads = 0;
    store.writes = 0;
    var sent = 0;
    final flush = Stopwatch()..start();
    final result = await queue.flush(owner, (w) async {
      await Future<void>.delayed(rtt);
      sent++;
      return ReplayOutcome.done;
    });
    flush.stop();
    report('offline', {'enqueue200ms': enqueueMs, 'enqueueKeystoreOps': enqueueOps, 'flush200ms': flush.elapsedMilliseconds, 'flushKeystoreOps': store.ops, 'sent': sent});
    expect(result.sent, 200);
    expect(result.remaining, 0);
    expect(await queue.length, 0);
    expect(enqueueOps, lessThanOrEqualTo(201), reason: 'one read, then one write per mark');
    expect(store.ops, lessThan(60), reason: 'no full re-read and re-write of the queue for every mark');
    expect(flush.elapsedMilliseconds, lessThan(200 * rtt.inMilliseconds ~/ 3), reason: 'marks are sent a few at a time');
  });

  test('offline: what a burst of duplicate taps costs', () async {
    final store = CountingStore();
    final queue = OfflineQueue(store);
    const owner = QueueOwner(server: 'https://eduos.district.test', userId: 'u-t', districtId: 'd1', role: 'teacher', schoolId: 's1');
    final api = ApiClient(
      session: () => Session(serverUrl: server, token: 't', csrfToken: 'c', expiresAt: DateTime.now().add(const Duration(hours: 1))),
      queue: queue,
      owner: () => owner,
      httpClient: MockClient((r) async => throw http.ClientException('offline')),
    );
    for (var i = 0; i < 5; i++) {
      final w = await api.post('/api/attendance', {'studentId': 's1', 'eventDate': '2026-11-16', 'status': 'present'});
      expect(w.queued, isTrue);
    }
    final n = await queue.length;
    report('duplicates', {'tapsQueued': 5, 'entriesKept': n});
    expect(n, 1, reason: 'the same mark tapped five times offline is kept once');
  });
}

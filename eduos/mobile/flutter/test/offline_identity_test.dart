import 'dart:convert';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

// The audit's P1: offline attendance saved by one teacher must never be sent
// under another account after the first session ends (expiry or a 401).
final server = Uri.parse('https://eduos.example.test');
const ada = 'b0000000-0000-4000-8000-00000000000a';

class School {
  bool online = true;
  final Set<String> expired = {};
  final List<(String token, Map<String, Object?> body)> attendance = [];
  final Map<String, Map<String, Object?>> users = {
    'tok-a': {'userId': 'u-a', 'displayName': 'Ms. A', 'role': 'teacher', 'districtId': 'd1', 'schoolId': 's1'},
    'tok-b': {'userId': 'u-b', 'displayName': 'Mr. B', 'role': 'teacher', 'districtId': 'd1', 'schoolId': 's1'},
  };

  http.Client client() => MockClient((r) async {
        if (!online) throw http.ClientException('offline');
        final token = (r.headers['authorization'] ?? '').replaceFirst('Bearer ', '');
        if (expired.contains(token) || !users.containsKey(token)) return http.Response('{"error":"invalid_session"}', 401);
        final key = '${r.method} ${r.url.path}';
        if (key == 'GET /api/me') return http.Response(jsonEncode(users[token]), 200);
        if (key == 'POST /api/attendance') {
          attendance.add((token, jsonDecode(r.body) as Map<String, Object?>));
          return http.Response('{"data":{"id":"e1"}}', 201);
        }
        if (key == 'GET /api/safety/status') return http.Response('{"data":{"incidents":[]}}', 200);
        return http.Response('{"data":{}}', 200);
      });
}

Future<AppController> signedIn(KeyValueStore kv, School school, String token) async {
  final sessions = SessionStore(kv);
  await sessions.saveServer(server);
  await sessions.save(Session(serverUrl: server, token: token, csrfToken: 'c', expiresAt: DateTime.now().add(const Duration(hours: 8))));
  final app = AppController(store: kv, httpClientFactory: school.client, safetyPollInterval: null);
  await app.start();
  expect(app.stage, AppStage.signedIn);
  return app;
}

void main() {
  test('after a session expires, another teacher signing in never sends the first teacher\'s offline attendance', () async {
    final kv = MemoryKeyValueStore(), school = School();
    final a = await signedIn(kv, school, 'tok-a');
    school.online = false;
    expect((await a.api.post('/api/attendance', {'studentId': ada, 'eventDate': '2026-11-16', 'status': 'absent'})).queued, isTrue);
    await a.refreshStatus();
    expect(a.queued, 1);

    // Back online, but Ms. A's session has expired: the 401 drops the session
    // without clearing the queue (her work must survive for her).
    school.online = true;
    school.expired.add('tok-a');
    await a.flushQueue();
    await Future<void>.delayed(Duration.zero);
    expect(a.stage, AppStage.signedOut);
    a.dispose();

    final b = await signedIn(kv, school, 'tok-b');
    await b.flushQueue();
    expect(school.attendance, isEmpty, reason: 'Mr. B must never send Ms. A\'s attendance');
    expect([b.queued, b.heldForOthers], [0, 1]);
    b.dispose();

    // Ms. A signs back in: her own write goes out, as hers.
    school.expired.remove('tok-a');
    final again = await signedIn(kv, school, 'tok-a');
    await again.flushQueue();
    expect(school.attendance.map((x) => x.$1), ['tok-a']);
    expect(school.attendance.single.$2['status'], 'absent');
    expect([again.queued, again.heldForOthers], [0, 0]);
    again.dispose();
  });

  test('switching membership holds writes saved under the other role', () async {
    final kv = MemoryKeyValueStore(), school = School();
    final a = await signedIn(kv, school, 'tok-a');
    school.online = false;
    await a.api.post('/api/attendance', {'studentId': ada, 'eventDate': '2026-11-16', 'status': 'present'});
    school.online = true;
    school.users['tok-a'] = {...school.users['tok-a']!, 'role': 'principal'}; // same user, now acting as principal
    a.dispose();
    final asPrincipal = await signedIn(kv, school, 'tok-a');
    await asPrincipal.flushQueue();
    expect(school.attendance, isEmpty);
    expect(asPrincipal.heldForOthers, 1);
    asPrincipal.dispose();
  });
}

import 'dart:convert';
import 'dart:io';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/core/api_client.dart';
import 'package:eduos_mobile_branding/core/auth_service.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/offline_queue.dart';
import 'package:eduos_mobile_branding/core/pkce.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

final server = Uri.parse('https://eduos.example.test');
Session session([String token = 'tok-1', String csrf = 'csrf-1']) =>
    Session(serverUrl: server, token: token, csrfToken: csrf, expiresAt: DateTime.now().add(const Duration(hours: 8)));
const runPath = '/api/transport/runs/11111111-2222-4333-8444-555555555555/checkins';

void main() {
  group('PKCE', () {
    test('matches the RFC 7636 appendix B test vector', () {
      expect(Pkce.challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });
    test('generates a 64-char URL-safe verifier and a 43-char challenge', () {
      final p = Pkce.generate();
      expect(p.verifier, matches(RegExp(r'^[A-Za-z0-9_-]{64}$')));
      expect(p.challenge, matches(RegExp(r'^[A-Za-z0-9_-]{43}$')));
      expect(Pkce.generate().verifier, isNot(p.verifier));
    });
  });

  group('Session store', () {
    test('round-trips, and drops expired or corrupt sessions', () async {
      final kv = MemoryKeyValueStore();
      final store = SessionStore(kv);
      await store.save(session());
      expect((await store.load())!.token, 'tok-1');
      await store.save(Session(serverUrl: server, token: 't', csrfToken: 'c', expiresAt: DateTime.now().subtract(const Duration(seconds: 1))));
      expect(await store.load(), isNull);
      expect(kv.values.containsKey('eduos.session'), isFalse);
      kv.values['eduos.session'] = '{not json';
      expect(await store.load(), isNull);
    });
  });

  group('Offline queue', () {
    test('only the web app\'s allowlist is queueable, and only POST', () {
      expect(OfflineQueue.isQueueable('POST', runPath), isTrue);
      expect(OfflineQueue.isQueueable('POST', '/api/attendance'), isTrue);
      expect(OfflineQueue.isQueueable('POST', '/api/safety/incidents/11111111-2222-4333-8444-555555555555/rollcall'), isTrue);
      expect(OfflineQueue.isQueueable('GET', '/api/attendance'), isFalse);
      expect(OfflineQueue.isQueueable('POST', '/api/pickup/tags'), isFalse, reason: 'pick-up is online-only');
      expect(OfflineQueue.isQueueable('POST', '/api/attendance/x'), isFalse);
    });

    test('drops writes older than 24 hours and caps at 200', () async {
      var now = DateTime(2026, 11, 14, 8);
      final q = OfflineQueue(MemoryKeyValueStore(), clock: () => now);
      await q.enqueue(QueuedWrite(path: '/api/attendance', body: const {}, idempotencyKey: 'old', queuedAt: now));
      now = now.add(const Duration(hours: 24, seconds: 1));
      expect(await q.length, 0);
      for (var i = 0; i < OfflineQueue.maxEntries; i++) {
        await q.enqueue(QueuedWrite(path: '/api/attendance', body: const {}, idempotencyKey: 'k$i', queuedAt: now));
      }
      await expectLater(q.enqueue(QueuedWrite(path: '/api/attendance', body: const {}, idempotencyKey: 'x', queuedAt: now)), throwsA(isA<OfflineQueueFullException>()));
      expect(() => q.enqueue(QueuedWrite(path: '/api/pickup/tags', body: const {}, idempotencyKey: 'y', queuedAt: now)), throwsArgumentError);
    });

    test('flush sends oldest first, stops at retryLater, removes rejected, keeps writes queued meanwhile', () async {
      final q = OfflineQueue(MemoryKeyValueStore());
      final at = DateTime.now();
      for (final k in ['a', 'b', 'c', 'd']) {
        await q.enqueue(QueuedWrite(path: '/api/attendance', body: {'k': k}, idempotencyKey: k, queuedAt: at));
      }
      final seen = <String>[];
      final r = await q.flush((w) async {
        seen.add(w.idempotencyKey);
        if (w.idempotencyKey == 'a') await q.enqueue(QueuedWrite(path: '/api/attendance', body: const {}, idempotencyKey: 'late', queuedAt: at));
        return switch (w.idempotencyKey) { 'a' => ReplayOutcome.done, 'b' => ReplayOutcome.rejected, _ => ReplayOutcome.retryLater };
      });
      expect(seen, ['a', 'b', 'c']);
      expect([r.sent, r.rejected, r.remaining], [1, 1, 3]);
      expect((await q.entries()).map((e) => e.idempotencyKey), ['c', 'd', 'late']);
    });
  });

  group('API client', () {
    test('sends the bearer token, never a cookie, and CSRF only on writes', () async {
      final seen = <http.Request>[];
      final api = ApiClient(
        session: session,
        queue: OfflineQueue(MemoryKeyValueStore()),
        httpClient: MockClient((r) async {
          seen.add(r);
          return http.Response('{"data":{"ok":true}}', 200);
        }),
      );
      await api.get('/api/me');
      await api.post('/api/comms/threads', {'subject': 's'});
      expect(seen[0].url.toString(), 'https://eduos.example.test/api/me');
      expect(seen[0].headers['authorization'], 'Bearer tok-1');
      expect(seen[0].headers.containsKey('x-csrf-token'), isFalse);
      expect(seen[0].headers.containsKey('cookie'), isFalse);
      expect(seen[1].headers['x-csrf-token'], 'csrf-1');
      expect(jsonDecode(seen[1].body), {'subject': 's'});
    });

    test('a stale CSRF token is refreshed once and the write retried', () async {
      var csrfCalls = 0;
      String? refreshed;
      final api = ApiClient(
        session: session,
        queue: OfflineQueue(MemoryKeyValueStore()),
        onCsrfRefreshed: (t) => refreshed = t,
        httpClient: MockClient((r) async {
          if (r.url.path == '/api/csrf') {
            csrfCalls++;
            return http.Response('{"csrfToken":"csrf-2"}', 200);
          }
          return r.headers['x-csrf-token'] == 'csrf-2'
              ? http.Response('{"data":{}}', 201)
              : http.Response('{"error":"csrf_validation_failed"}', 403);
        }),
      );
      final res = await api.post('/api/pickup/adults', const {});
      expect(res.queued, isFalse);
      expect(csrfCalls, 1);
      expect(refreshed, 'csrf-2');
    });

    test('401 reports the session as gone; other errors carry the server code', () async {
      var gone = 0;
      final api = ApiClient(
        session: session,
        queue: OfflineQueue(MemoryKeyValueStore()),
        onUnauthorized: () => gone++,
        httpClient: MockClient((r) async => r.url.path == '/api/me'
            ? http.Response('{"error":"invalid_session"}', 401)
            : http.Response('{"error":"adult_already_listed"}', 409)),
      );
      await expectLater(api.get('/api/me'), throwsA(isA<ApiException>().having((e) => e.status, 'status', 401)));
      expect(gone, 1);
      await expectLater(api.post('/api/pickup/adults', const {}), throwsA(isA<ApiException>().having((e) => e.error, 'error', 'adult_already_listed')));
    });

    test('an allowlisted write is queued when offline or the server is down, then replayed with the same key', () async {
      final q = OfflineQueue(MemoryKeyValueStore());
      var mode = 'offline';
      final sent = <http.Request>[];
      final api = ApiClient(
        session: session,
        queue: q,
        httpClient: MockClient((r) async {
          sent.add(r);
          if (mode == 'offline') throw const SocketException('no route');
          if (mode == 'down') return http.Response('bad gateway', 502);
          return http.Response('{"data":{"queued":true}}', 201);
        }),
      );
      final first = await api.post(runPath, {'studentId': 's1', 'event': 'boarded'});
      expect(first.queued, isTrue);
      mode = 'down';
      expect((await api.post(runPath, {'studentId': 's2', 'event': 'boarded'})).queued, isTrue);
      expect(await q.length, 2);
      // Non-allowlisted writes are never queued.
      mode = 'offline';
      await expectLater(api.post('/api/pickup/tags', const {}), throwsA(isA<ApiException>().having((e) => e.isOffline, 'offline', isTrue)));
      expect(await q.length, 2);

      final original = (await q.entries()).first;
      mode = 'online';
      sent.clear();
      final r = await api.flushQueue();
      expect([r.sent, r.remaining], [2, 0]);
      expect(sent.first.headers['idempotency-key'], original.idempotencyKey);
      expect(sent.first.headers['x-eduos-queued-at'], original.queuedAt.toUtc().toIso8601String());
      expect(sent.first.headers['idempotency-key'], matches(RegExp(r'^[0-9a-f]{32}$')));
      expect(jsonDecode(sent.first.body), {'studentId': 's1', 'event': 'boarded'});
    });

    test('replays refused by the server are dropped; busy or signed-out replays wait', () async {
      final q = OfflineQueue(MemoryKeyValueStore());
      for (final k in ['a', 'b']) {
        await q.enqueue(QueuedWrite(path: runPath, body: const {}, idempotencyKey: k, queuedAt: DateTime.now()));
      }
      var status = 409;
      final api = ApiClient(session: session, queue: q, httpClient: MockClient((r) async => http.Response('{"error":"queued_write_too_old"}', status)));
      expect((await api.flushQueue()).rejected, 2);
      await q.enqueue(QueuedWrite(path: runPath, body: const {}, idempotencyKey: 'c', queuedAt: DateTime.now()));
      for (status in [401, 429, 503]) {
        expect((await api.flushQueue()).remaining, 1, reason: '$status keeps the write');
      }
    });
  });

  group('Auth service', () {
    test('builds the native login URL the server expects', () {
      final p = Pkce.generate();
      final u = AuthService.loginUrl(server, p);
      expect(u.path, '/auth/login');
      expect(u.queryParameters, {'next': 'native', 'app_challenge': p.challenge, 'app_challenge_method': 'S256', 'app_redirect': nativeRedirectUri});
    });

    test('redeems the code with the verifier and returns a session', () async {
      final pkce = Pkce.generate();
      late Map<String, dynamic> redeemed;
      final auth = AuthService(
        authenticate: ({required url, required callbackUrlScheme}) async {
          expect(callbackUrlScheme, 'org.eduos.app');
          expect(Uri.parse(url).queryParameters['app_challenge'], pkce.challenge);
          return 'org.eduos.app:/oauth2redirect?code=handoff-123';
        },
        httpClient: MockClient((r) async {
          expect(r.url.toString(), 'https://eduos.example.test/auth/native/token');
          redeemed = jsonDecode(r.body) as Map<String, dynamic>;
          return http.Response(jsonEncode({'tokenType': 'Bearer', 'sessionToken': 'S', 'csrfToken': 'C', 'expiresAt': '2030-01-01T00:00:00Z', 'role': 'parent'}), 200);
        }),
      );
      final s = await auth.signIn(server, pkce: pkce);
      expect(redeemed, {'code': 'handoff-123', 'code_verifier': pkce.verifier});
      expect([s.token, s.csrfToken, s.serverUrl], ['S', 'C', server]);
    });

    test('explains failures and recognises cancellation', () async {
      Future<SignInException> fail(AuthService a) async {
        try {
          await a.signIn(server);
        } on SignInException catch (e) {
          return e;
        }
        throw StateError('expected failure');
      }

      final cancelled = await fail(AuthService(authenticate: ({required url, required callbackUrlScheme}) async => throw PlatformException(code: 'CANCELED')));
      expect(cancelled.cancelled, isTrue);
      final noCode = await fail(AuthService(authenticate: ({required url, required callbackUrlScheme}) async => 'org.eduos.app:/oauth2redirect'));
      expect(noCode.message, contains('sign-in code'));
      final expired = await fail(AuthService(
        authenticate: ({required url, required callbackUrlScheme}) async => 'org.eduos.app:/oauth2redirect?code=x',
        httpClient: MockClient((_) async => http.Response('{"error":"invalid_grant"}', 400)),
      ));
      expect(expired.message, contains('expired'));
    });
  });

  group('Server address', () {
    test('defaults to https, keeps only scheme, host and port', () {
      expect(AppController.parseServerUrl('eduos.district.org').toString(), 'https://eduos.district.org');
      expect(AppController.parseServerUrl(' https://eduos.district.org/app/#/x ').toString(), 'https://eduos.district.org');
      expect(AppController.parseServerUrl('https://eduos.district.org:8443').toString(), 'https://eduos.district.org:8443');
    });
    test('refuses plain http to real hosts and nonsense', () {
      expect(() => AppController.parseServerUrl('http://eduos.district.org'), throwsFormatException);
      expect(() => AppController.parseServerUrl(''), throwsFormatException);
      expect(() => AppController.parseServerUrl('ftp://x.org'), throwsFormatException);
    });
  });
}

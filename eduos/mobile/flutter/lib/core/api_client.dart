import 'dart:async';
import 'dart:convert';
import 'dart:io' show SocketException;
import 'dart:math';

import 'package:http/http.dart' as http;

import 'offline_queue.dart';
import 'session.dart';

class ApiException implements Exception {
  const ApiException(this.status, [this.error]);

  /// HTTP status; 0 when the server couldn't be reached.
  final int status;

  /// The server's machine-readable error code ({"error": "..."}), if any.
  final String? error;

  bool get isUnauthorized => status == 401;
  bool get isOffline => status == 0;

  @override
  String toString() => 'ApiException($status${error == null ? '' : ', $error'})';
}

/// Result of a write: either the server's JSON, or "kept on this phone".
class WriteResult {
  const WriteResult(this.json, {this.queued = false});
  final Map<String, Object?>? json;
  final bool queued;
  Object? get data => json?['data'];
}

/// EduOS API client for the native app. Authenticates with the session token
/// as "Authorization: Bearer" (never a cookie), sends the session's CSRF token
/// on every write exactly like the web app, and routes the small offline
/// allowlist through [OfflineQueue] when the network or server is down.
class ApiClient {
  ApiClient({
    required Session Function() session,
    required this.queue,
    http.Client? httpClient,
    this.onUnauthorized,
    this.onCsrfRefreshed,
    this.timeout = const Duration(seconds: 20),
    Random? random,
    DateTime Function()? clock,
  })  : _session = session,
        _http = httpClient ?? http.Client(),
        _random = random ?? Random.secure(),
        _clock = clock ?? DateTime.now;

  final Session Function() _session;
  final http.Client _http;
  final OfflineQueue queue;
  final Duration timeout;
  final Random _random;
  final DateTime Function() _clock;

  /// Called when the server says the session is gone (expired, revoked, idle).
  final void Function()? onUnauthorized;

  /// Called with a fresh CSRF token after the server rejected a stale one.
  final void Function(String csrfToken)? onCsrfRefreshed;

  Uri _uri(String path) => _session().serverUrl.resolve(path);

  Map<String, String> _headers({bool write = false, String? csrf}) {
    final s = _session();
    return {
      'accept': 'application/json',
      'authorization': 'Bearer ${s.token}',
      if (write) 'content-type': 'application/json',
      if (write) 'x-csrf-token': csrf ?? s.csrfToken,
    };
  }

  Future<Map<String, Object?>> get(String path) async {
    final res = await _send(() => _http.get(_uri(path), headers: _headers()));
    return _decode(res);
  }

  /// POST. Allowlisted writes are queued instead of failing when offline.
  Future<WriteResult> post(String path, [Map<String, Object?> body = const {}]) async {
    if (!OfflineQueue.isQueueable('POST', path)) {
      return WriteResult(await _postJson(path, body));
    }
    final write = QueuedWrite(path: path, body: body, idempotencyKey: _idempotencyKey(), queuedAt: _clock());
    try {
      final res = await _sendRaw(() => _http.post(_uri(path), headers: _replayHeaders(write), body: jsonEncode(body)));
      if (const {502, 503, 504}.contains(res.statusCode)) {
        await queue.enqueue(write);
        return const WriteResult(null, queued: true);
      }
      return WriteResult(_decode(res));
    } on ApiException catch (e) {
      if (!e.isOffline) rethrow;
      await queue.enqueue(write);
      return const WriteResult(null, queued: true);
    }
  }

  /// Sends queued writes now (call when the app resumes or the network returns).
  Future<FlushResult> flushQueue() => queue.flush((write) async {
        try {
          final res = await _sendRaw(() => _http.post(_uri(write.path), headers: _replayHeaders(write), body: jsonEncode(write.body)));
          final code = res.statusCode;
          if (code >= 200 && code < 300) return ReplayOutcome.done;
          if (code == 401) {
            onUnauthorized?.call();
            return ReplayOutcome.retryLater;
          }
          if (code == 403 && _errorCode(res) == 'csrf_validation_failed') {
            await refreshCsrf();
            return ReplayOutcome.retryLater;
          }
          if (code == 429 || code >= 500) return ReplayOutcome.retryLater;
          return ReplayOutcome.rejected; // e.g. 409 queued_write_too_old, 400, 403, 404
        } on ApiException {
          return ReplayOutcome.retryLater;
        }
      });

  Future<String> refreshCsrf() async {
    final json = await get('/api/csrf');
    final token = json['csrfToken'];
    if (token is! String) throw const ApiException(500, 'invalid_csrf_response');
    onCsrfRefreshed?.call(token);
    return token;
  }

  Future<Map<String, Object?>> _postJson(String path, Map<String, Object?> body) async {
    var res = await _send(() => _http.post(_uri(path), headers: _headers(write: true), body: jsonEncode(body)));
    if (res.statusCode == 403 && _errorCode(res) == 'csrf_validation_failed') {
      final fresh = await refreshCsrf();
      res = await _send(() => _http.post(_uri(path), headers: _headers(write: true, csrf: fresh), body: jsonEncode(body)));
    }
    return _decode(res);
  }

  Map<String, String> _replayHeaders(QueuedWrite write) => {
        ..._headers(write: true),
        'idempotency-key': write.idempotencyKey,
        'x-eduos-queued-at': write.queuedAt.toUtc().toIso8601String(),
      };

  String _idempotencyKey() => List.generate(16, (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();

  Future<http.Response> _sendRaw(Future<http.Response> Function() request) async {
    try {
      return await request().timeout(timeout);
    } on SocketException {
      throw const ApiException(0, 'offline');
    } on TimeoutException {
      throw const ApiException(0, 'timeout');
    } on http.ClientException {
      throw const ApiException(0, 'offline');
    }
  }

  Future<http.Response> _send(Future<http.Response> Function() request) async {
    final res = await _sendRaw(request);
    if (res.statusCode == 401) {
      onUnauthorized?.call();
      throw ApiException(401, _errorCode(res));
    }
    return res;
  }

  Map<String, Object?> _decode(http.Response res) {
    if (res.statusCode == 401) {
      onUnauthorized?.call();
      throw ApiException(401, _errorCode(res));
    }
    if (res.statusCode < 200 || res.statusCode >= 300) throw ApiException(res.statusCode, _errorCode(res));
    if (res.body.isEmpty) return const {};
    final json = jsonDecode(utf8.decode(res.bodyBytes));
    return json is Map<String, Object?> ? json : {'data': json};
  }

  String? _errorCode(http.Response res) {
    try {
      final json = jsonDecode(res.body);
      return json is Map && json['error'] is String ? json['error'] as String : null;
    } on FormatException {
      return null;
    }
  }

  void close() => _http.close();
}

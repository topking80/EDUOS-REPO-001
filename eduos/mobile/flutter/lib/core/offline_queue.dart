import 'dart:convert';

import 'key_value_store.dart';

/// One write kept on the phone while offline. It is re-sent later with the
/// same Idempotency-Key and original X-EduOS-Queued-At, so the server applies
/// it at most once and judges it by when it actually happened.
class QueuedWrite {
  const QueuedWrite({required this.path, required this.body, required this.idempotencyKey, required this.queuedAt});

  final String path;
  final Map<String, Object?> body;
  final String idempotencyKey;
  final DateTime queuedAt;

  Map<String, Object?> toJson() => {
        'path': path,
        'body': body,
        'idempotencyKey': idempotencyKey,
        'queuedAt': queuedAt.toUtc().toIso8601String(),
      };

  static QueuedWrite? fromJson(Object? json) {
    if (json is! Map) return null;
    final path = json['path'], key = json['idempotencyKey'], body = json['body'];
    final at = DateTime.tryParse('${json['queuedAt']}');
    if (path is! String || key is! String || body is! Map || at == null) return null;
    return QueuedWrite(path: path, body: Map<String, Object?>.from(body), idempotencyKey: key, queuedAt: at);
  }
}

class OfflineQueueFullException implements Exception {
  const OfflineQueueFullException();
  @override
  String toString() => 'The offline queue is full';
}

/// Outcome of sending one queued write.
enum ReplayOutcome {
  /// Accepted (or a duplicate the server had already applied): remove it.
  done,

  /// Refused for good (expired, invalid, forbidden): remove it.
  rejected,

  /// Still offline, server busy, or signed out: keep it and stop for now.
  retryLater,
}

class FlushResult {
  const FlushResult({required this.sent, required this.rejected, required this.remaining});
  final int sent;
  final int rejected;
  final int remaining;
}

/// Durable queue for the SAME small allowlist of writes as the web app:
/// safety roll call, bus check-ins and attendance marks. Everything else
/// (for example releasing a child at pick-up) is online-only, because
/// identity has to be checked live. The queue lives in the platform
/// keystore-backed store, keeps entries for at most 24 hours (the server's
/// replay window), holds at most 200, and is wiped on sign-out.
class OfflineQueue {
  OfflineQueue(this._store, {DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  static const storageKey = 'eduos.offlineQueue';
  static const maxEntries = 200;
  static const maxAge = Duration(hours: 24);
  static final List<RegExp> queueablePaths = [
    RegExp(r'^/api/safety/incidents/[0-9a-f-]{36}/rollcall$'),
    RegExp(r'^/api/transport/runs/[0-9a-f-]{36}/checkins$'),
    RegExp(r'^/api/attendance$'),
  ];

  final KeyValueStore _store;
  final DateTime Function() _clock;
  bool _flushing = false;

  static bool isQueueable(String method, String path) =>
      method == 'POST' && queueablePaths.any((r) => r.hasMatch(path));

  Future<List<QueuedWrite>> entries() async {
    final raw = await _store.read(storageKey);
    if (raw == null) return [];
    try {
      final list = jsonDecode(raw);
      if (list is! List) return [];
      final cutoff = _clock().subtract(maxAge);
      return list.map(QueuedWrite.fromJson).whereType<QueuedWrite>().where((e) => e.queuedAt.isAfter(cutoff)).toList();
    } on FormatException {
      return [];
    }
  }

  Future<int> get length async => (await entries()).length;

  Future<void> enqueue(QueuedWrite write) async {
    if (!isQueueable('POST', write.path)) throw ArgumentError('Not an offline-queueable write: ${write.path}');
    final list = await entries();
    if (list.length >= maxEntries) throw const OfflineQueueFullException();
    await _save([...list, write]);
  }

  Future<void> clear() => _store.delete(storageKey);

  /// Sends queued writes oldest-first with [send]. Stops at the first write
  /// that can't be sent yet, so order is kept.
  Future<FlushResult> flush(Future<ReplayOutcome> Function(QueuedWrite write) send) async {
    if (_flushing) return FlushResult(sent: 0, rejected: 0, remaining: await length);
    _flushing = true;
    try {
      var sent = 0, rejected = 0;
      while (true) {
        // Re-read each time: a write may be queued while we're sending.
        final pending = await entries();
        if (pending.isEmpty) break;
        final next = pending.first;
        final outcome = await send(next);
        if (outcome == ReplayOutcome.retryLater) break;
        await _remove(next.idempotencyKey);
        if (outcome == ReplayOutcome.done) {
          sent++;
        } else {
          rejected++;
        }
      }
      final remaining = await entries();
      if (remaining.isEmpty) await clear();
      return FlushResult(sent: sent, rejected: rejected, remaining: remaining.length);
    } finally {
      _flushing = false;
    }
  }

  Future<void> _remove(String idempotencyKey) async =>
      _save((await entries()).where((e) => e.idempotencyKey != idempotencyKey).toList());

  Future<void> _save(List<QueuedWrite> list) => _store.write(storageKey, jsonEncode(list.map((e) => e.toJson()).toList()));
}

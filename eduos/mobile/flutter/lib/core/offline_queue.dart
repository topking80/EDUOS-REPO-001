import 'dart:convert';

import 'key_value_store.dart';

/// Who a queued write belongs to: the server, user, district and membership
/// (role and school) it was made under. (user, district, school, role) is
/// exactly what identifies a membership: db/009 makes it unique with
/// UNIQUE NULLS NOT DISTINCT, so no two memberships share an owner key
/// (test/offline-queue-owner-key.test.js keeps the two in step). A write is only ever replayed under
/// exactly the same identity, so an expired session, a different account, a
/// membership switch or a new server can never send someone else's attendance
/// or check-ins under their own name.
class QueueOwner {
  const QueueOwner({required this.server, required this.userId, required this.districtId, required this.role, this.schoolId});

  final String server, userId, districtId, role;
  final String? schoolId;

  String get key => [server, userId, districtId, role, schoolId ?? '-'].join('|');

  Map<String, Object?> toJson() => {'server': server, 'userId': userId, 'districtId': districtId, 'role': role, 'schoolId': schoolId};

  static QueueOwner? fromJson(Object? json) {
    if (json is! Map) return null;
    final server = json['server'], user = json['userId'], district = json['districtId'], role = json['role'], school = json['schoolId'];
    if (server is! String || user is! String || district is! String || role is! String || (school != null && school is! String)) return null;
    return QueueOwner(server: server, userId: user, districtId: district, role: role, schoolId: school as String?);
  }

  @override
  bool operator ==(Object other) => other is QueueOwner && other.key == key;

  @override
  int get hashCode => key.hashCode;
}

/// One write kept on the phone while offline. It is re-sent later with the
/// same Idempotency-Key and original X-EduOS-Queued-At, so the server applies
/// it at most once and judges it by when it actually happened.
class QueuedWrite {
  const QueuedWrite({required this.path, required this.body, required this.idempotencyKey, required this.queuedAt, this.owner});

  final String path;
  final Map<String, Object?> body;
  final String idempotencyKey;
  final DateTime queuedAt;

  /// null only for entries saved by an older app version: those are never
  /// replayed (we can't tell whose they are) and expire with the 24-hour window.
  final QueueOwner? owner;

  Map<String, Object?> toJson() => {
        'path': path,
        'body': body,
        'idempotencyKey': idempotencyKey,
        'queuedAt': queuedAt.toUtc().toIso8601String(),
        if (owner != null) 'owner': owner!.toJson(),
      };

  static QueuedWrite? fromJson(Object? json) {
    if (json is! Map) return null;
    final path = json['path'], key = json['idempotencyKey'], body = json['body'];
    final at = DateTime.tryParse('${json['queuedAt']}');
    if (path is! String || key is! String || body is! Map || at == null) return null;
    return QueuedWrite(path: path, body: Map<String, Object?>.from(body), idempotencyKey: key, queuedAt: at, owner: QueueOwner.fromJson(json['owner']));
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
  const FlushResult({required this.sent, required this.rejected, required this.remaining, this.held = 0});
  final int sent;
  final int rejected;

  /// Still waiting to be sent by the current identity.
  final int remaining;

  /// Saved under a different identity (another account, membership or server):
  /// kept, never sent from this one, deleted after 24 hours or on sign-out.
  final int held;
}

/// Durable queue for the SAME small allowlist of writes as the web app:
/// safety roll call, bus check-ins and attendance marks. Everything else
/// (for example releasing a child at pick-up) is online-only, because
/// identity has to be checked live. The queue lives in the platform
/// keystore-backed store, keeps entries for at most 24 hours (the server's
/// replay window), holds at most 200, and is wiped on sign-out. Every entry
/// is bound to its [QueueOwner] and only replayed under that same identity.
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

  /// Entries [owner] may send.
  Future<int> lengthFor(QueueOwner? owner) async => owner == null ? 0 : (await entries()).where((e) => e.owner == owner).length;

  Future<void> enqueue(QueuedWrite write) async {
    if (!isQueueable('POST', write.path)) throw ArgumentError('Not an offline-queueable write: ${write.path}');
    if (write.owner == null) throw ArgumentError('A queued write must record whose it is');
    final list = await entries();
    if (list.length >= maxEntries) throw const OfflineQueueFullException();
    await _save([...list, write]);
  }

  Future<void> clear() => _store.delete(storageKey);

  /// Sends [owner]'s queued writes oldest-first with [send]. Stops at the
  /// first write that can't be sent yet, so order is kept. Writes saved under
  /// any other identity are left untouched and never sent.
  Future<FlushResult> flush(QueueOwner? owner, Future<ReplayOutcome> Function(QueuedWrite write) send) async {
    Future<FlushResult> idle() async {
      final all = await entries();
      final mine = owner == null ? 0 : all.where((e) => e.owner == owner).length;
      return FlushResult(sent: 0, rejected: 0, remaining: mine, held: all.length - mine);
    }

    if (_flushing || owner == null) return idle();
    _flushing = true;
    try {
      var sent = 0, rejected = 0;
      while (true) {
        // Re-read each time: a write may be queued while we're sending.
        final pending = (await entries()).where((e) => e.owner == owner).toList();
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
      final all = await entries();
      if (all.isEmpty) await clear();
      final mine = all.where((e) => e.owner == owner).length;
      return FlushResult(sent: sent, rejected: rejected, remaining: mine, held: all.length - mine);
    } finally {
      _flushing = false;
    }
  }

  Future<void> _remove(String idempotencyKey) async =>
      _save((await entries()).where((e) => e.idempotencyKey != idempotencyKey).toList());

  Future<void> _save(List<QueuedWrite> list) => _store.write(storageKey, jsonEncode(list.map((e) => e.toJson()).toList()));
}

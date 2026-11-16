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
///
/// Performance: the keystore is read once and then kept in memory (this
/// queue is its only writer), so queueing a mark is one keystore write and
/// sending 200 marks is a few dozen, not a full re-read and re-write per mark.
/// Marks for different students are sent [concurrency] at a time; marks for
/// the same student (or the same roll call) stay strictly in order. The server
/// judges every replay by when it happened (X-EduOS-Queued-At), so sending
/// different students' marks side by side changes nothing.
class OfflineQueue {
  OfflineQueue(this._store, {DateTime Function()? clock, this.concurrency = 4}) : _clock = clock ?? DateTime.now;

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

  /// How many queued writes for different subjects are sent at once.
  final int concurrency;
  bool _flushing = false;
  List<QueuedWrite>? _cache;
  Future<List<QueuedWrite>>? _loading;

  static bool isQueueable(String method, String path) =>
      method == 'POST' && queueablePaths.any((r) => r.hasMatch(path));

  /// What a write is about: writes with the same subject are never sent side
  /// by side or out of order (a bus rider's "boarded" before "dropped off").
  static String subjectOf(QueuedWrite w) {
    final student = w.body['studentId'];
    return student is String ? '${w.path}#$student' : w.path;
  }

  Future<List<QueuedWrite>> _all() async {
    final cached = _cache;
    if (cached != null) return cached;
    return _loading ??= () async {
      final raw = await _store.read(storageKey);
      var list = <QueuedWrite>[];
      if (raw != null) {
        try {
          final json = jsonDecode(raw);
          if (json is List) list = json.map(QueuedWrite.fromJson).whereType<QueuedWrite>().toList();
        } on FormatException {
          list = [];
        }
      }
      _cache = list;
      _loading = null;
      return list;
    }();
  }

  /// Unexpired entries, oldest first.
  Future<List<QueuedWrite>> entries() async {
    final cutoff = _clock().subtract(maxAge);
    return (await _all()).where((e) => e.queuedAt.isAfter(cutoff)).toList();
  }

  Future<int> get length async => (await entries()).length;

  /// Entries [owner] may send.
  Future<int> lengthFor(QueueOwner? owner) async => owner == null ? 0 : (await entries()).where((e) => e.owner == owner).length;

  /// (all unexpired entries, the ones [owner] may send) from one read.
  Future<(int, int)> counts(QueueOwner? owner) async {
    final all = await entries();
    return (all.length, owner == null ? 0 : all.where((e) => e.owner == owner).length);
  }

  /// Keeps [write]. A write identical to the last one queued for the same
  /// subject (a repeated tap while offline) is not kept twice.
  Future<void> enqueue(QueuedWrite write) async {
    if (!isQueueable('POST', write.path)) throw ArgumentError('Not an offline-queueable write: ${write.path}');
    if (write.owner == null) throw ArgumentError('A queued write must record whose it is');
    final list = await entries();
    final subject = subjectOf(write);
    final last = list.lastWhereOrNull((e) => e.owner == write.owner && subjectOf(e) == subject);
    if (last != null && jsonEncode(last.body) == jsonEncode(write.body)) return;
    if (list.length >= maxEntries) throw const OfflineQueueFullException();
    await _save([...list, write]);
  }

  Future<void> clear() async {
    _cache = <QueuedWrite>[];
    await _store.delete(storageKey);
  }

  /// Sends [owner]'s queued writes with [send], oldest first, up to
  /// [concurrency] at a time for different subjects. A write that can't be
  /// sent yet stays, with every later write for the same subject; the flush
  /// stops after that round. Writes saved under any other identity are left
  /// untouched and never sent.
  Future<FlushResult> flush(QueueOwner? owner, Future<ReplayOutcome> Function(QueuedWrite write) send) async {
    Future<FlushResult> idle() async {
      final (all, mine) = await counts(owner);
      return FlushResult(sent: 0, rejected: 0, remaining: mine, held: all - mine);
    }

    if (_flushing || owner == null) return idle();
    _flushing = true;
    try {
      var sent = 0, rejected = 0;
      while (true) {
        // Re-read each round (from memory): a write may be queued while we're sending.
        final pending = (await entries()).where((e) => e.owner == owner).toList();
        if (pending.isEmpty) break;
        final round = <QueuedWrite>[];
        final subjects = <String>{};
        for (final w in pending) {
          final subject = subjectOf(w);
          // Only the oldest write of each subject may go; later ones wait.
          if (!subjects.add(subject)) continue;
          round.add(w);
          if (round.length >= concurrency) break;
        }
        final outcomes = await Future.wait(round.map(send));
        final finished = <String>{};
        var stop = false;
        for (var i = 0; i < round.length; i++) {
          switch (outcomes[i]) {
            case ReplayOutcome.done:
              sent++;
              finished.add(round[i].idempotencyKey);
            case ReplayOutcome.rejected:
              rejected++;
              finished.add(round[i].idempotencyKey);
            case ReplayOutcome.retryLater:
              stop = true;
          }
        }
        if (finished.isNotEmpty) await _save((await _all()).where((e) => !finished.contains(e.idempotencyKey)).toList());
        if (stop) break;
      }
      final (all, mine) = await counts(owner);
      return FlushResult(sent: sent, rejected: rejected, remaining: mine, held: all - mine);
    } finally {
      _flushing = false;
    }
  }

  /// Saves [list] without expired entries.
  Future<void> _save(List<QueuedWrite> list) async {
    final cutoff = _clock().subtract(maxAge);
    final kept = list.where((e) => e.queuedAt.isAfter(cutoff)).toList();
    _cache = kept;
    if (kept.isEmpty) return _store.delete(storageKey);
    await _store.write(storageKey, jsonEncode(kept.map((e) => e.toJson()).toList()));
  }
}

extension<T> on List<T> {
  T? lastWhereOrNull(bool Function(T) test) {
    for (var i = length - 1; i >= 0; i--) {
      if (test(this[i])) return this[i];
    }
    return null;
  }
}

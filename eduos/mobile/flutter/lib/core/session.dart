import 'dart:convert';

import 'key_value_store.dart';

/// A signed-in EduOS session, as returned by POST /auth/native/token (phones)
/// or POST /auth/device/token (TVs and Windows, device sign-in).
/// The token is a normal server session (same expiry, idle timeout and
/// revocation as a browser sign-in); it is only ever kept in secure storage.
class Session {
  const Session({required this.serverUrl, required this.token, required this.csrfToken, required this.expiresAt, this.clientKind, this.readOnly = false});

  final Uri serverUrl;
  final String token;
  final String csrfToken;
  final DateTime expiresAt;

  /// Set for device sign-in sessions: android_tv, fire_tv, roku or windows.
  final String? clientKind;

  /// TV sessions can't change anything (the server refuses writes).
  final bool readOnly;

  bool get isExpired => !DateTime.now().isBefore(expiresAt);

  Session copyWith({String? token, String? csrfToken, DateTime? expiresAt}) => Session(
        serverUrl: serverUrl,
        token: token ?? this.token,
        csrfToken: csrfToken ?? this.csrfToken,
        expiresAt: expiresAt ?? this.expiresAt,
        clientKind: clientKind,
        readOnly: readOnly,
      );

  Map<String, Object> toJson() => {
        'serverUrl': serverUrl.toString(),
        'token': token,
        'csrfToken': csrfToken,
        'expiresAt': expiresAt.toUtc().toIso8601String(),
        if (clientKind != null) 'clientKind': clientKind!,
        if (readOnly) 'readOnly': true,
      };

  static Session? fromJson(Object? json) {
    if (json is! Map) return null;
    final server = Uri.tryParse('${json['serverUrl']}');
    final expires = DateTime.tryParse('${json['expiresAt']}');
    final token = json['token'], csrf = json['csrfToken'];
    if (server == null || expires == null || token is! String || csrf is! String) return null;
    return Session(
        serverUrl: server,
        token: token,
        csrfToken: csrf,
        expiresAt: expires,
        clientKind: json['clientKind'] is String ? json['clientKind'] as String : null,
        readOnly: json['readOnly'] == true);
  }
}

/// Persists the session and the chosen district server in secure storage.
class SessionStore {
  SessionStore(this._store);

  static const _sessionKey = 'eduos.session';
  static const _serverKey = 'eduos.server';

  final KeyValueStore _store;

  Future<Session?> load() async {
    final raw = await _store.read(_sessionKey);
    if (raw == null) return null;
    try {
      final session = Session.fromJson(jsonDecode(raw));
      if (session == null || session.isExpired) {
        await clear();
        return null;
      }
      return session;
    } on FormatException {
      await clear();
      return null;
    }
  }

  Future<void> save(Session session) => _store.write(_sessionKey, jsonEncode(session.toJson()));

  Future<void> clear() => _store.delete(_sessionKey);

  Future<Uri?> loadServer() async {
    final raw = await _store.read(_serverKey);
    return raw == null ? null : Uri.tryParse(raw);
  }

  Future<void> saveServer(Uri server) => _store.write(_serverKey, server.toString());
}

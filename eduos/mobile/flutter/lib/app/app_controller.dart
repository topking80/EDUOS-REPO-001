import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../core/api_client.dart';
import '../core/auth_service.dart';
import '../core/key_value_store.dart';
import '../core/models.dart';
import '../core/offline_queue.dart';
import '../core/session.dart';

enum AppStage { starting, needsServer, signedOut, offline, signedIn }

/// App-wide state: which district server, who is signed in, branding, live
/// safety incidents, unread alerts and the offline queue. Screens read it and
/// call [api]; nothing here caches school records.
class AppController extends ChangeNotifier {
  AppController({KeyValueStore? store, AuthService? auth, http.Client Function()? httpClientFactory, this.safetyPollInterval = const Duration(seconds: 30)})
      : _store = store ?? SecureKeyValueStore(),
        _auth = auth ?? AuthService(),
        _httpFactory = httpClientFactory ?? http.Client.new {
    _sessions = SessionStore(_store);
    queue = OfflineQueue(_store);
  }

  final KeyValueStore _store;
  final AuthService _auth;
  final http.Client Function() _httpFactory;
  /// How often to re-check safety status and alerts; null disables polling (tests).
  final Duration? safetyPollInterval;
  late final SessionStore _sessions;
  late final OfflineQueue queue;

  AppStage stage = AppStage.starting;
  Uri? server;
  Session? _session;
  ApiClient? _api;
  Me? me;
  Brand? brand;
  List<Incident> incidents = const [];
  int unread = 0;
  int queued = 0;
  String? notice;
  Timer? _poll;

  ApiClient get api => _api ?? (throw StateError('Not signed in'));
  List<Incident> get liveIncidents => incidents.where((i) => i.live).toList();

  Future<void> start() async {
    server = await _sessions.loadServer();
    if (server == null) return _setStage(AppStage.needsServer);
    final saved = await _sessions.load();
    if (saved == null || saved.serverUrl != server) return _setStage(AppStage.signedOut);
    _useSession(saved);
    try {
      await _loadProfile();
      _setStage(AppStage.signedIn);
      _startPolling();
    } on ApiException catch (e) {
      // Offline at launch: keep the saved session and let the user retry.
      if (e.isOffline) return _setStage(AppStage.offline);
      await _dropSession();
    }
  }

  /// Validates and remembers the district server, e.g. https://eduos.district.org.
  Future<void> setServer(String input) async {
    final uri = parseServerUrl(input);
    await _sessions.saveServer(uri);
    server = uri;
    await _dropSession();
  }

  /// Back to the server address screen (pre-filled with the current one).
  Future<void> changeServer() async {
    await queue.clear();
    await _dropSession();
    _setStage(AppStage.needsServer);
  }

  static Uri parseServerUrl(String input) {
    var text = input.trim();
    if (!text.contains('://')) text = 'https://$text';
    final uri = Uri.tryParse(text);
    if (uri == null || uri.host.isEmpty) throw const FormatException('Enter your school\'s EduOS address, for example eduos.district.org');
    final local = {'localhost', '127.0.0.1', '10.0.2.2'}.contains(uri.host);
    if (uri.scheme != 'https' && !(uri.scheme == 'http' && local && kDebugMode)) {
      throw const FormatException('The address must start with https://');
    }
    return Uri(scheme: uri.scheme, host: uri.host, port: uri.hasPort ? uri.port : null);
  }

  Future<void> signIn() async {
    final target = server;
    if (target == null) return _setStage(AppStage.needsServer);
    notice = null;
    final session = await _auth.signIn(target);
    await _sessions.save(session);
    _useSession(session);
    await _loadProfile();
    _setStage(AppStage.signedIn);
    _startPolling();
    unawaited(flushQueue());
  }

  Future<void> signOut() async {
    try {
      if (_api != null) await _api!.post('/auth/logout');
    } on ApiException {
      // Signing out locally still happens; the server session expires on its own.
    }
    await queue.clear();
    await _dropSession();
  }

  Future<List<Membership>> memberships() async =>
      objs((await api.get('/api/memberships'))['data']).map(Membership.fromJson).toList();

  Future<void> switchMembership(String membershipId) async {
    final res = await api.post('/api/session/membership', {'membershipId': membershipId});
    final json = res.json ?? const {};
    final token = json['sessionToken'], csrf = json['csrfToken'];
    final expires = DateTime.tryParse('${json['expiresAt']}');
    if (token is! String || csrf is! String || expires == null) throw const ApiException(500, 'invalid_switch_response');
    final next = _session!.copyWith(token: token, csrfToken: csrf, expiresAt: expires);
    await _sessions.save(next);
    _useSession(next);
    incidents = const [];
    await _loadProfile();
    notifyListeners();
  }

  /// Safety status + unread count. Called on a timer and when the app resumes.
  Future<void> refreshStatus() async {
    if (_api == null) return;
    try {
      final status = obj((await api.get('/api/safety/status'))['data']);
      incidents = objs(status['incidents']).map(Incident.fromJson).toList();
    } on ApiException catch (e) {
      if (e.isUnauthorized) return;
      if (e.status == 403) incidents = const [];
    }
    try {
      unread = integer(obj((await api.get('/api/notifications'))['data'])['unread']);
    } on ApiException {
      // Keep the last count.
    }
    queued = await queue.length;
    notifyListeners();
  }

  Future<FlushResult?> flushQueue() async {
    if (_api == null) return null;
    final result = await api.flushQueue();
    queued = result.remaining;
    if (result.rejected > 0) {
      notice = '${result.rejected} saved change${result.rejected == 1 ? ' was' : 's were'} refused by the school (too old or no longer valid).';
    }
    notifyListeners();
    return result;
  }

  void clearNotice() {
    notice = null;
    notifyListeners();
  }

  void markAlertsRead() {
    unread = 0;
    notifyListeners();
  }

  Future<void> _loadProfile() async {
    me = Me.fromJson(await api.get('/api/me'));
    try {
      brand = Brand.fromJson(obj((await api.get('/api/branding/current'))['data']));
    } on ApiException catch (e) {
      if (e.isUnauthorized) rethrow;
      brand = null;
    }
    await refreshStatus();
  }

  void _useSession(Session session) {
    _session = session;
    _api?.close();
    _api = ApiClient(
      session: () => _session!,
      queue: queue,
      httpClient: _httpFactory(),
      onUnauthorized: () => unawaited(_dropSession(notice: 'Your session ended. Please sign in again.')),
      onCsrfRefreshed: (csrf) {
        _session = _session!.copyWith(csrfToken: csrf);
        unawaited(_sessions.save(_session!));
      },
    );
  }

  Future<void> _dropSession({String? notice}) async {
    _poll?.cancel();
    _api?.close();
    _api = null;
    _session = null;
    me = null;
    brand = null;
    incidents = const [];
    unread = 0;
    if (notice != null) this.notice = notice;
    await _sessions.clear();
    _setStage(server == null ? AppStage.needsServer : AppStage.signedOut);
  }

  void _startPolling() {
    _poll?.cancel();
    final every = safetyPollInterval;
    if (every != null) _poll = Timer.periodic(every, (_) => unawaited(refreshStatus()));
  }

  void _setStage(AppStage next) {
    stage = next;
    notifyListeners();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _api?.close();
    super.dispose();
  }
}

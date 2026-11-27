import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../core/api_client.dart';
import '../core/auth_service.dart';
import '../core/device_profile.dart';
import '../core/device_sign_in.dart';
import '../core/key_value_store.dart';
import '../core/models.dart';
import '../core/offline_queue.dart';
import '../core/privacy_lock.dart';
import '../core/session.dart';

enum AppStage { starting, needsServer, signedOut, offline, signedIn }

/// App-wide state: which district server, who is signed in, branding, live
/// safety incidents, unread alerts and the offline queue. Screens read it and
/// call [api]; nothing here caches school records.
class AppController extends ChangeNotifier {
  AppController(
      {KeyValueStore? store,
      AuthService? auth,
      http.Client Function()? httpClientFactory,
      this.safetyPollInterval = const Duration(seconds: 30),
      DeviceProfile? device,
      DeviceSignInService? deviceSignIn})
      : _store = store ?? SecureKeyValueStore(),
        _auth = auth ?? AuthService(),
        _httpFactory = httpClientFactory ?? http.Client.new,
        _device = device,
        _deviceSignIn = deviceSignIn {
    _sessions = SessionStore(_store);
    queue = OfflineQueue(_store);
    privacy = PrivacyLock(_store);
  }

  final KeyValueStore _store;
  final AuthService _auth;
  final http.Client Function() _httpFactory;
  /// How often to re-check safety status and alerts; null disables polling (tests).
  final Duration? safetyPollInterval;
  late final SessionStore _sessions;
  late final OfflineQueue queue;

  /// The optional screen-lock PIN (shared TVs, family PCs, shared tablets).
  late final PrivacyLock privacy;

  final DeviceProfile? _device;
  DeviceSignInService? _deviceSignIn;

  /// What this screen is (phone/tablet, Windows, TV); see DeviceProfile.fromLaunch.
  DeviceProfile get device => _device ?? DeviceProfile.handheld;
  bool get isTv => device.isTv;

  /// TV sessions are view-only: the server refuses changes, so the app hides them.
  bool get readOnly => _session?.readOnly ?? false;

  /// This session came from device sign-in (a TV or Windows), so it can't approve other screens.
  bool get isDeviceSession => _session?.clientKind != null;

  /// The screen lock is showing (PIN set and idle too long, or the app went to the background).
  bool locked = false;
  Timer? _idle;
  DateTime _lastActivityReset = DateTime.fromMillisecondsSinceEpoch(0);

  AppStage stage = AppStage.starting;
  Uri? server;
  Session? _session;
  ApiClient? _api;
  Me? me;
  Brand? brand;
  List<Incident> incidents = const [];

  /// From /api/safety/status: may this person start alerts / lead incidents.
  bool canInitiateSafety = false;
  bool canLeadSafety = false;
  int unread = 0;
  int queued = 0;

  /// Offline writes saved on this phone by a different account, membership or
  /// server. Never sent from this session.
  int heldForOthers = 0;
  String? notice;
  Timer? _poll;

  ApiClient get api => _api ?? (throw StateError('Not signed in'));

  /// The identity offline writes are saved under: server, user, district and
  /// membership. null until the profile has loaded (nothing is queued then).
  QueueOwner? get queueOwner {
    final s = _session, m = me;
    if (s == null || m == null || m.userId.isEmpty) return null;
    return QueueOwner(server: s.serverUrl.origin, userId: m.userId, districtId: m.districtId, role: m.role, schoolId: m.schoolId);
  }

  Future<void> _countQueue() async {
    final (all, mine) = await queue.counts(queueOwner);
    queued = mine;
    heldForOthers = all - mine;
  }
  List<Incident> get liveIncidents => incidents.where((i) => i.live).toList();

  Future<void> start() async {
    await privacy.load();
    server = await _sessions.loadServer();
    if (server == null) return _setStage(AppStage.needsServer);
    final saved = await _sessions.load();
    if (saved == null || saved.serverUrl != server) return _setStage(AppStage.signedOut);
    _useSession(saved);
    try {
      await _loadProfile();
      // Reopening the app on a shared screen asks for the PIN first.
      locked = privacy.hasPin;
      _setStage(AppStage.signedIn);
      _startPolling();
      _restartIdle();
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

  // ---- Device sign-in (TVs and Windows; RFC 8628) ----

  DeviceSignInService get _devices => _deviceSignIn ??= DeviceSignInService(httpClient: _httpFactory());

  /// Asks the server for a code to show on this screen.
  Future<DeviceCode> startDeviceSignIn() async {
    final target = server;
    final kind = device.clientKind;
    if (target == null || kind == null) throw const DeviceSignInException('This screen signs in with your school account instead.');
    notice = null;
    return _devices.start(target, clientKind: kind, label: device.label);
  }

  /// One poll; on approval the screen is signed in.
  Future<DevicePoll> pollDeviceSignIn(DeviceCode code) async {
    final target = server;
    if (target == null) return const DevicePoll(DevicePollState.failed);
    final result = await _devices.poll(target, code);
    final session = result.session;
    if (result.state == DevicePollState.signedIn && session != null) {
      await _sessions.save(session);
      _useSession(session);
      await _loadProfile();
      _setStage(AppStage.signedIn);
      _startPolling();
      _restartIdle();
    }
    return result;
  }

  /// Approving side (this phone or tablet is signed in): what is asking for [userCode].
  Future<DeviceRequest> checkDevice(String userCode) async =>
      DeviceRequest.fromJson(obj((await api.post('/api/device-sign-in/check', {'userCode': userCode})).data));

  Future<void> approveDevice(String userCode) => api.post('/api/device-sign-in/approve', {'userCode': userCode});

  Future<void> denyDevice(String userCode) => api.post('/api/device-sign-in/deny', {'userCode': userCode});

  // ---- Screen lock ----

  /// Any tap, click or key press: pushes the auto-lock back.
  void noteActivity() {
    if (!privacy.hasPin || locked || stage != AppStage.signedIn) return;
    final now = DateTime.now();
    if (now.difference(_lastActivityReset) < const Duration(seconds: 1)) return;
    _lastActivityReset = now;
    _restartIdle();
  }

  void _restartIdle() {
    _idle?.cancel();
    _idle = null;
    if (!privacy.hasPin || locked || stage != AppStage.signedIn) return;
    _idle = Timer(privacy.autoLockAfter, lock);
  }

  /// Locks now (idle timeout, app sent to the background, or "Lock now").
  void lock() {
    _idle?.cancel();
    if (!privacy.hasPin || stage != AppStage.signedIn || locked) return;
    locked = true;
    notifyListeners();
  }

  /// The app went to the background (or the TV's home button was pressed).
  void onBackgrounded() => lock();

  bool unlock(String pin) {
    if (!privacy.verify(pin)) return false;
    locked = false;
    _restartIdle();
    notifyListeners();
    return true;
  }

  Future<void> setPin(String pin) async {
    await privacy.setPin(pin);
    _restartIdle();
    notifyListeners();
  }

  Future<void> removePin() async {
    await privacy.clear();
    locked = false;
    _restartIdle();
    notifyListeners();
  }

  Future<void> setAutoLockMinutes(int minutes) async {
    await privacy.setAutoLockMinutes(minutes);
    _restartIdle();
    notifyListeners();
  }

  Future<List<Membership>> memberships() async =>
      objs((await api.get('/api/memberships'))['data']).map(Membership.fromJson).toList();

  /// Every profile this person can switch to (loaded with the profile; empty if unavailable).
  List<Membership> profiles = const [];

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

  /// What the last refresh showed; screens are only rebuilt when it changes.
  String _statusSignature = '';

  /// Safety status + unread count. Called on a timer and when the app resumes.
  /// The two requests go out together, the unread count asks for the count
  /// only (not the latest 50 notifications), and listeners are notified only
  /// when something they show has changed.
  Future<void> refreshStatus() async {
    if (_api == null) return;
    final client = api;
    final (statusJson, unreadJson) = await (
      _attempt(() => client.get('/api/safety/status')),
      _attempt(() => client.get('/api/notifications?summary=1')),
    ).wait;
    final statusError = statusJson.$2;
    if (statusError != null && statusError.isUnauthorized) return;
    if (statusJson.$1 != null) {
      final status = obj(statusJson.$1!['data']);
      incidents = objs(status['incidents']).map(Incident.fromJson).toList();
      canInitiateSafety = boolean(status['canInitiate']);
      canLeadSafety = boolean(status['canLead']);
    } else if (statusError?.status == 403) {
      incidents = const [];
    }
    // On an error keep the last unread count.
    if (unreadJson.$1 != null) unread = integer(obj(unreadJson.$1!['data'])['unread']);
    await _countQueue();
    final signature = jsonEncode([statusJson.$1?['data'], statusError?.status == 403, unread, queued, heldForOthers]);
    if (signature == _statusSignature) return;
    _statusSignature = signature;
    notifyListeners();
  }

  static Future<(Map<String, Object?>?, ApiException?)> _attempt(Future<Map<String, Object?>> Function() call) async {
    try {
      return (await call(), null);
    } on ApiException catch (e) {
      return (null, e);
    }
  }

  Future<FlushResult?> flushQueue() async {
    if (_api == null) return null;
    final result = await api.flushQueue();
    queued = result.remaining;
    heldForOthers = result.held;
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

  /// Saves the person's display settings and applies them straight away.
  Future<void> saveDisplay(DisplayPrefs d) async {
    final r = await api.put('/api/me/preferences', d.toJson());
    final saved = DisplayPrefs.fromJson(obj(r['data']));
    brand = (brand ?? const Brand()).withDisplay(saved);
    notifyListeners();
  }

  /// The profile, branding, the person's other profiles, safety status and
  /// unread count, requested together (one round trip in sequence).
  Future<void> _loadProfile() async {
    final client = api;
    final (profile, branding, _, mems) = await (
      client.get('/api/me'),
      _attempt(() => client.get('/api/branding/current')),
      refreshStatus(),
      _attempt(() => client.get('/api/memberships')),
    ).wait.onError<
        ParallelWaitError<(Map<String, Object?>, (Map<String, Object?>?, ApiException?), void, (Map<String, Object?>?, ApiException?)),
            (AsyncError?, AsyncError?, AsyncError?, AsyncError?)>>((e, _) => throw e.errors.$1?.error ?? e.errors.$3?.error ?? e);
    me = Me.fromJson(profile);
    final brandError = branding.$2;
    if (brandError != null && brandError.isUnauthorized) throw brandError;
    brand = branding.$1 == null ? null : Brand.fromJson(obj(branding.$1!['data']));
    profiles = mems.$1 == null ? const [] : objs(mems.$1!['data']).map(Membership.fromJson).toList();
    // The queue counts depend on who signed in (now known).
    await _countQueue();
    _statusSignature = '';
  }

  void _useSession(Session session) {
    _session = session;
    _api?.close();
    _api = ApiClient(
      session: () => _session!,
      queue: queue,
      owner: () => queueOwner,
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
    _idle?.cancel();
    // The PIN belongs to whoever was signed in; the next person sets their own.
    locked = false;
    if (privacy.hasPin) await privacy.clear();
    _api?.close();
    _api = null;
    _session = null;
    me = null;
    brand = null;
    profiles = const [];
    incidents = const [];
    canInitiateSafety = false;
    canLeadSafety = false;
    unread = 0;
    queued = 0;
    heldForOthers = 0;
    _statusSignature = '';
    if (notice != null) this.notice = notice;
    await _sessions.clear();
    _setStage(server == null ? AppStage.needsServer : AppStage.signedOut);
  }

  void _startPolling() {
    _poll?.cancel();
    final every = safetyPollInterval;
    if (every != null) _poll = Timer.periodic(every, (_) => unawaited(_tick()));
  }

  /// Periodic: refresh safety/alerts and, if anything is saved on the phone,
  /// try to send it (signal often returns without the app being reopened).
  Future<void> _tick() async {
    await refreshStatus();
    if (queued > 0) await flushQueue();
  }

  void _setStage(AppStage next) {
    stage = next;
    notifyListeners();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _idle?.cancel();
    _api?.close();
    super.dispose();
  }
}

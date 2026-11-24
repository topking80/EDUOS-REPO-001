import 'dart:convert';

import 'package:http/http.dart' as http;

import 'session.dart';

/// A code this screen shows while someone approves it (RFC 8628).
class DeviceCode {
  const DeviceCode({
    required this.deviceCode,
    required this.userCode,
    required this.verificationUri,
    required this.verificationUriComplete,
    required this.qrRows,
    required this.expiresAt,
    required this.interval,
  });

  final String deviceCode;
  final String userCode;
  final Uri verificationUri;
  final Uri verificationUriComplete;

  /// QR modules of [verificationUriComplete] ("0"/"1" rows) drawn by QrMatrix.
  final List<String> qrRows;
  final DateTime expiresAt;
  final Duration interval;

  bool get isExpired => !DateTime.now().isBefore(expiresAt);

  static DeviceCode? fromJson(Object? json) {
    if (json is! Map) return null;
    final device = json['deviceCode'], user = json['userCode'];
    final uri = Uri.tryParse('${json['verificationUri']}'), complete = Uri.tryParse('${json['verificationUriComplete']}');
    final expiresIn = json['expiresIn'], interval = json['interval'];
    if (device is! String || user is! String || uri == null || complete == null || expiresIn is! int || interval is! int) return null;
    final qr = json['qr'];
    return DeviceCode(
      deviceCode: device,
      userCode: user,
      verificationUri: uri,
      verificationUriComplete: complete,
      qrRows: qr is List ? [for (final r in qr) '$r'] : const [],
      expiresAt: DateTime.now().add(Duration(seconds: expiresIn)),
      interval: Duration(seconds: interval.clamp(1, 60)),
    );
  }
}

/// Outcome of one poll of POST /auth/device/token.
enum DevicePollState { pending, slowDown, signedIn, denied, expired, failed }

class DevicePoll {
  const DevicePoll(this.state, {this.session, this.message});
  final DevicePollState state;
  final Session? session;
  final String? message;
}

class DeviceSignInException implements Exception {
  const DeviceSignInException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// Device sign-in for TVs and Windows: the screen shows a code, a person who
/// is already signed in approves it on their phone or computer, and the
/// screen polls until it gets a session. Nothing is typed on the TV.
class DeviceSignInService {
  DeviceSignInService({http.Client? httpClient}) : _http = httpClient ?? http.Client();

  final http.Client _http;

  static const _headers = {'content-type': 'application/json', 'accept': 'application/json'};

  Future<DeviceCode> start(Uri server, {required String clientKind, String? label}) async {
    final http.Response res;
    try {
      res = await _http.post(server.resolve('/auth/device/code'),
          headers: _headers, body: jsonEncode({'clientKind': clientKind, if (label != null) 'deviceLabel': label}));
    } on Exception {
      throw const DeviceSignInException('Can\'t reach your school server. Check this screen\'s internet connection.');
    }
    final json = _decode(res.body);
    if (res.statusCode == 404) throw const DeviceSignInException('This school server doesn\'t allow TV and computer sign-in yet. Ask your district IT team.');
    if (res.statusCode == 429) throw const DeviceSignInException('Too many sign-in attempts from this network. Wait a few minutes and try again.');
    final code = res.statusCode == 200 ? DeviceCode.fromJson(json) : null;
    if (code == null) throw DeviceSignInException('Sign-in couldn\'t start (${res.statusCode}).');
    return code;
  }

  Future<DevicePoll> poll(Uri server, DeviceCode code) async {
    if (code.isExpired) return const DevicePoll(DevicePollState.expired);
    final http.Response res;
    try {
      res = await _http.post(server.resolve('/auth/device/token'), headers: _headers, body: jsonEncode({'deviceCode': code.deviceCode}));
    } on Exception {
      // Keep polling through a dropped connection; the code is still valid.
      return const DevicePoll(DevicePollState.pending);
    }
    final json = _decode(res.body);
    if (res.statusCode == 200 && json is Map) {
      final token = json['sessionToken'], csrf = json['csrfToken'];
      final expires = DateTime.tryParse('${json['expiresAt']}');
      if (token is! String || csrf is! String || expires == null) return const DevicePoll(DevicePollState.failed, message: 'Incomplete sign-in reply from the school server.');
      return DevicePoll(DevicePollState.signedIn,
          session: Session(
            serverUrl: server,
            token: token,
            csrfToken: csrf,
            expiresAt: expires,
            clientKind: json['clientKind'] is String ? json['clientKind'] as String : null,
            readOnly: json['readOnly'] == true,
          ));
    }
    final error = json is Map ? json['error'] : null;
    return switch (error) {
      'authorization_pending' => const DevicePoll(DevicePollState.pending),
      'slow_down' => const DevicePoll(DevicePollState.slowDown),
      'access_denied' => const DevicePoll(DevicePollState.denied, message: 'The sign-in was refused on the other device.'),
      'expired_token' || 'invalid_grant' => const DevicePoll(DevicePollState.expired),
      'account_not_active' => const DevicePoll(DevicePollState.failed, message: 'That EduOS account is not active. Contact your school.'),
      _ when res.statusCode == 429 => const DevicePoll(DevicePollState.slowDown),
      _ => DevicePoll(DevicePollState.failed, message: 'Sign-in failed (${res.statusCode}).'),
    };
  }

  static Object? _decode(String body) {
    try {
      return jsonDecode(body);
    } on FormatException {
      return null;
    }
  }
}

/// The approving side (a phone or browser that is signed in): what is asking.
class DeviceRequest {
  const DeviceRequest({required this.clientKind, this.deviceLabel, required this.readOnly});
  final String clientKind;
  final String? deviceLabel;
  final bool readOnly;

  static DeviceRequest fromJson(Map<String, Object?> json) => DeviceRequest(
        clientKind: '${json['clientKind'] ?? ''}',
        deviceLabel: json['deviceLabel'] is String ? json['deviceLabel'] as String : null,
        readOnly: json['readOnly'] == true,
      );

  String get kindText => switch (clientKind) {
        'android_tv' => 'Android TV / Google TV',
        'fire_tv' => 'Fire TV',
        'roku' => 'Roku',
        'windows' => 'Windows PC',
        _ => 'A screen',
      };
}

/// Codes look like BCDF-GHJK: 8 consonants, no vowels or look-alike digits.
String? normalizeUserCode(String input) {
  final code = input.toUpperCase().replaceAll(RegExp(r'[\s-]'), '');
  if (!RegExp(r'^[BCDFGHJKLMNPQRSTVWXZ]{8}$').hasMatch(code)) return null;
  return '${code.substring(0, 4)}-${code.substring(4)}';
}

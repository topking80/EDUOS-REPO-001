import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

import 'key_value_store.dart';

/// A PIN that keeps a shared screen (family TV, Windows PC, a shared tablet)
/// from showing someone's EduOS account to whoever picks up the remote.
///
/// The PIN never leaves this device. Only a salted, iterated HMAC-SHA256 of it
/// is kept, in the same secure storage as the session token. After the idle
/// time (5–30 minutes, default 10) or when the app goes to the background,
/// the app locks and asks for the PIN again. Wrong PINs lock it out for
/// longer each time. Signing out removes the PIN.
class PrivacyLock {
  PrivacyLock(this._store, {Random? random, DateTime Function()? now})
      : _random = random ?? Random.secure(),
        _now = now ?? DateTime.now;

  static const _key = 'eduos.privacy';
  static const iterations = 20000;
  static const minMinutes = 5, maxMinutes = 30, defaultMinutes = 10;
  static const freeAttempts = 5;

  final KeyValueStore _store;
  final Random _random;
  final DateTime Function() _now;

  String? _salt;
  String? _hash;

  /// Digits in the PIN (4–6), so the lock screen knows when it's complete.
  int pinLength = 4;
  int autoLockMinutes = defaultMinutes;
  int _failures = 0;
  DateTime? _blockedUntil;

  bool get hasPin => _hash != null;
  Duration get autoLockAfter => Duration(minutes: autoLockMinutes);

  /// How long until another PIN may be tried (zero when allowed now).
  Duration get waitBeforeRetry {
    final until = _blockedUntil;
    if (until == null) return Duration.zero;
    final left = until.difference(_now());
    return left.isNegative ? Duration.zero : left;
  }

  static bool validPin(String pin) => RegExp(r'^[0-9]{4,6}$').hasMatch(pin);

  Future<void> load() async {
    final raw = await _store.read(_key);
    if (raw == null) return;
    try {
      final json = jsonDecode(raw);
      if (json is! Map) return;
      final salt = json['salt'], hash = json['hash'], minutes = json['minutes'], length = json['length'];
      if (length is int) pinLength = length.clamp(4, 6);
      if (salt is String && hash is String) {
        _salt = salt;
        _hash = hash;
      }
      if (minutes is int) autoLockMinutes = minutes.clamp(minMinutes, maxMinutes);
    } on FormatException {
      await clear();
    }
  }

  Future<void> setPin(String pin) async {
    if (!validPin(pin)) throw const FormatException('Use 4 to 6 digits.');
    final saltBytes = List<int>.generate(16, (_) => _random.nextInt(256));
    _salt = base64Url.encode(saltBytes);
    _hash = hashPin(pin, _salt!);
    pinLength = pin.length;
    _failures = 0;
    _blockedUntil = null;
    await _save();
  }

  Future<void> setAutoLockMinutes(int minutes) async {
    autoLockMinutes = minutes.clamp(minMinutes, maxMinutes);
    await _save();
  }

  /// Checks a PIN. Returns false when wrong or while locked out.
  bool verify(String pin) {
    final salt = _salt, hash = _hash;
    if (salt == null || hash == null) return true;
    if (waitBeforeRetry > Duration.zero) return false;
    if (_constantTimeEquals(hashPin(pin, salt), hash)) {
      _failures = 0;
      _blockedUntil = null;
      return true;
    }
    _failures++;
    if (_failures >= freeAttempts) {
      // 30 s, then 1, 2, 4 … minutes, at most 15.
      final seconds = min(30 * (1 << (_failures - freeAttempts)), 15 * 60);
      _blockedUntil = _now().add(Duration(seconds: seconds));
    }
    return false;
  }

  Future<void> clear() async {
    _salt = null;
    _hash = null;
    _failures = 0;
    _blockedUntil = null;
    autoLockMinutes = defaultMinutes;
    pinLength = 4;
    await _store.delete(_key);
  }

  Future<void> _save() => _store.write(_key, jsonEncode({if (_salt != null) 'salt': _salt, if (_hash != null) 'hash': _hash, 'length': pinLength, 'minutes': autoLockMinutes}));

  /// Iterated HMAC-SHA256 keyed by the salt (a small PBKDF2-style stretch).
  static String hashPin(String pin, String salt, {int rounds = iterations}) {
    final mac = Hmac(sha256, utf8.encode(salt));
    final pinBytes = utf8.encode(pin);
    var digest = mac.convert(pinBytes).bytes;
    for (var i = 1; i < rounds; i++) {
      digest = mac.convert([...digest, ...pinBytes]).bytes;
    }
    return base64Url.encode(digest);
  }

  static bool _constantTimeEquals(String a, String b) {
    if (a.length != b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) {
      diff |= a.codeUnitAt(i) ^ b.codeUnitAt(i);
    }
    return diff == 0;
  }
}

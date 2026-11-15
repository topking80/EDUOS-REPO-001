import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';

/// RFC 7636 PKCE pair: the verifier stays in the app; only the S256 challenge
/// goes through the browser. The server checks sha256(verifier) == challenge
/// when the app redeems its single-use sign-in code.
class Pkce {
  Pkce._(this.verifier, this.challenge);

  factory Pkce.generate([Random? random]) {
    final rng = random ?? Random.secure();
    final bytes = List<int>.generate(48, (_) => rng.nextInt(256));
    final verifier = _base64Url(bytes);
    return Pkce._(verifier, challengeFor(verifier));
  }

  final String verifier;
  final String challenge;

  static String challengeFor(String verifier) => _base64Url(sha256.convert(ascii.encode(verifier)).bytes);

  static String _base64Url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');
}

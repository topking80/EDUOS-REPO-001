import 'dart:convert';

import 'package:flutter/services.dart' show PlatformException;
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:http/http.dart' as http;

import 'pkce.dart';
import 'session.dart';

/// The redirect URI this app registers. The district server must list it in
/// NATIVE_APP_REDIRECT_URIS, and android/app/src/main/AndroidManifest.xml
/// routes the scheme back to the app.
const nativeRedirectUri = 'org.eduos.app:/oauth2redirect';
const nativeRedirectScheme = 'org.eduos.app';

typedef BrowserAuthenticator = Future<String> Function({required String url, required String callbackUrlScheme});

class SignInException implements Exception {
  const SignInException(this.message, {this.cancelled = false});
  final String message;
  final bool cancelled;
  @override
  String toString() => message;
}

/// Native sign-in (RFC 8252): the district identity provider runs in the
/// system browser (never an embedded WebView), the server hands the app a
/// single-use code bound to this app's PKCE challenge, and the app redeems it.
class AuthService {
  AuthService({http.Client? httpClient, BrowserAuthenticator? authenticate})
      : _http = httpClient ?? http.Client(),
        _authenticate = authenticate ?? _systemBrowser;

  final http.Client _http;
  final BrowserAuthenticator _authenticate;

  static Future<String> _systemBrowser({required String url, required String callbackUrlScheme}) =>
      FlutterWebAuth2.authenticate(url: url, callbackUrlScheme: callbackUrlScheme);

  static Uri loginUrl(Uri server, Pkce pkce) => server.resolve('/auth/login').replace(queryParameters: {
        'next': 'native',
        'app_challenge': pkce.challenge,
        'app_challenge_method': 'S256',
        'app_redirect': nativeRedirectUri,
      });

  Future<Session> signIn(Uri server, {Pkce? pkce}) async {
    final pair = pkce ?? Pkce.generate();
    final String callback;
    try {
      callback = await _authenticate(url: loginUrl(server, pair).toString(), callbackUrlScheme: nativeRedirectScheme);
    } on PlatformException catch (e) {
      if (e.code == 'CANCELED') throw const SignInException('Sign-in was cancelled.', cancelled: true);
      throw SignInException('The sign-in page could not be opened (${e.code}).');
    }
    final code = Uri.tryParse(callback)?.queryParameters['code'];
    if (code == null || code.isEmpty) throw const SignInException('The school server did not return a sign-in code.');

    final http.Response res;
    try {
      res = await _http.post(server.resolve('/auth/native/token'),
          headers: {'content-type': 'application/json', 'accept': 'application/json'},
          body: jsonEncode({'code': code, 'code_verifier': pair.verifier}));
    } on Exception {
      throw const SignInException('Could not reach the school server to finish signing in.');
    }
    final Object? json;
    try {
      json = jsonDecode(res.body);
    } on FormatException {
      throw SignInException('Unexpected reply from the school server (${res.statusCode}).');
    }
    if (res.statusCode != 200 || json is! Map) {
      final error = json is Map ? json['error'] : null;
      throw SignInException(switch (error) {
        'account_not_active' => 'Your EduOS account is not active. Contact your school.',
        'native_login_disabled' => 'This school server does not allow app sign-in yet. Ask your district IT team.',
        'invalid_grant' => 'Sign-in expired or was already used. Please try again.',
        _ => 'Sign-in failed (${res.statusCode}).',
      });
    }
    final token = json['sessionToken'], csrf = json['csrfToken'];
    final expires = DateTime.tryParse('${json['expiresAt']}');
    if (token is! String || csrf is! String || expires == null) throw const SignInException('Incomplete sign-in reply from the school server.');
    return Session(serverUrl: server, token: token, csrfToken: csrf, expiresAt: expires);
  }
}

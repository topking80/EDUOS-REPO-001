// 37.8 clients 02: Android TV / Google TV / Fire TV and Windows. Device
// sign-in (a code approved on a phone), the view-only TV layout, approving a
// screen from the phone, and the screen-lock PIN.
import 'dart:convert';

import 'package:eduos_mobile_branding/app/app_controller.dart';
import 'package:eduos_mobile_branding/app/role_tabs.dart';
import 'package:eduos_mobile_branding/core/device_profile.dart';
import 'package:eduos_mobile_branding/core/device_sign_in.dart';
import 'package:eduos_mobile_branding/core/key_value_store.dart';
import 'package:eduos_mobile_branding/core/privacy_lock.dart';
import 'package:eduos_mobile_branding/core/session.dart';
import 'package:eduos_mobile_branding/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import 'operations_screens_test.dart' show FakeServer, launch, server;

const tv = DeviceProfile(formFactor: FormFactor.tv, clientKind: 'android_tv', label: 'Living room');
http.Response ok(Object body) => http.Response(jsonEncode(body), 200);
final home = {'data': {'children': [{'id': 'k1', 'display_name': 'Ava Lee', 'grade_level': '4', 'school_name': 'Maple Elementary'}]}};

void main() {
  test('the screen kind comes from the Android launch arguments and the platform', () {
    expect(DeviceProfile.fromLaunch(const [], platform: TargetPlatform.android).formFactor, FormFactor.handheld);
    final atv = DeviceProfile.fromLaunch(const ['tv', 'model=Chromecast'], platform: TargetPlatform.android);
    expect([atv.formFactor, atv.clientKind, atv.label], [FormFactor.tv, 'android_tv', 'Chromecast']);
    final fire = DeviceProfile.fromLaunch(const ['tv', 'fire_tv', 'model=AFTMM'], platform: TargetPlatform.android, store: 'amazon');
    expect([fire.clientKind, fire.store, fire.readOnlyByDefault], ['fire_tv', 'amazon', true]);
    final pc = DeviceProfile.fromLaunch(const [], platform: TargetPlatform.windows);
    expect([pc.formFactor, pc.clientKind, pc.usesDeviceSignIn, pc.isTv], [FormFactor.desktop, 'windows', true, false]);
    expect(DeviceProfile.fromLaunch(const [], platform: TargetPlatform.iOS).usesDeviceSignIn, isFalse);
    expect(DeviceProfile.fromLaunch(const [], platform: TargetPlatform.android, forced: 'firetv').clientKind, 'fire_tv');
  });

  test('user codes are normalised the way the server does', () {
    expect(normalizeUserCode('bcdf ghjk'), 'BCDF-GHJK');
    expect(normalizeUserCode('BCDF-GHJK'), 'BCDF-GHJK');
    expect(normalizeUserCode('AAAA-AAAA'), isNull, reason: 'no vowels');
    expect(normalizeUserCode('BCDF'), isNull);
  });

  test('device sessions keep their kind and view-only flag on this device', () {
    final s = Session(serverUrl: server, token: 't', csrfToken: 'c', expiresAt: DateTime.now().add(const Duration(hours: 1)), clientKind: 'fire_tv', readOnly: true);
    final back = Session.fromJson(jsonDecode(jsonEncode(s.toJson())))!;
    expect([back.clientKind, back.readOnly], ['fire_tv', true]);
    expect(back.copyWith(token: 'u').readOnly, isTrue, reason: 'switching role keeps a TV view-only');
    expect(Session.fromJson(jsonDecode(jsonEncode(Session(serverUrl: server, token: 't', csrfToken: 'c', expiresAt: s.expiresAt).toJson())))!.readOnly, isFalse);
  });

  test('the screen-lock PIN is salted, stretched, never stored in the clear, and locks out after 5 wrong tries', () async {
    var clock = DateTime(2026, 11, 24, 9);
    final kv = MemoryKeyValueStore();
    final lock = PrivacyLock(kv, now: () => clock);
    await lock.setPin('4821');
    expect(kv.values['eduos.privacy'], isNot(contains('4821')));
    final again = PrivacyLock(kv, now: () => clock);
    await again.load();
    expect([again.hasPin, again.pinLength, again.autoLockMinutes], [true, 4, 10]);
    expect(again.verify('4821'), isTrue);
    for (var i = 0; i < 5; i++) {
      expect(again.verify('0000'), isFalse);
    }
    expect(again.waitBeforeRetry, const Duration(seconds: 30));
    expect(again.verify('4821'), isFalse, reason: 'locked out, even with the right PIN');
    clock = clock.add(const Duration(seconds: 31));
    expect(again.verify('4821'), isTrue);
    await again.setAutoLockMinutes(90);
    expect(again.autoLockMinutes, 30);
    expect(() => again.setPin('12'), throwsFormatException);
  });

  test('a TV hides work tabs and records not meant for a shared screen', () {
    expect(tabsFor('parent', tv: true).map((t) => t.id), isNot(contains('pickup')));
    expect(tabsFor('parent', tv: true).map((t) => t.id), contains('capsules'));
    expect(tabsFor('pupil', tv: true).map((t) => t.id), isNot(contains('christie')));
    expect(tabsFor('nurse', tv: true).map((t) => t.id), isNot(contains('healthoffice')));
    expect(tabsFor('parent'), roleTabs['parent']);
  });

  testWidgets('a TV signs in with a code approved on a phone, then shows a view-only family layout', (tester) async {
    tester.view.physicalSize = const Size(1920, 1080);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    var approved = false;
    final fake = FakeServer({
      'POST /auth/device/code': (r) {
        expect(jsonDecode(r.body), {'clientKind': 'android_tv', 'deviceLabel': 'Living room'});
        return ok({
          'deviceCode': 'd' * 43, 'userCode': 'BCDF-GHJK', 'verificationUri': 'https://eduos.example.test/device/',
          'verificationUriComplete': 'https://eduos.example.test/device/#BCDF-GHJK', 'qr': ['1110111', '1010101', '1110111', '0000000', '1110111', '1010101', '1110111'],
          'expiresIn': 600, 'interval': 5,
        });
      },
      'POST /auth/device/token': (_) => approved
          ? ok({'tokenType': 'Bearer', 'sessionToken': 'tvtok', 'csrfToken': 'tvcsrf', 'expiresAt': DateTime.now().add(const Duration(hours: 8)).toUtc().toIso8601String(),
              'role': 'parent', 'membershipRole': 'parent', 'clientKind': 'android_tv', 'readOnly': true})
          : http.Response(jsonEncode({'error': 'authorization_pending'}), 400),
      'GET /api/home': (_) => home,
      'GET /api/memberships': (_) => {'data': []},
    }, role: 'parent');
    final kv = MemoryKeyValueStore();
    await kv.write('eduos.server', server.toString());
    final app = AppController(store: kv, httpClientFactory: fake.client, safetyPollInterval: null, device: tv);
    addTearDown(app.dispose);
    await app.start();
    await tester.pumpWidget(EduOsApp(controller: app));
    await tester.pumpAndSettle();
    expect(find.text('Sign in this TV'), findsOneWidget);
    expect(find.text('BCDF-GHJK'), findsOneWidget);
    expect(find.text('https://eduos.example.test/device/'), findsOneWidget);
    expect(find.text('Or scan with your phone'), findsOneWidget);

    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(fake.sent('POST', '/auth/device/token'), hasLength(1));
    expect(app.stage, AppStage.signedOut, reason: 'still waiting for approval');

    approved = true;
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(app.stage, AppStage.signedIn);
    expect([app.readOnly, app.isDeviceSession], [true, true]);
    expect(fake.sent('GET', '/api/me').last.headers['authorization'], 'Bearer tvtok');
    // A side rail with the family's TV tabs; no pick-up pass on a TV.
    expect(find.byType(NavigationRail), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    expect(find.descendant(of: find.byType(NavigationRail), matching: find.text('Pick-up')), findsNothing);
    expect(find.descendant(of: find.byType(NavigationRail), matching: find.text('Time Capsules')), findsOneWidget);
  });

  testWidgets('a phone approves the code a TV shows', (tester) async {
    final fake = FakeServer({
      'GET /api/home': (_) => home,
      'GET /api/memberships': (_) => {'data': []},
      'POST /api/device-sign-in/check': (_) => {'data': {'clientKind': 'roku', 'deviceLabel': 'Den', 'readOnly': true, 'expiresAt': DateTime.now().toIso8601String()}},
      'POST /api/device-sign-in/approve': (_) => {'data': {'status': 'approved'}},
    }, role: 'parent');
    final app = await launch(tester, fake);
    await tester.tap(find.byTooltip('Account'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign in a TV or computer'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), 'bcdf ghjk');
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.text('Roku “Den” wants to sign in to your EduOS account.'), findsOneWidget);
    expect(jsonDecode(fake.sent('POST', '/api/device-sign-in/check').single.body), {'userCode': 'BCDF-GHJK'});
    await tester.tap(find.text('Approve'));
    await tester.pumpAndSettle();
    expect(jsonDecode(fake.sent('POST', '/api/device-sign-in/approve').single.body), {'userCode': 'BCDF-GHJK'});
    expect(find.text('Approved. The screen signs in within a few seconds.'), findsOneWidget);
    expect(app.isDeviceSession, isFalse);
  });

  testWidgets('with a PIN set, the app locks after the idle time and unlocks with the PIN', (tester) async {
    final fake = FakeServer({'GET /api/home': (_) => home, 'GET /api/memberships': (_) => {'data': []}}, role: 'parent');
    final app = await launch(tester, fake);
    await app.setPin('2468');
    await tester.pumpAndSettle();
    expect(app.locked, isFalse);
    await tester.pump(const Duration(minutes: 10));
    await tester.pumpAndSettle();
    expect(app.locked, isTrue);
    expect(find.text('EduOS is locked'), findsOneWidget);
    for (final d in ['1', '1', '1', '1']) {
      await tester.tap(find.widgetWithText(OutlinedButton, d));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(find.text('That PIN isn\'t right.'), findsOneWidget);
    for (final d in ['2', '4', '6', '8']) {
      await tester.tap(find.widgetWithText(OutlinedButton, d));
      await tester.pump();
    }
    await tester.pumpAndSettle();
    expect(app.locked, isFalse);
    expect(find.text('EduOS is locked'), findsNothing);
    // Leaving the app locks it at once.
    app.onBackgrounded();
    await tester.pumpAndSettle();
    expect(find.text('EduOS is locked'), findsOneWidget);
  });
}

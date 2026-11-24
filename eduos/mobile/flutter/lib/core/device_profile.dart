import 'package:flutter/foundation.dart';

/// What kind of screen the app is running on.
enum FormFactor {
  /// Phones, tablets and Fire tablets (touch first).
  handheld,

  /// Windows (and other desktops): mouse and keyboard, a personal computer.
  desktop,

  /// Android TV / Google TV / Fire TV: a 10-foot screen driven by a D-pad remote.
  tv,
}

/// The screen this app runs on and the store build it came from.
///
/// [clientKind] is what device sign-in (RFC 8628, POST /auth/device/code)
/// calls this screen: `android_tv`, `fire_tv` or `windows`. Phones and
/// tablets have none: they sign in through the system browser instead.
class DeviceProfile {
  const DeviceProfile({required this.formFactor, this.clientKind, this.store = 'play', this.label});

  /// A phone or tablet from the Play store build (the default in tests).
  static const handheld = DeviceProfile(formFactor: FormFactor.handheld);

  final FormFactor formFactor;
  final String? clientKind;

  /// `play` (Google Play, the default) or `amazon` (Amazon Appstore build,
  /// `--dart-define=EDUOS_STORE=amazon`). The Amazon build uses no Google
  /// Play services.
  final String store;

  /// A name for this screen the person approving it will see, e.g. "Fire TV Stick 4K".
  final String? label;

  bool get isTv => formFactor == FormFactor.tv;

  /// TVs and Windows sign in with a code approved on a phone or computer.
  bool get usesDeviceSignIn => clientKind != null;

  /// TV sessions are read-only on the server; the app hides changes too.
  bool get readOnlyByDefault => isTv;

  /// Builds the profile from the launch arguments the Android activity passes
  /// (MainActivity.getDartEntrypointArgs: `tv`, `fire_tv`, `model=...`) and
  /// the platform. Synchronous, so the first frame already has the right
  /// layout. `--dart-define=EDUOS_FORM_FACTOR=tv|firetv|desktop` overrides it
  /// (emulators, or trying the TV layout on a laptop).
  static DeviceProfile fromLaunch(List<String> args, {TargetPlatform? platform, String forced = _forced, String store = _store}) {
    switch (forced) {
      case 'tv':
        return DeviceProfile(formFactor: FormFactor.tv, clientKind: 'android_tv', store: store, label: 'Android TV');
      case 'firetv':
        return const DeviceProfile(formFactor: FormFactor.tv, clientKind: 'fire_tv', store: 'amazon', label: 'Fire TV');
      case 'desktop':
        return DeviceProfile(formFactor: FormFactor.desktop, clientKind: 'windows', store: store, label: 'Windows PC');
    }
    final target = platform ?? (kIsWeb ? null : defaultTargetPlatform);
    if (target == TargetPlatform.windows) return DeviceProfile(formFactor: FormFactor.desktop, clientKind: 'windows', store: store, label: 'Windows PC');
    if (target == TargetPlatform.android && args.contains('tv')) {
      String? model;
      for (final a in args) {
        if (a.startsWith('model=')) model = a.substring(6).trim();
      }
      final label = (model == null || model.isEmpty) ? null : (model.length > 60 ? model.substring(0, 60) : model);
      return args.contains('fire_tv')
          ? DeviceProfile(formFactor: FormFactor.tv, clientKind: 'fire_tv', store: store, label: label ?? 'Fire TV')
          : DeviceProfile(formFactor: FormFactor.tv, clientKind: 'android_tv', store: store, label: label ?? 'Android TV');
    }
    return DeviceProfile(formFactor: FormFactor.handheld, store: store);
  }

  static const _forced = String.fromEnvironment('EDUOS_FORM_FACTOR');
  static const _store = String.fromEnvironment('EDUOS_STORE', defaultValue: 'play');
}

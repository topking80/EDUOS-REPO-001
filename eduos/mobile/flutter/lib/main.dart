import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'app/app_controller.dart';
import 'app/app_scope.dart';
import 'core/device_profile.dart';
import 'core/models.dart';
import 'branding/eduos_brand_theme.dart';
import 'ui/device_sign_in_screen.dart';
import 'ui/lock_screen.dart';
import 'ui/shell.dart';
import 'ui/sign_in_screen.dart';

void main(List<String> args) {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = AppController(device: DeviceProfile.fromLaunch(args))..start();
  runApp(EduOsApp(controller: controller));
}

/// Parses a #rrggbb school colour from the branding API.
Color? parseHex(String? hex) {
  final m = RegExp(r'^#?([0-9a-fA-F]{6})$').firstMatch(hex ?? '');
  return m == null ? null : Color(0xFF000000 | int.parse(m.group(1)!, radix: 16));
}

class EduOsApp extends StatelessWidget {
  const EduOsApp({super.key, required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      controller: controller,
      child: ListenableBuilder(
        listenable: controller,
        builder: (context, _) {
          const defaults = EduOsBrandTheme();
          final brand = defaults.copyWith(
            primary: parseHex(controller.brand?.primaryHex),
            accent: parseHex(controller.brand?.accentHex),
          );
          final tv = controller.isTv;
          final display = controller.brand?.display ?? const DisplayPrefs();
          final scheme = ColorScheme.fromSeed(seedColor: brand.primary, contrastLevel: display.highContrast ? 1.0 : 0.0);
          return MaterialApp(
            title: 'EduOS',
            debugShowCheckedModeBanner: false,
            // TV remotes: OK / select and game-pad A press the focused control.
            shortcuts: tv ? tvShortcuts : null,
            theme: ThemeData(
              colorScheme: scheme,
              scaffoldBackgroundColor: brand.surface,
              extensions: [brand],
              useMaterial3: true,
              // 10-foot UI: roomier controls and a strong focus highlight.
              visualDensity: tv ? VisualDensity.comfortable : null,
              focusColor: tv ? scheme.primary.withOpacity(0.28) : null,
            ),
            builder: (context, child) {
              // TV: larger text. Everyone: their own display settings, on top of the device's.
              final mq = MediaQuery.of(context);
              final scale = (tv ? 1.25 : 1.0) * display.textScale;
              return ActivityWatcher(
                controller: controller,
                child: MediaQuery(
                  data: mq.copyWith(
                    textScaler: scale == 1.0 ? mq.textScaler : TextScaler.linear(mq.textScaler.scale(1.0) * scale),
                    highContrast: mq.highContrast || display.highContrast,
                    disableAnimations: mq.disableAnimations || display.reduceMotion,
                  ),
                  child: child ?? const SizedBox.shrink(),
                ),
              );
            },
            home: switch (controller.stage) {
              AppStage.starting => const Scaffold(body: Center(child: CircularProgressIndicator())),
              AppStage.needsServer => const ServerSetupScreen(),
              AppStage.signedOut when controller.device.usesDeviceSignIn => const DeviceSignInScreen(),
              AppStage.signedOut || AppStage.offline => const SignInScreen(),
              AppStage.signedIn when controller.locked => const LockScreen(),
              AppStage.signedIn => const Shell(),
            },
          );
        },
      ),
    );
  }
}

/// Remote-control keys on Android TV / Fire TV, on top of Flutter's defaults.
final tvShortcuts = <ShortcutActivator, Intent>{
  ...WidgetsApp.defaultShortcuts,
  const SingleActivator(LogicalKeyboardKey.select): const ActivateIntent(),
  const SingleActivator(LogicalKeyboardKey.gameButtonA): const ActivateIntent(),
  const SingleActivator(LogicalKeyboardKey.mediaPlayPause): const ActivateIntent(),
};

/// Feeds taps, clicks and key presses to the screen-lock idle timer, and
/// locks when the app goes to the background (if a PIN is set).
class ActivityWatcher extends StatefulWidget {
  const ActivityWatcher({super.key, required this.controller, required this.child});
  final AppController controller;
  final Widget child;

  @override
  State<ActivityWatcher> createState() => _ActivityWatcherState();
}

class _ActivityWatcherState extends State<ActivityWatcher> with WidgetsBindingObserver {
  bool _onKey(KeyEvent _) {
    widget.controller.noteActivity();
    return false;
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    HardwareKeyboard.instance.addHandler(_onKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_onKey);
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.paused || state == AppLifecycleState.hidden) widget.controller.onBackgrounded();
  }

  @override
  Widget build(BuildContext context) => Listener(
        behavior: HitTestBehavior.translucent,
        onPointerDown: (_) => widget.controller.noteActivity(),
        onPointerSignal: (_) => widget.controller.noteActivity(),
        child: widget.child,
      );
}

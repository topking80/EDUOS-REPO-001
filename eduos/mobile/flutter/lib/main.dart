import 'package:flutter/material.dart';

import 'app/app_controller.dart';
import 'app/app_scope.dart';
import 'branding/eduos_brand_theme.dart';
import 'ui/shell.dart';
import 'ui/sign_in_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = AppController()..start();
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
          return MaterialApp(
            title: 'EduOS',
            debugShowCheckedModeBanner: false,
            theme: ThemeData(
              colorScheme: ColorScheme.fromSeed(seedColor: brand.primary),
              scaffoldBackgroundColor: brand.surface,
              extensions: [brand],
              useMaterial3: true,
            ),
            home: switch (controller.stage) {
              AppStage.starting => const Scaffold(body: Center(child: CircularProgressIndicator())),
              AppStage.needsServer => const ServerSetupScreen(),
              AppStage.signedOut || AppStage.offline => const SignInScreen(),
              AppStage.signedIn => const Shell(),
            },
          );
        },
      ),
    );
  }
}

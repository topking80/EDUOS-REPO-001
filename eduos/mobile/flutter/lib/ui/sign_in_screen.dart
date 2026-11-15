import 'package:flutter/material.dart';

import '../app/app_controller.dart';
import '../app/app_scope.dart';
import '../branding/eduos_mascot.dart';
import '../core/auth_service.dart';
import 'widgets.dart';

/// First run: which district server to use (e.g. eduos.district.org).
class ServerSetupScreen extends StatefulWidget {
  const ServerSetupScreen({super.key});

  @override
  State<ServerSetupScreen> createState() => _ServerSetupScreenState();
}

class _ServerSetupScreenState extends State<ServerSetupScreen> {
  late final _address = TextEditingController(text: AppScope.read(context).server?.host ?? '');
  String? _error;

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    try {
      await AppScope.read(context).setServer(_address.text);
    } on FormatException catch (e) {
      setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(24), children: [
          const EduOsMascot(height: 160),
          const SizedBox(height: 16),
          Text('Welcome to EduOS', style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          const Text('Enter your school district\'s EduOS address. Your school can tell you what it is.', textAlign: TextAlign.center),
          const SizedBox(height: 24),
          TextField(
            controller: _address,
            keyboardType: TextInputType.url,
            autocorrect: false,
            textInputAction: TextInputAction.go,
            onSubmitted: (_) => _save(),
            decoration: InputDecoration(labelText: 'EduOS address', hintText: 'eduos.district.org', errorText: _error),
          ),
          const SizedBox(height: 16),
          FilledButton(onPressed: _save, child: const Text('Continue')),
        ]),
      ),
    );
  }
}

/// Sign in through the district's identity provider in the system browser.
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _signIn() async {
    final app = AppScope.read(context);
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await app.signIn();
    } on SignInException catch (e) {
      if (mounted && !e.cancelled) setState(() => _error = e.message);
    } on Exception {
      if (mounted) setState(() => _error = 'Sign-in didn\'t finish. Check your connection and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final offline = app.stage == AppStage.offline;
    return Scaffold(
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(24), children: [
          const EduOsMascot(height: 160),
          const SizedBox(height: 16),
          Text('Sign in to EduOS', style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
          const SizedBox(height: 8),
          Text(app.server?.host ?? '', textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall),
          if (app.notice != null) Notice(app.notice!),
          if (offline) const Notice('Can\'t reach your school server right now. You\'re still signed in on this phone.'),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
          const SizedBox(height: 24),
          if (offline)
            FilledButton(onPressed: app.start, child: const Text('Try again'))
          else
            FilledButton.icon(
              onPressed: _busy ? null : _signIn,
              icon: const Icon(Icons.login),
              label: Text(_busy ? 'Signing in…' : 'Sign in with your school account'),
            ),
          const SizedBox(height: 8),
          const Notice('Sign-in opens your district\'s sign-in page in the browser. EduOS never sees your password.'),
          TextButton(onPressed: app.changeServer, child: const Text('Use a different school address')),
        ]),
      ),
    );
  }
}

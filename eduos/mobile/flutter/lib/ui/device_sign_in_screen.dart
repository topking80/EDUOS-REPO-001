import 'dart:async';

import 'package:flutter/material.dart';

import '../app/app_scope.dart';
import '../core/device_profile.dart';
import '../core/device_sign_in.dart';
import 'screens/web_fallback_screen.dart' show openWebApp;
import 'widgets.dart';

/// Sign-in on a TV or a Windows PC (RFC 8628 device sign-in): show a short
/// code and a QR code; the person approves it on a phone or computer where
/// they are already signed in to EduOS. Nothing is typed with the remote.
class DeviceSignInScreen extends StatefulWidget {
  const DeviceSignInScreen({super.key});

  @override
  State<DeviceSignInScreen> createState() => _DeviceSignInScreenState();
}

class _DeviceSignInScreenState extends State<DeviceSignInScreen> {
  DeviceCode? _code;
  String? _error;
  String? _info;
  bool _starting = false;
  Timer? _timer;
  Duration _interval = const Duration(seconds: 5);
  bool _polling = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _start());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _start() async {
    _timer?.cancel();
    setState(() {
      _starting = true;
      _error = null;
    });
    try {
      final code = await AppScope.read(context).startDeviceSignIn();
      if (!mounted) return;
      setState(() {
        _code = code;
        _interval = code.interval;
      });
      _schedule();
    } on DeviceSignInException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _starting = false);
    }
  }

  void _schedule() {
    _timer?.cancel();
    _timer = Timer(_interval, _poll);
  }

  Future<void> _poll() async {
    final code = _code;
    if (code == null || _polling || !mounted) return;
    _polling = true;
    try {
      final r = await AppScope.read(context).pollDeviceSignIn(code);
      if (!mounted) return;
      switch (r.state) {
        case DevicePollState.signedIn:
          return; // the app switches to the signed-in screens
        case DevicePollState.pending:
          _schedule();
        case DevicePollState.slowDown:
          _interval += const Duration(seconds: 5);
          _schedule();
        case DevicePollState.expired:
          setState(() => _info = 'The code expired, so here is a new one.');
          unawaited(_start());
        case DevicePollState.denied:
        case DevicePollState.failed:
          setState(() {
            _code = null;
            _error = r.message ?? 'Sign-in didn\'t finish.';
          });
      }
    } finally {
      _polling = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final theme = Theme.of(context);
    final code = _code;
    final isPc = app.device.formFactor == FormFactor.desktop;
    final what = isPc ? 'this computer' : 'this TV';
    final steps = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Sign in $what', style: theme.textTheme.headlineMedium),
      const SizedBox(height: 4),
      Text(app.server?.host ?? '', style: theme.textTheme.bodyMedium),
      const SizedBox(height: 24),
      Text('1. On your phone or computer, open the EduOS app and choose Account › Sign in a TV or computer, or go to', style: theme.textTheme.titleMedium),
      const SizedBox(height: 4),
      SelectableText(code?.verificationUri.toString() ?? '…', style: theme.textTheme.titleLarge?.copyWith(fontWeight: FontWeight.w600)),
      const SizedBox(height: 16),
      Text('2. Enter this code:', style: theme.textTheme.titleMedium),
      const SizedBox(height: 8),
      Semantics(
        label: code == null ? 'Getting a code' : 'Sign-in code ${code.userCode.split('').join(' ')}',
        child: Text(code?.userCode ?? '····-····',
            style: theme.textTheme.displayMedium?.copyWith(fontWeight: FontWeight.w700, letterSpacing: 6, fontFamily: 'monospace')),
      ),
      const SizedBox(height: 16),
      Text(isPc ? '3. Approve it. This computer signs in by itself.' : '3. Approve it. This TV signs in by itself, and can view EduOS but not change anything.',
          style: theme.textTheme.titleMedium),
      if (_info != null) Notice(_info!),
      if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: TextStyle(color: theme.colorScheme.error))),
      const SizedBox(height: 24),
      Wrap(spacing: 12, runSpacing: 12, children: [
        if (code == null)
          FilledButton.icon(autofocus: true, onPressed: _starting ? null : _start, icon: const Icon(Icons.refresh), label: Text(_starting ? 'Getting a code…' : 'Get a code')),
        if (code != null && isPc)
          FilledButton.icon(
            autofocus: true,
            onPressed: () => openWebApp(context, path: '/device/#${code.userCode}'),
            icon: const Icon(Icons.open_in_browser),
            label: const Text('Approve in this computer\'s browser'),
          ),
        if (code != null) OutlinedButton.icon(autofocus: !isPc, onPressed: _starting ? null : _start, icon: const Icon(Icons.refresh), label: const Text('New code')),
        TextButton(onPressed: app.changeServer, child: const Text('Use a different school address')),
      ]),
    ]);
    final qr = code == null || code.qrRows.isEmpty
        ? null
        : Column(mainAxisSize: MainAxisSize.min, children: [
            QrMatrix(code.qrRows, semanticLabel: 'QR code that opens the EduOS sign-in approval page with this code', size: 260),
            const SizedBox(height: 8),
            Text('Or scan with your phone', style: theme.textTheme.titleMedium),
          ]);
    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(builder: (context, c) {
          final wide = c.maxWidth >= 840;
          return SingleChildScrollView(
            padding: EdgeInsets.symmetric(horizontal: wide ? 64 : 24, vertical: 32),
            child: wide && qr != null
                ? Row(crossAxisAlignment: CrossAxisAlignment.start, children: [Expanded(child: steps), const SizedBox(width: 48), qr])
                : Column(crossAxisAlignment: CrossAxisAlignment.start, children: [steps, if (qr != null) ...[const SizedBox(height: 24), Center(child: qr)]]),
          );
        }),
      ),
    );
  }
}

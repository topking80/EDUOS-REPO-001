import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/app_scope.dart';
import 'widgets.dart';

/// The screen lock: asks for this device's PIN after the idle time or when
/// the app comes back from the background. Works with touch, a keyboard and
/// a TV remote (D-pad moves between the keys, OK presses one).
class LockScreen extends StatefulWidget {
  const LockScreen({super.key});

  @override
  State<LockScreen> createState() => _LockScreenState();
}

class _LockScreenState extends State<LockScreen> {
  String _pin = '';
  String? _error;
  Timer? _tick;

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  void _press(String digit) {
    final length = AppScope.read(context).privacy.pinLength;
    if (_pin.length >= length) return;
    setState(() {
      _pin += digit;
      _error = null;
    });
    // The PIN is checked as soon as it's complete.
    if (_pin.length == length) _submit();
  }

  void _back() => setState(() => _pin = _pin.isEmpty ? '' : _pin.substring(0, _pin.length - 1));

  void _submit() {
    final app = AppScope.read(context);
    if (_pin.length < app.privacy.pinLength) return setState(() => _error = 'Enter your ${app.privacy.pinLength}-digit PIN.');
    final ok = app.unlock(_pin);
    if (ok) return;
    final wait = app.privacy.waitBeforeRetry;
    setState(() {
      _pin = '';
      _error = wait > Duration.zero ? 'Too many wrong PINs. Try again in ${_waitText(wait)}.' : 'That PIN isn\'t right.';
    });
    if (wait > Duration.zero) {
      _tick?.cancel();
      _tick = Timer(wait, () {
        if (mounted) setState(() => _error = null);
      });
    }
  }

  static String _waitText(Duration d) => d.inSeconds < 60 ? '${d.inSeconds} seconds' : '${(d.inSeconds / 60).ceil()} minutes';

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent) return KeyEventResult.ignored;
    final ch = e.character;
    if (ch != null && RegExp(r'^[0-9]$').hasMatch(ch)) {
      _press(ch);
      return KeyEventResult.handled;
    }
    if (e.logicalKey == LogicalKeyboardKey.backspace) {
      _back();
      return KeyEventResult.handled;
    }
    if (e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter) {
      _submit();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final theme = Theme.of(context);
    Widget key(String label, VoidCallback onPressed, {bool autofocus = false, String? semantic, IconData? icon}) => Padding(
          padding: const EdgeInsets.all(6),
          child: SizedBox(
            width: 84,
            height: 72,
            child: OutlinedButton(
              autofocus: autofocus,
              onPressed: onPressed,
              child: icon == null ? Text(label, style: theme.textTheme.headlineSmall) : Icon(icon, semanticLabel: semantic),
            ),
          ),
        );
    return Scaffold(
      body: SafeArea(
        child: Focus(
          onKeyEvent: _onKey,
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(mainAxisSize: MainAxisSize.min, children: [
                Icon(Icons.lock_outline, size: 48, color: theme.colorScheme.primary),
                const SizedBox(height: 12),
                Text('EduOS is locked', style: theme.textTheme.headlineSmall),
                const SizedBox(height: 4),
                Text(app.me?.displayName ?? '', style: theme.textTheme.titleMedium),
                const SizedBox(height: 16),
                Semantics(
                  label: '${_pin.length} digits entered',
                  liveRegion: true,
                  child: Row(mainAxisSize: MainAxisSize.min, children: [
                    for (var i = 0; i < app.privacy.pinLength; i++)
                      Container(
                        margin: const EdgeInsets.all(6),
                        width: 16,
                        height: 16,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: i < _pin.length ? theme.colorScheme.primary : null,
                          border: Border.all(color: theme.colorScheme.outline),
                        ),
                      ),
                  ]),
                ),
                if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: TextStyle(color: theme.colorScheme.error))),
                const SizedBox(height: 16),
                FocusTraversalGroup(
                  policy: ReadingOrderTraversalPolicy(),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    for (final row in const [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9']])
                      Row(mainAxisSize: MainAxisSize.min, children: [for (final d in row) key(d, () => _press(d), autofocus: d == '1')]),
                    Row(mainAxisSize: MainAxisSize.min, children: [
                      key('', _back, semantic: 'Delete', icon: Icons.backspace_outlined),
                      key('0', () => _press('0')),
                      key('', _submit, semantic: 'Unlock', icon: Icons.check),
                    ]),
                  ]),
                ),
                const SizedBox(height: 16),
                TextButton(
                  onPressed: () async {
                    final ok = await confirm(context,
                        title: 'Forgot the PIN?', text: 'Signing out removes the PIN from this screen. You can sign in again with your school account.', action: 'Sign out');
                    if (ok) await app.signOut();
                  },
                  child: const Text('Forgot PIN? Sign out'),
                ),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

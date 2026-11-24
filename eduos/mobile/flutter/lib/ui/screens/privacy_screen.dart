import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/privacy_lock.dart';
import '../widgets.dart';
import 'time_capsule/history_widgets.dart' show ReadableList;

/// Screen lock: a PIN for shared screens (family TV, Windows PC, a tablet the
/// family shares). Kept only on this device.
class PrivacyScreen extends StatelessWidget {
  const PrivacyScreen({super.key});

  static const minuteChoices = [5, 10, 15, 30];

  Future<void> _choosePin(BuildContext context) async {
    final pin = await showDialog<String>(context: context, builder: (_) => const _PinDialog());
    if (pin == null || !context.mounted) return;
    await AppScope.read(context).setPin(pin);
    if (context.mounted) toast(context, 'Screen lock is on.');
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final lock = app.privacy;
    final where = app.isTv ? 'this TV' : 'this device';
    return Scaffold(
      appBar: AppBar(title: const Text('Screen lock')),
      body: ReadableList(children: [
        SectionCard(title: lock.hasPin ? 'Screen lock is on' : 'Screen lock is off', children: [
          Text('A PIN stops other people who use $where from seeing your EduOS account. '
              'EduOS locks after you stop using it for a while and when you leave the app. '
              'The PIN is kept only on $where.'),
          const SizedBox(height: 12),
          Wrap(spacing: 12, runSpacing: 8, children: [
            FilledButton(autofocus: true, onPressed: () => _choosePin(context), child: Text(lock.hasPin ? 'Change PIN' : 'Set a PIN')),
            if (lock.hasPin) OutlinedButton(onPressed: app.lock, child: const Text('Lock now')),
            if (lock.hasPin)
              TextButton(
                onPressed: () async {
                  if (await confirm(context, title: 'Turn off the screen lock?', action: 'Turn off')) await app.removePin();
                },
                child: const Text('Turn off'),
              ),
          ]),
        ]),
        if (lock.hasPin)
          SectionCard(title: 'Lock after', children: [
            Wrap(spacing: 8, runSpacing: 8, children: [
              for (final m in minuteChoices)
                ChoiceChip(label: Text('$m minutes'), selected: lock.autoLockMinutes == m, onSelected: (_) => app.setAutoLockMinutes(m)),
            ]),
          ]),
      ]),
    );
  }
}

class _PinDialog extends StatefulWidget {
  const _PinDialog();

  @override
  State<_PinDialog> createState() => _PinDialogState();
}

class _PinDialogState extends State<_PinDialog> {
  final _first = TextEditingController(), _second = TextEditingController();
  String? _error;

  @override
  void dispose() {
    _first.dispose();
    _second.dispose();
    super.dispose();
  }

  void _save() {
    if (!PrivacyLock.validPin(_first.text)) return setState(() => _error = 'Use 4 to 6 digits.');
    if (_first.text != _second.text) return setState(() => _error = 'The two PINs don\'t match.');
    Navigator.pop(context, _first.text);
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
        title: const Text('Choose a PIN'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(
              controller: _first,
              autofocus: true,
              obscureText: true,
              keyboardType: TextInputType.number,
              maxLength: 6,
              decoration: const InputDecoration(labelText: 'PIN (4 to 6 digits)')),
          TextField(
              controller: _second,
              obscureText: true,
              keyboardType: TextInputType.number,
              maxLength: 6,
              onSubmitted: (_) => _save(),
              decoration: InputDecoration(labelText: 'Enter it again', errorText: _error)),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
          FilledButton(onPressed: _save, child: const Text('Save')),
        ],
      );
}

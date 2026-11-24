import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/device_sign_in.dart';
import '../widgets.dart';
import 'time_capsule/history_widgets.dart' show ReadableList;

/// "Sign in a TV or computer": approve the code an Android TV, Fire TV, Roku
/// or Windows PC is showing, from this already signed-in phone or tablet.
class DeviceApprovalScreen extends StatefulWidget {
  const DeviceApprovalScreen({super.key, this.initialCode});

  final String? initialCode;

  @override
  State<DeviceApprovalScreen> createState() => _DeviceApprovalScreenState();
}

class _DeviceApprovalScreenState extends State<DeviceApprovalScreen> {
  late final _code = TextEditingController(text: widget.initialCode ?? '');
  String? _checked;
  DeviceRequest? _request;
  String? _error;
  String? _done;
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  static String _errorText(ApiException e) => switch (e.status) {
        0 => 'You\'re offline. This needs a connection.',
        404 => 'That code isn\'t valid or has expired. Check the screen and try again.',
        429 => 'Too many tries. Wait a few minutes and try again.',
        403 when e.error == 'device_session_cannot_approve' => 'Use your phone or computer to approve a screen, not another TV.',
        403 => 'This account can\'t approve screens.',
        _ => 'Something went wrong (${e.status}). Try again.',
      };

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = _errorText(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _check() async {
    final code = normalizeUserCode(_code.text);
    if (code == null) return setState(() => _error = 'The code is 8 letters, like BCDF-GHJK.');
    await _run(() async {
      final request = await AppScope.read(context).checkDevice(code);
      if (mounted) {
        setState(() {
          _checked = code;
          _request = request;
        });
      }
    });
  }

  Future<void> _decide(bool approve) async {
    final code = _checked;
    if (code == null) return;
    final app = AppScope.read(context);
    await _run(() async {
      approve ? await app.approveDevice(code) : await app.denyDevice(code);
      if (mounted) {
        setState(() {
          _done = approve ? 'Approved. The screen signs in within a few seconds.' : 'Refused. That screen was not signed in.';
          _request = null;
          _checked = null;
          _code.clear();
        });
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final request = _request;
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in a TV or computer')),
      body: ReadableList(children: [
        if (_done != null) Notice(_done!),
        if (request == null)
          SectionCard(title: 'Code on the screen', children: [
            const Text('Open EduOS on the TV, Roku or Windows PC. It shows an 8-letter code. Enter it here to sign that screen in to your account.'),
            const SizedBox(height: 12),
            TextField(
              controller: _code,
              autofocus: true,
              textCapitalization: TextCapitalization.characters,
              autocorrect: false,
              enableSuggestions: false,
              maxLength: 9,
              textInputAction: TextInputAction.go,
              onSubmitted: (_) => _check(),
              decoration: InputDecoration(labelText: 'Code', hintText: 'BCDF-GHJK', errorText: _error),
              style: Theme.of(context).textTheme.headlineSmall?.copyWith(letterSpacing: 4),
            ),
            FilledButton(onPressed: _busy ? null : _check, child: const Text('Continue')),
          ])
        else
          SectionCard(title: 'Sign in this screen?', children: [
            Text('${request.kindText}${request.deviceLabel == null ? '' : ' “${request.deviceLabel}”'} wants to sign in to your EduOS account.',
                style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            if (request.readOnly) const Text('It can view your EduOS pages but can\'t change anything. You can sign it out from the screen at any time.'),
            const SizedBox(height: 8),
            const Text('Only approve a code you can see on a screen in front of you.'),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error))),
            const SizedBox(height: 12),
            Wrap(spacing: 12, runSpacing: 8, children: [
              FilledButton(onPressed: _busy ? null : () => _decide(true), child: const Text('Approve')),
              OutlinedButton(onPressed: _busy ? null : () => _decide(false), child: const Text('This isn\'t me')),
            ]),
          ]),
      ]),
    );
  }
}

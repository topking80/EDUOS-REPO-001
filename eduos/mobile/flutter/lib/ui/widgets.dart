import 'package:flutter/material.dart';

import '../core/api_client.dart';
import '../core/format.dart';

/// Loads data for a screen, with a spinner, a retry button on failure and
/// pull-to-refresh. Sign-in expiry is handled by the app controller.
class Loader<T> extends StatefulWidget {
  const Loader({super.key, required this.load, required this.builder});

  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data, Future<void> Function() reload) builder;

  @override
  State<Loader<T>> createState() => _LoaderState<T>();
}

class _LoaderState<T> extends State<Loader<T>> {
  late Future<T> _future = widget.load();

  Future<void> _reload() async {
    final next = widget.load();
    // Block body: setState must not return a Future.
    setState(() {
      _future = next;
    });
    try {
      await next;
    } on Object {
      // Shown by the builder below.
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Center(child: Padding(padding: EdgeInsets.all(32), child: CircularProgressIndicator()));
        }
        if (snap.hasError) {
          final e = snap.error;
          final offline = e is ApiException && e.isOffline;
          return ListView(padding: const EdgeInsets.all(16), children: [
            SectionCard(children: [
              Text('Something went wrong', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              Text(offline ? 'You\'re offline. EduOS needs a connection to show school data.' : 'Please try again.'),
              const SizedBox(height: 12),
              FilledButton.tonal(onPressed: _reload, child: const Text('Retry')),
            ]),
          ]);
        }
        return RefreshIndicator(onRefresh: _reload, child: widget.builder(context, snap.data as T, _reload));
      },
    );
  }
}

class SectionCard extends StatelessWidget {
  const SectionCard({super.key, required this.children, this.title, this.color});

  final String? title;
  final List<Widget> children;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    return Card(
      color: color,
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          if (title != null) ...[
            Semantics(header: true, child: Text(title!, style: Theme.of(context).textTheme.titleMedium)),
            const SizedBox(height: 8),
          ],
          ...children,
        ]),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState(this.message, {super.key});
  final String message;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 8),
        child: Text(message, textAlign: TextAlign.center, style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant)),
      );
}

class Notice extends StatelessWidget {
  const Notice(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(Icons.info_outline, size: 18, color: Theme.of(context).colorScheme.primary),
          const SizedBox(width: 8),
          Expanded(child: Text(text, style: Theme.of(context).textTheme.bodySmall)),
        ]),
      );
}

enum ChipTone { good, waiting, bad, info }

ChipTone toneFor(String status) => switch (status) {
      'present' || 'boarded' || 'alighted' || 'approved' || 'delivered' => ChipTone.good,
      'absent' || 'rejected' || 'not_riding' || 'denied' || 'cancelled' => ChipTone.bad,
      'current' => ChipTone.info,
      _ => ChipTone.waiting,
    };

class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key, this.text, this.tone});

  final String status;
  final String? text;
  final ChipTone? tone;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final (bg, fg) = switch (tone ?? toneFor(status)) {
      ChipTone.good => (const Color(0xFFDDF3E4), const Color(0xFF14532D)),
      ChipTone.bad => (const Color(0xFFFDE2E1), const Color(0xFF7F1D1D)),
      ChipTone.info => (scheme.primaryContainer, scheme.onPrimaryContainer),
      ChipTone.waiting => (const Color(0xFFFEF3C7), const Color(0xFF713F12)),
    };
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(999)),
      child: Text(text ?? statusLabel(status), style: TextStyle(color: fg, fontWeight: FontWeight.w600, fontSize: 12)),
    );
  }
}

class StatTile extends StatelessWidget {
  const StatTile(this.value, this.label, {super.key, this.warnWhenPositive = false});

  final int value;
  final String label;
  final bool warnWhenPositive;

  @override
  Widget build(BuildContext context) {
    final warn = warnWhenPositive && value > 0;
    return Semantics(
      label: '$value $label',
      excludeSemantics: true,
      child: Column(children: [
        Text('$value', style: Theme.of(context).textTheme.headlineSmall?.copyWith(
            fontWeight: FontWeight.w700, color: warn ? Theme.of(context).colorScheme.error : null)),
        Text(label, textAlign: TextAlign.center, style: Theme.of(context).textTheme.bodySmall),
      ]),
    );
  }
}

/// Snackbar helper used after actions.
void toast(BuildContext context, String message) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(message)));
}

/// Confirmation dialog. Returns true when confirmed.
Future<bool> confirm(BuildContext context, {required String title, String? text, String action = 'OK', bool danger = false}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: text == null ? null : Text(text),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel')),
        FilledButton(
          style: danger ? FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error) : null,
          onPressed: () => Navigator.pop(context, true),
          child: Text(action),
        ),
      ],
    ),
  );
  return ok ?? false;
}

/// Text prompt dialog. Returns the trimmed text, or null when cancelled.
Future<String?> promptText(BuildContext context, {required String title, String? text, required String label, String action = 'OK', int maxLength = 500}) {
  final controller = TextEditingController();
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        if (text != null) Text(text),
        TextField(controller: controller, maxLength: maxLength, minLines: 2, maxLines: 4, decoration: InputDecoration(labelText: label)),
      ]),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        FilledButton(
          onPressed: () {
            final v = controller.text.trim();
            if (v.isNotEmpty) Navigator.pop(context, v);
          },
          child: Text(action),
        ),
      ],
    ),
  );
}

/// Draws the server-rendered QR module grid ("0101…" rows) for a pick-up pass.
class QrMatrix extends StatelessWidget {
  const QrMatrix(this.rows, {super.key, required this.semanticLabel, this.size = 220});

  final List<String> rows;
  final String semanticLabel;
  final double size;

  @override
  Widget build(BuildContext context) => Semantics(
        image: true,
        label: semanticLabel,
        child: Container(
          color: Colors.white,
          width: size,
          height: size,
          child: CustomPaint(painter: _QrPainter(rows)),
        ),
      );
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.rows);
  final List<String> rows;
  static const quiet = 4;

  @override
  void paint(Canvas canvas, Size size) {
    if (rows.isEmpty) return;
    final n = rows.length + quiet * 2;
    final cell = size.width / n;
    final paint = Paint()..color = Colors.black;
    for (var y = 0; y < rows.length; y++) {
      final row = rows[y];
      for (var x = 0; x < row.length; x++) {
        if (row.codeUnitAt(x) == 0x31) {
          canvas.drawRect(Rect.fromLTWH((x + quiet) * cell, (y + quiet) * cell, cell + 0.5, cell + 0.5), paint);
        }
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter old) => old.rows != rows;
}

/// Like [Loader], for a section inside an already-scrolling screen: no list
/// or pull-to-refresh of its own, so it can sit in a ListView.
class InlineLoader<T> extends StatefulWidget {
  const InlineLoader({super.key, required this.load, required this.builder});

  final Future<T> Function() load;
  final Widget Function(BuildContext context, T data) builder;

  @override
  State<InlineLoader<T>> createState() => _InlineLoaderState<T>();
}

class _InlineLoaderState<T> extends State<InlineLoader<T>> {
  late Future<T> _future = widget.load();

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<T>(
      future: _future,
      builder: (context, snap) {
        if (snap.connectionState != ConnectionState.done) {
          return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
        }
        if (snap.hasError) {
          final e = snap.error;
          return SectionCard(children: [
            Text(e is ApiException && e.isOffline ? 'You\'re offline. This needs a connection.' : 'Couldn\'t load this.'),
            TextButton(
              onPressed: () => setState(() {
                _future = widget.load();
              }),
              child: const Text('Retry'),
            ),
          ]);
        }
        return widget.builder(context, snap.data as T);
      },
    );
  }
}

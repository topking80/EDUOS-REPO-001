import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

const _circulators = {'principal', 'superintendent', 'it_admin', 'librarian'};
final _uuid = RegExp(r'^[0-9a-f-]{36}$', caseSensitive: false);

class _Desk {
  const _Desk(this.inventory, this.activeLoans, this.totals);
  final List<Json> inventory, activeLoans;
  final Json totals;
}

/// Library desk: check in and check out by barcode. Works with Bluetooth
/// keyboard-style scanners: scan into the focused field; Enter submits.
class LibraryDeskScreen extends StatefulWidget {
  const LibraryDeskScreen({super.key});

  @override
  State<LibraryDeskScreen> createState() => _LibraryDeskScreenState();
}

class _LibraryDeskScreenState extends State<LibraryDeskScreen> {
  Key _key = UniqueKey();
  final _checkIn = TextEditingController(), _book = TextEditingController(), _borrower = TextEditingController();
  final _checkInFocus = FocusNode();
  late DateTime _due = DateUtils.dateOnly(DateTime.now()).add(const Duration(days: 14));
  String _status = 'Ready for scan.';
  bool _ok = true;

  @override
  void dispose() {
    for (final c in [_checkIn, _book, _borrower]) {
      c.dispose();
    }
    _checkInFocus.dispose();
    super.dispose();
  }

  void _say(String msg, {bool good = true}) {
    setState(() {
      _status = msg;
      _ok = good;
    });
    SemanticsService.announce(msg, TextDirection.ltr);
  }

  String _err(ApiException e, String fallback) => e.isOffline ? 'You\'re offline. The desk needs a connection.' : (e.error ?? fallback).replaceAll('_', ' ');

  Future<void> _return(_Desk d) async {
    final code = _checkIn.text.trim();
    if (code.isEmpty) return _say('Scan a barcode first.', good: false);
    final item = d.inventory.where((x) => x['barcode'] == code).firstOrNull;
    if (item == null) return _say('No matching book barcode in this school\'s inventory.', good: false);
    final loan = d.activeLoans.where((x) => x['item_id'] == item['id']).firstOrNull;
    if (loan == null) return _say('No active loan for this book.', good: false);
    try {
      await AppScope.read(context).api.post('/api/library/loans/${loan['id']}/return', {'disposition': 'returned'});
      _checkIn.clear();
      _say('Returned: ${item['title']}');
      setState(() => _key = UniqueKey());
      _checkInFocus.requestFocus();
    } on ApiException catch (e) {
      _say(_err(e, 'Return could not be completed.'), good: false);
    }
  }

  Future<void> _checkout(_Desk d) async {
    final api = AppScope.read(context).api;
    final item = d.inventory.where((x) => x['barcode'] == _book.text.trim()).firstOrNull;
    if (item == null) return _say('Book barcode not found.', good: false);
    var borrower = _borrower.text.trim();
    if (borrower.isEmpty) return _say('Scan the borrower\'s card first.', good: false);
    try {
      if (!_uuid.hasMatch(borrower)) {
        borrower = str(obj((await api.post('/api/library/borrower-cards/lookup', {'barcode': borrower})).data)['borrowerUserId']);
        if (borrower.isEmpty) return _say('Student card was not recognized.', good: false);
      }
      await api.post('/api/library/loans/checkout', {
        'itemId': item['id'],
        'borrowerUserId': borrower,
        'dueAt': DateTime(_due.year, _due.month, _due.day, 23, 59).toUtc().toIso8601String(),
      });
      _book.clear();
      _borrower.clear();
      _say('Checked out: ${item['title']}');
      setState(() => _key = UniqueKey());
    } on ApiException catch (e) {
      _say(e.status == 404 ? 'Student card was not recognized.' : _err(e, 'Checkout could not be completed.'), good: false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final circulate = _circulators.contains(app.me?.role);
    return Loader<_Desk>(
      key: _key,
      load: () async {
        Future<Map<String, Object?>?> optional(String path) async {
          try {
            return await app.api.get(path);
          } on ApiException catch (e) {
            if (e.isUnauthorized || e.isOffline) rethrow;
            return null;
          }
        }

        final r = await Future.wait([optional('/api/library/inventory'), optional('/api/library/loans'), optional('/api/library/summary')]);
        return _Desk(objs(r[0]?['data']), objs(r[1]?['data']).where((x) => x['returned_at'] == null).toList(), obj(obj(r[2]?['data'])['totals']));
      },
      builder: (context, d, _) => ListView(padding: const EdgeInsets.all(16), children: [
        Semantics(header: true, child: Text('Library desk', style: Theme.of(context).textTheme.titleLarge)),
        Text('Pair a Bluetooth barcode scanner as a keyboard, tap a field and scan. Most scanners send Enter automatically.', style: Theme.of(context).textTheme.bodySmall),
        const SizedBox(height: 8),
        SectionCard(children: [
          Row(children: [
            Expanded(child: StatTile(integer(d.totals['titles']), 'titles')),
            Expanded(child: StatTile(integer(d.totals['copies']), 'copies')),
            Expanded(child: StatTile(integer(d.totals['available']), 'available')),
            Expanded(child: StatTile(d.activeLoans.length, 'checked out')),
          ]),
        ]),
        Semantics(
          liveRegion: true,
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: _ok ? Theme.of(context).colorScheme.secondaryContainer : Theme.of(context).colorScheme.errorContainer,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Text(_status),
          ),
        ),
        SectionCard(title: 'Check in a book', children: [
          TextField(
            controller: _checkIn,
            focusNode: _checkInFocus,
            autocorrect: false,
            textInputAction: TextInputAction.done,
            onSubmitted: (_) => _return(d),
            decoration: const InputDecoration(labelText: 'Book barcode for check-in'),
          ),
          const SizedBox(height: 8),
          FilledButton(onPressed: () => _return(d), child: const Text('Check in')),
        ]),
        if (circulate)
          SectionCard(title: 'Check out a book', children: [
            TextField(controller: _book, autocorrect: false, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'Book barcode for checkout')),
            TextField(
              controller: _borrower,
              autocorrect: false,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _checkout(d),
              decoration: const InputDecoration(labelText: 'Borrower card or account ID'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              icon: const Icon(Icons.event),
              label: Text('Due ${fmtDay(_due)}'),
              onPressed: () async {
                final today = DateUtils.dateOnly(DateTime.now());
                final p = await showDatePicker(context: context, initialDate: _due, firstDate: today, lastDate: today.add(const Duration(days: 365)));
                if (p != null) setState(() => _due = p);
              },
            ),
            FilledButton(onPressed: () => _checkout(d), child: const Text('Check out')),
          ]),
        SectionCard(title: 'Active loans', children: [
          if (d.activeLoans.isEmpty) const EmptyState('No active loans.'),
          for (final l in d.activeLoans.take(100))
            ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              title: Text(str(l['title']), style: const TextStyle(fontWeight: FontWeight.w600)),
              subtitle: Text('${str(l['barcode'], str(l['isbn'], 'No barcode'))} · due ${fmtDay(date(l['due_at']))}'),
              trailing: l['overdue'] == true ? const StatusChip('absent', text: 'Overdue') : const StatusChip('expected', text: 'Checked out'),
            ),
        ]),
      ]),
    );
  }
}

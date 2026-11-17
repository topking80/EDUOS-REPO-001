import 'dart:math';

import 'package:flutter/material.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// 37.7.0 commerce, SANDBOX ONLY. School event tickets for families
/// (GET /api/commerce/shop, POST /api/events/:id/tickets) and, for parents,
/// sandbox payment (POST /api/commerce/payments/:id/confirm) and receipts
/// (GET /api/commerce/my). Students can get free tickets; only a parent or
/// guardian can pay. No card is taken and no real money moves.
class TicketsScreen extends StatelessWidget {
  const TicketsScreen({super.key});

  static Future<void> open(BuildContext context) =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const TicketsScreen()));

  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('Tickets')), body: const TicketsBody());
}

class TicketsData {
  const TicketsData({required this.status, required this.events, required this.tickets, required this.payments});
  final Json status;
  final List<Json> events;
  final List<Json> tickets;
  final List<Json> payments;
  bool get enabled => boolean(status['enabled']);
  bool get canPay => boolean(status['canPay']);
}

String money(Object? cents, [String currency = 'USD']) {
  final c = integer(cents), a = c.abs();
  final s = '${a ~/ 100}.${(a % 100).toString().padLeft(2, '0')}';
  return '${c < 0 ? '-' : ''}${currency == 'USD' ? '\$' : '$currency '}$s';
}

String ticketError(ApiException e) => switch (e.error) {
      'paid_ticketing_not_configured' => 'Paid tickets aren\'t turned on for your district.',
      'guardian_payment_required' => 'A parent or guardian has to pay for tickets.',
      'ticket_capacity_exceeded' => 'Not enough tickets left.',
      'guardian_school_link_required' => 'Tickets are for families of this school.',
      'ticket_type_not_available' || 'event_not_available' => 'These tickets are no longer on sale.',
      _ when e.isOffline => 'You\'re offline. Connect to get tickets.',
      _ => 'Could not get tickets. Please try again.',
    };

class TicketsBody extends StatelessWidget {
  const TicketsBody({super.key});

  static Future<TicketsData> load(ApiClient api, {required bool parent}) async {
    final results = await Future.wait([
      api.get('/api/commerce/status'),
      api.get('/api/commerce/shop'),
      api.get('/api/my/tickets'),
      if (parent) api.get('/api/commerce/my'),
    ]);
    return TicketsData(
      status: obj(results[0]['data']),
      events: objs(obj(results[1]['data'])['events']),
      tickets: objs(results[2]['data']),
      payments: parent ? objs(obj(results[3]['data'])['payments']) : const [],
    );
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.read(context);
    final parent = app.me?.role == 'parent';
    return Loader<TicketsData>(
      load: () => load(app.api, parent: parent),
      builder: (context, d, reload) => ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Notice(d.enabled
              ? 'Sandbox payments: no real money moves and no card is charged.'
              : 'Paid tickets are off. No payment is collected here.'),
          if (!parent) const Notice('Students can get free tickets. A parent or guardian buys paid ones.'),
          if (d.events.isEmpty)
            const SectionCard(title: 'On sale', children: [EmptyState('No tickets on sale right now.')])
          else
            for (final ev in d.events)
              SectionCard(title: str(ev['title'], 'School event'), children: [
                Text([fmtDay(date(ev['startsAt'])), fmtTime(date(ev['startsAt'])), str(ev['venue']), str(ev['school'])]
                    .where((v) => v.isNotEmpty)
                    .join(' · '), style: Theme.of(context).textTheme.bodySmall),
                for (final t in objs(ev['ticketTypes'])) _TicketTypeRow(event: ev, type: t, data: d, onChanged: reload),
              ]),
          SectionCard(title: 'My tickets', children: [
            if (d.tickets.isEmpty) const EmptyState('No tickets yet.'),
            for (final t in d.tickets)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.confirmation_number_outlined),
                title: Text(str(t['event_title'])),
                subtitle: Text(fmtDay(date(t['starts_at']))),
                trailing: StatusChip(str(t['status']), text: str(t['status']).replaceAll('_', ' ')),
              ),
          ]),
          if (parent)
            SectionCard(title: 'Payments & receipts', children: [
              if (d.payments.isEmpty) const EmptyState('No payments.'),
              for (final p in d.payments)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text('${str(p['title'], 'Purchase')} · ${money(p['amountCents'], str(p['currency'], 'USD'))}'),
                  subtitle: Text([
                    str(p['status']).replaceAll('_', ' '),
                    for (final r in objs(p['receipts'])) '${str(r['kind']) == 'refund' ? 'Refund' : 'Receipt'} ${str(r['number'])}',
                  ].join(' · ')),
                ),
            ]),
        ],
      ),
    );
  }
}

class _TicketTypeRow extends StatefulWidget {
  const _TicketTypeRow({required this.event, required this.type, required this.data, required this.onChanged});
  final Json event;
  final Json type;
  final TicketsData data;
  final Future<void> Function() onChanged;

  @override
  State<_TicketTypeRow> createState() => _TicketTypeRowState();
}

class _TicketTypeRowState extends State<_TicketTypeRow> {
  int _qty = 1;
  bool _busy = false;
  static final _random = Random.secure();
  String _key() => List.generate(16, (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0')).join();

  Future<void> _buy() async {
    if (_busy) return;
    setState(() => _busy = true);
    final api = AppScope.read(context).api;
    try {
      final r = await api.post('/api/events/${str(widget.event['id'])}/tickets',
          {'ticketTypeId': str(widget.type['id']), 'quantity': _qty, 'idempotencyKey': _key()});
      if (!mounted) return;
      final d = obj(r.data);
      final payment = obj(d['payment']);
      if (payment.isNotEmpty) {
        await showModalBottomSheet<void>(context: context, isScrollControlled: true, builder: (_) => SandboxPaySheet(payment: payment, api: api));
      } else {
        await showTickets(context, objs(d['tickets']));
      }
      await widget.onChanged();
    } on ApiException catch (e) {
      if (mounted) toast(context, ticketError(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.type, d = widget.data;
    final price = integer(t['priceCents']), left = integer(t['available']), paid = price > 0;
    final blocked = left < 1
        ? 'Sold out'
        : paid && !d.canPay
            ? 'Ask a parent or guardian to buy this.'
            : paid && !d.enabled
                ? 'Paid tickets are off'
                : null;
    final most = min(10, max(left, 1));
    return ListTile(
      contentPadding: EdgeInsets.zero,
      title: Text('${str(t['name'])} · ${paid ? money(price, str(t['currency'], 'USD')) : 'Free'}'),
      subtitle: Text(blocked ?? '$left left'),
      trailing: blocked != null
          ? null
          : Row(mainAxisSize: MainAxisSize.min, children: [
              DropdownButton<int>(
                value: min(_qty, most),
                items: [for (var i = 1; i <= most; i++) DropdownMenuItem(value: i, child: Text('$i'))],
                onChanged: (v) => setState(() => _qty = v ?? 1),
              ),
              const SizedBox(width: 8),
              FilledButton(onPressed: _busy ? null : _buy, child: Text(paid ? 'Buy' : 'Get')),
            ]),
    );
  }
}

/// Shows issued ticket codes once (QR when the server sent the module rows).
Future<void> showTickets(BuildContext context, List<Json> tickets) => Navigator.of(context).push(MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) => Scaffold(
        appBar: AppBar(title: const Text('Your tickets')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          const Notice('Show these at the gate. They\'re shown once: EduOS keeps only a fingerprint of each code, so screenshot them now.'),
          for (final (i, t) in tickets.indexed) ...[
            if (t['qr'] is List)
              Center(child: QrMatrix([for (final r in t['qr'] as List) '$r'], semanticLabel: 'QR code for ticket ${i + 1}', size: 240)),
            Center(child: SelectableText(str(t['code']), style: const TextStyle(fontFamily: 'monospace'))),
            const SizedBox(height: 16),
          ],
        ]),
      ),
    ));

/// Confirms a SANDBOX payment: pay or simulate a decline. Nothing is charged.
class SandboxPaySheet extends StatefulWidget {
  const SandboxPaySheet({super.key, required this.payment, required this.api});
  final Json payment;
  final ApiClient api;

  @override
  State<SandboxPaySheet> createState() => _SandboxPaySheetState();
}

class _SandboxPaySheetState extends State<SandboxPaySheet> {
  bool _busy = false;
  String? _result;

  Future<void> _confirm(String outcome) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = obj((await widget.api.post('/api/commerce/payments/${str(widget.payment['id'])}/confirm', {'testOutcome': outcome})).data);
      if (!mounted) return;
      switch (str(r['status'])) {
        case 'succeeded':
          final receipt = obj(r['receipt']);
          final navigator = Navigator.of(context);
          navigator.pop();
          toast(navigator.context, 'Paid (sandbox). Receipt ${str(receipt['number'])}.');
          await showTickets(navigator.context, objs(r['tickets']));
        case 'declined':
          setState(() => _result = 'Declined (sandbox). Nothing was charged and your seats were released.');
        default:
          setState(() => _result = str(r['reason'], 'The hold ran out. Start again.'));
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _result = e.isOffline ? 'You\'re offline. Connect to pay.' : 'Could not confirm the payment.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.payment;
    final held = date(p['holdExpiresAt']);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Pay ${money(p['amountCents'], str(p['currency'], 'USD'))}', style: Theme.of(context).textTheme.titleLarge),
          if (held != null) Text('Seats are held until ${fmtTime(held)}.'),
          const SizedBox(height: 8),
          const Notice('Sandbox: pick an outcome. No card, no real money.'),
          if (_result != null) ...[const SizedBox(height: 8), Text(_result!)],
          const SizedBox(height: 12),
          if (_result == null) ...[
            FilledButton(onPressed: _busy ? null : () => _confirm('sandbox_success'), child: const Text('Pay (sandbox)')),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: _busy ? null : () => _confirm('sandbox_decline'), child: const Text('Simulate a decline')),
          ] else
            OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close')),
        ]),
      ),
    );
  }
}

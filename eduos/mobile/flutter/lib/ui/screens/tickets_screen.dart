import 'dart:math';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/app_scope.dart';
import '../../core/api_client.dart';
import '../../core/format.dart';
import '../../core/models.dart';
import '../widgets.dart';

/// 37.7.0 commerce. School event tickets for families
/// (GET /api/commerce/shop, POST /api/events/:id/tickets) and, for parents,
/// payment (POST /api/commerce/payments/:id/confirm) and receipts
/// (GET /api/commerce/my). Students can get free tickets; only a parent or
/// guardian can pay. 37.7.1: the district picks its payment options; with more
/// than one, families choose ("Pay with"). The sandbox confirms pretend
/// payments here; PayPal, Square and BTCPay open the processor's own page in
/// the browser, then "I've paid" asks EduOS to check. The app never takes a card.
class TicketsScreen extends StatelessWidget {
  const TicketsScreen({super.key});

  static Future<void> open(BuildContext context) =>
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const TicketsScreen()));

  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: const Text('Tickets')), body: const TicketsBody());
}

class TicketsData {
  TicketsData({required this.status, required this.events, required this.tickets, required this.payments})
      : method = ValueNotifier<String?>(str(status['defaultMethod']).isEmpty ? null : str(status['defaultMethod']));
  final Json status;
  final List<Json> events;
  final List<Json> tickets;
  final List<Json> payments;

  /// The family's "Pay with" choice (the district's default to start).
  final ValueNotifier<String?> method;
  bool get enabled => boolean(status['enabled']);
  bool get canPay => boolean(status['canPay']);
  List<Json> get methods => objs(status['methods']);
  String get banner {
    final note = str(status['note']);
    if (!enabled) return 'Paid tickets are off. No payment is collected here.';
    if (note.isNotEmpty) return note;
    return 'Sandbox payments: no real money moves and no card is charged.';
  }
}

const processorLabels = {'sandbox': 'Sandbox', 'paypal': 'PayPal', 'square': 'Square', 'btcpay': 'BTCPay Server'};

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
      'payment_method_not_available' => 'That payment option isn\'t offered. Pick another.',
      'payment_adapter_not_available' => 'That payment option isn\'t available in the app yet.',
      'live_payments_disabled' => 'Live payments are switched off for now.',
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
          Notice(d.banner),
          if (!parent) const Notice('Students can get free tickets. A parent or guardian buys paid ones.'),
          if (parent && d.enabled && d.methods.length > 1) _MethodPicker(data: d),
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

class _MethodPicker extends StatelessWidget {
  const _MethodPicker({required this.data});
  final TicketsData data;

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<String?>(
        valueListenable: data.method,
        builder: (context, value, _) => Row(children: [
          const Text('Pay with'),
          const SizedBox(width: 12),
          DropdownButton<String>(
            value: data.methods.any((m) => str(m['method']) == value) ? value : str(data.methods.first['method']),
            items: [
              for (final m in data.methods)
                DropdownMenuItem(
                  value: str(m['method']),
                  child: Text('${str(m['label'])}${str(m['processor']) != 'sandbox' && str(m['mode']) == 'test' ? ' (test)' : ''}'),
                ),
            ],
            onChanged: (v) => data.method.value = v,
          ),
        ]),
      );
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
      final paid = integer(widget.type['priceCents']) > 0, method = widget.data.method.value;
      final r = await api.post('/api/events/${str(widget.event['id'])}/tickets', {
        'ticketTypeId': str(widget.type['id']),
        'quantity': _qty,
        'idempotencyKey': _key(),
        if (paid && method != null) 'paymentMethod': method,
      });
      if (!mounted) return;
      final d = obj(r.data);
      final payment = obj(d['payment']);
      if (payment.isNotEmpty) {
        await showModalBottomSheet<void>(context: context, isScrollControlled: true, builder: (_) => PaySheet(payment: payment, api: api));
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

/// Pays for a held order. Sandbox: pick success or decline, nothing is
/// charged. A processor (PayPal, Square, BTCPay): open its page in the
/// browser, then "I've paid" asks EduOS to check with the processor.
class PaySheet extends StatefulWidget {
  const PaySheet({super.key, required this.payment, required this.api});
  final Json payment;
  final ApiClient api;

  @override
  State<PaySheet> createState() => _PaySheetState();
}

class _PaySheetState extends State<PaySheet> {
  bool _busy = false;
  bool _done = false;
  String? _result;

  String get _provider => str(widget.payment['provider'], 'sandbox');
  bool get _sandbox => _provider == 'sandbox';

  Future<void> _confirm([String? outcome]) async {
    if (_busy) return;
    setState(() => _busy = true);
    try {
      final r = obj((await widget.api.post('/api/commerce/payments/${str(widget.payment['id'])}/confirm', {if (outcome != null) 'testOutcome': outcome})).data);
      if (!mounted) return;
      switch (str(r['status'])) {
        case 'succeeded':
          final receipt = obj(r['receipt']);
          final navigator = Navigator.of(context);
          navigator.pop();
          toast(navigator.context, '${_sandbox ? 'Paid (sandbox)' : 'Paid'}. Receipt ${str(receipt['number'])}.');
          await showTickets(navigator.context, objs(r['tickets']));
        case 'declined':
          setState(() {
            _done = true;
            _result = '${_sandbox ? 'Declined (sandbox)' : 'Declined'}. Nothing was charged and your seats were released.';
          });
        case 'pending':
          setState(() => _result = 'The payment isn\'t finished yet. If you completed it, wait a moment and check again.');
        default:
          setState(() {
            _done = true;
            _result = [
              str(r['reason'], 'The hold ran out. Start again.'),
              if (boolean(r['paidAfterHold'])) 'Your payment arrived after the hold ended. The district will refund it.',
            ].join(' ');
          });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _result = e.isOffline ? 'You\'re offline. Connect to pay.' : 'Could not confirm the payment.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _open() async {
    final uri = Uri.tryParse(str(widget.payment['redirectUrl']));
    if (uri == null || uri.scheme != 'https' || !await launchUrl(uri, mode: LaunchMode.externalApplication)) {
      if (mounted) setState(() => _result = 'Could not open the payment page.');
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.payment;
    final held = date(p['holdExpiresAt']);
    final where = processorLabels[_provider] ?? 'the payment page';
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('Pay ${money(p['amountCents'], str(p['currency'], 'USD'))}', style: Theme.of(context).textTheme.titleLarge),
          if (held != null) Text('Seats are held until ${fmtTime(held)}.'),
          const SizedBox(height: 8),
          Notice(_sandbox
              ? 'Sandbox: pick an outcome. No card, no real money.'
              : boolean(p['test'])
                  ? 'Test mode: $where\'s test system. No real money moves.'
                  : 'You\'ll pay on $where\'s secure page. EduOS never sees your card or login.'),
          if (_result != null) ...[const SizedBox(height: 8), Text(_result!)],
          const SizedBox(height: 12),
          if (_done)
            OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Close'))
          else if (_sandbox) ...[
            FilledButton(onPressed: _busy ? null : () => _confirm('sandbox_success'), child: const Text('Pay (sandbox)')),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: _busy ? null : () => _confirm('sandbox_decline'), child: const Text('Simulate a decline')),
          ] else ...[
            if (str(p['redirectUrl']).isNotEmpty) FilledButton(onPressed: _busy ? null : _open, child: Text('Continue to $where')),
            const SizedBox(height: 8),
            OutlinedButton(onPressed: _busy ? null : () => _confirm(), child: const Text('I\'ve paid: check status')),
          ],
        ]),
      ),
    );
  }
}

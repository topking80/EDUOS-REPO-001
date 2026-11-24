// A student's accepted history as a timeline by school year (TC-04,
// GET /api/history/portfolio): filters, search, paging and photos.
import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/format.dart';
import '../../../core/history_models.dart';
import '../../../core/models.dart';
import '../../widgets.dart';
import 'history_widgets.dart';

class HistoryTimelineScreen extends StatelessWidget {
  const HistoryTimelineScreen({super.key, this.studentId, this.title = 'History'});
  final String? studentId;
  final String title;

  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: Text(title)), body: HistoryTimeline(studentId: studentId));
}

/// The timeline itself (also the learner's "My history" tab).
class HistoryTimeline extends StatefulWidget {
  const HistoryTimeline({super.key, this.studentId});
  final String? studentId;

  @override
  State<HistoryTimeline> createState() => _HistoryTimelineState();
}

class _HistoryTimelineState extends State<HistoryTimeline> {
  String? _year, _kind, _type;
  final _search = TextEditingController();
  Timer? _debounce;
  PortfolioPage? _first;
  final List<PortfolioItem> _items = [];
  String? _cursor;
  Object? _error;
  bool _loading = true, _more = false;
  PortfolioItem? _selected;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    super.dispose();
  }

  String _path(String? cursor) {
    final q = <String, String>{
      if (widget.studentId != null) 'studentId': widget.studentId!,
      if (_year != null) 'year': _year!,
      if (_kind != null) 'kind': _kind!,
      if (_type != null) 'type': _type!,
      if (_search.text.trim().isNotEmpty) 'q': _search.text.trim(),
      if (cursor != null) 'cursor': cursor,
    };
    return Uri(path: '/api/history/portfolio', queryParameters: q.isEmpty ? null : q).toString();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final page = PortfolioPage.fromJson(obj((await AppScope.read(context).api.get(_path(null)))['data']));
      if (!mounted) return;
      setState(() {
        _first = page;
        _items
          ..clear()
          ..addAll(page.items);
        _cursor = page.nextCursor;
        _loading = false;
        if (_selected != null && !_items.any((i) => i.id == _selected!.id)) _selected = null;
      });
    } on Object catch (e) {
      if (mounted) {
        setState(() {
          _error = e;
          _loading = false;
        });
      }
    }
  }

  Future<void> _loadMore() async {
    if (_cursor == null || _more) return;
    setState(() => _more = true);
    try {
      final page = PortfolioPage.fromJson(obj((await AppScope.read(context).api.get(_path(_cursor)))['data']));
      if (mounted) {
        setState(() {
          _items.addAll(page.items);
          _cursor = page.nextCursor;
        });
      }
    } on ApiException {
      if (mounted) toast(context, 'Couldn\'t load more.');
    } finally {
      if (mounted) setState(() => _more = false);
    }
  }

  void _filter(void Function() change) {
    setState(change);
    unawaited(_load());
  }

  void _open(PortfolioItem item) {
    if (isWide(context)) {
      setState(() => _selected = item);
    } else {
      Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => HistoryItemScreen(item: item)));
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _first == null) return const Center(child: CircularProgressIndicator());
    if (_error != null && _first == null) {
      final e = _error;
      final notFound = e is ApiException && (e.status == 404 || e.status == 400);
      return ReadableList(children: [
        SectionCard(children: [
          Text(notFound
              ? 'No history to show yet.'
              : e is ApiException && e.isOffline
                  ? 'You\'re offline. History needs a connection.'
                  : 'Couldn\'t load the history.'),
          if (!notFound) TextButton(onPressed: _load, child: const Text('Retry')),
        ]),
      ]);
    }
    final page = _first!;
    final list = _list(context, page);
    if (!isWide(context)) return list;
    return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Expanded(flex: 5, child: list),
      const VerticalDivider(width: 1),
      Expanded(
        flex: 4,
        child: _selected == null ? const Center(child: EmptyState('Choose an item to see it here.')) : HistoryItemView(key: ValueKey(_selected!.id), item: _selected!),
      ),
    ]);
  }

  Widget _list(BuildContext context, PortfolioPage page) {
    final byYear = <String, List<PortfolioItem>>{};
    for (final i in _items) {
      byYear.putIfAbsent(i.schoolYear, () => []).add(i);
    }
    Widget drop(String label, String? value, List<String> options, Map<String, String> names, void Function(String?) set) => SizedBox(
          width: 190,
          child: DropdownButtonFormField<String?>(
            value: value,
            isExpanded: true,
            decoration: InputDecoration(labelText: label, isDense: true),
            items: [
              const DropdownMenuItem<String?>(value: null, child: Text('All')),
              for (final o in options) DropdownMenuItem<String?>(value: o, child: Text(names[o] ?? o)),
            ],
            onChanged: (v) => _filter(() => set(v)),
          ),
        );
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(16), children: [
        Text('${page.studentName} · ${page.total} item${page.total == 1 ? '' : 's'}', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 8),
        Wrap(spacing: 12, runSpacing: 12, children: [
          drop('School year', _year, page.years, const {}, (v) => _year = v),
          drop('Kind', _kind, page.kinds, historyKindText, (v) => _kind = v),
          drop('Type', _type, page.types, historyTypeText, (v) => _type = v),
          SizedBox(
            width: 260,
            child: TextField(
              controller: _search,
              maxLength: 100,
              decoration: const InputDecoration(labelText: 'Search', isDense: true, prefixIcon: Icon(Icons.search), counterText: ''),
              onChanged: (_) {
                _debounce?.cancel();
                _debounce = Timer(const Duration(milliseconds: 400), _load);
              },
            ),
          ),
        ]),
        if (_loading) const LinearProgressIndicator(minHeight: 2),
        const SizedBox(height: 12),
        if (_items.isEmpty) const EmptyState('Nothing matches.'),
        for (final e in byYear.entries) ...[
          Padding(
            padding: const EdgeInsets.only(top: 8, bottom: 4),
            child: Semantics(header: true, child: Text(e.key, style: Theme.of(context).textTheme.titleSmall)),
          ),
          for (final i in e.value) _ItemCard(item: i, selected: _selected?.id == i.id, onTap: () => _open(i)),
        ],
        if (_cursor != null) Center(child: TextButton(onPressed: _more ? null : _loadMore, child: Text(_more ? 'Loading…' : 'Show more'))),
      ]),
    );
  }
}

class _ItemCard extends StatelessWidget {
  const _ItemCard({required this.item, required this.onTap, this.selected = false});
  final PortfolioItem item;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      key: ValueKey('history-${item.id}'),
      color: selected ? scheme.secondaryContainer : null,
      margin: const EdgeInsets.only(bottom: 8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            if (item.photos.isNotEmpty) ...[
              ClipRRect(borderRadius: BorderRadius.circular(8), child: HistoryPhotoView(item.photos.first, size: 64)),
              const SizedBox(width: 12),
            ],
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(item.title, style: const TextStyle(fontWeight: FontWeight.w600)),
                Text([historyKindText[item.kind] ?? item.kind, historyTypeText[item.entryType] ?? item.entryType, fmtDay(item.occurredAt)].join(' · '), style: Theme.of(context).textTheme.bodySmall),
                if (item.body.isNotEmpty) Text(item.body, maxLines: 2, overflow: TextOverflow.ellipsis),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}

class HistoryItemScreen extends StatelessWidget {
  const HistoryItemScreen({super.key, required this.item});
  final PortfolioItem item;

  @override
  Widget build(BuildContext context) => Scaffold(appBar: AppBar(title: Text(historyTypeText[item.entryType] ?? 'History item')), body: HistoryItemView(item: item));
}

class HistoryItemView extends StatelessWidget {
  const HistoryItemView({super.key, required this.item});
  final PortfolioItem item;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ReadableList(children: [
      Semantics(header: true, child: Text(item.title, style: theme.textTheme.headlineSmall)),
      const SizedBox(height: 4),
      Wrap(spacing: 8, runSpacing: 4, children: [
        StatusChip(item.kind, text: historyKindText[item.kind] ?? item.kind, tone: ChipTone.info),
        Text('${historyTypeText[item.entryType] ?? item.entryType} · ${fmtDay(item.occurredAt)} · ${item.schoolYear}'),
      ]),
      if (item.authorName != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text('Added by ${item.authorName}')),
      if (item.transferredFrom != null) Notice('Came with the history from ${item.transferredFrom}.'),
      const SizedBox(height: 12),
      if (item.body.isNotEmpty) SelectableText(item.body),
      PhotoStrip(item.photos, size: 140),
    ]);
  }
}

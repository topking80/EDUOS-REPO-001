import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/app_scope.dart';
import '../../../core/api_client.dart';
import '../../../core/history_models.dart';

/// Breakpoints shared by the history screens (Material window size classes).
const compactMaxWidth = 600.0;
const expandedMinWidth = 840.0;

bool isWide(BuildContext context) => MediaQuery.sizeOf(context).width >= expandedMinWidth;

/// Keeps long reading content at a comfortable width on tablets and desktops.
class ReadableWidth extends StatelessWidget {
  const ReadableWidth({super.key, required this.child, this.maxWidth = 920});
  final Widget child;
  final double maxWidth;

  @override
  Widget build(BuildContext context) => Align(
        alignment: Alignment.topCenter,
        child: ConstrainedBox(constraints: BoxConstraints(maxWidth: maxWidth), child: child),
      );
}

/// A ListView whose content is centred and width-limited on big screens.
class ReadableList extends StatelessWidget {
  const ReadableList({super.key, required this.children, this.padding = const EdgeInsets.all(16)});
  final List<Widget> children;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => ListView(
        padding: padding,
        children: [for (final c in children) ReadableWidth(child: c)],
      );
}

/// Signed photo URLs from GET /api/history/photos/:id last 60 seconds; this
/// keeps them for 45 so scrolling back doesn't re-ask, and never longer.
class PhotoUrlCache {
  PhotoUrlCache({DateTime Function()? clock}) : _clock = clock ?? DateTime.now;
  final DateTime Function() _clock;
  static const ttl = Duration(seconds: 45);
  final Map<String, (Uri, DateTime)> _urls = {};
  final Map<String, Future<Uri?>> _pending = {};

  Future<Uri?> resolve(ApiClient api, String assetId) {
    final hit = _urls[assetId];
    if (hit != null && _clock().difference(hit.$2) < ttl) return Future.value(hit.$1);
    return _pending[assetId] ??= api.location('/api/history/photos/$assetId').then((uri) {
      if (uri != null) _urls[assetId] = (uri, _clock());
      return uri;
    }).whenComplete(() => _pending.remove(assetId));
  }

  void clear() => _urls.clear();
}

final photoUrls = PhotoUrlCache();

/// One history photo. The app asks EduOS (with the session) where the photo
/// is, then loads that short-lived link without any EduOS credentials.
class HistoryPhotoView extends StatefulWidget {
  const HistoryPhotoView(this.photo, {super.key, this.fit = BoxFit.cover, this.size});
  final HistoryPhoto photo;
  final BoxFit fit;
  final double? size;

  @override
  State<HistoryPhotoView> createState() => _HistoryPhotoViewState();
}

class _HistoryPhotoViewState extends State<HistoryPhotoView> {
  Future<Uri?>? _url;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _url ??= photoUrls.resolve(AppScope.read(context).api, widget.photo.id).catchError((Object _) => null);
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final placeholder = Container(
      width: widget.size,
      height: widget.size,
      color: scheme.surfaceContainerHighest,
      alignment: Alignment.center,
      child: Icon(Icons.photo_outlined, color: scheme.onSurfaceVariant),
    );
    return Semantics(
      image: true,
      label: widget.photo.label,
      child: FutureBuilder<Uri?>(
        future: _url,
        builder: (context, snap) {
          final url = snap.data;
          if (url == null) return placeholder;
          return Image.network(
            url.toString(),
            width: widget.size,
            height: widget.size,
            fit: widget.fit,
            excludeFromSemantics: true,
            errorBuilder: (_, __, ___) => placeholder,
          );
        },
      ),
    );
  }
}

/// A row of photo thumbnails; tapping opens the full-screen viewer.
class PhotoStrip extends StatelessWidget {
  const PhotoStrip(this.photos, {super.key, this.size = 96});
  final List<HistoryPhoto> photos;
  final double size;

  @override
  Widget build(BuildContext context) {
    if (photos.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Wrap(spacing: 8, runSpacing: 8, children: [
        for (var i = 0; i < photos.length; i++)
          InkWell(
            borderRadius: BorderRadius.circular(8),
            onTap: () => openPhotoViewer(context, photos, i),
            child: ClipRRect(borderRadius: BorderRadius.circular(8), child: HistoryPhotoView(photos[i], size: size)),
          ),
      ]),
    );
  }
}

Future<void> openPhotoViewer(BuildContext context, List<HistoryPhoto> photos, int start) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => PhotoViewerScreen(photos: photos, start: start)));

/// Full-screen photos: swipe, arrow keys or the buttons (D-pad on a TV).
class PhotoViewerScreen extends StatefulWidget {
  const PhotoViewerScreen({super.key, required this.photos, this.start = 0});
  final List<HistoryPhoto> photos;
  final int start;

  @override
  State<PhotoViewerScreen> createState() => _PhotoViewerScreenState();
}

class _PhotoViewerScreenState extends State<PhotoViewerScreen> {
  late final PageController _pages = PageController(initialPage: widget.start);
  late int _index = widget.start;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  void _step(int by) {
    final next = (_index + by).clamp(0, widget.photos.length - 1);
    if (next != _index) unawaited(_pages.animateToPage(next, duration: const Duration(milliseconds: 250), curve: Curves.easeOut));
  }

  @override
  Widget build(BuildContext context) {
    final photo = widget.photos[_index];
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.arrowLeft): () => _step(-1),
        const SingleActivator(LogicalKeyboardKey.arrowRight): () => _step(1),
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          backgroundColor: Colors.black,
          appBar: AppBar(
            backgroundColor: Colors.black,
            foregroundColor: Colors.white,
            title: Text('${_index + 1} of ${widget.photos.length}'),
          ),
          body: Column(children: [
            Expanded(
              child: PageView.builder(
                controller: _pages,
                itemCount: widget.photos.length,
                onPageChanged: (i) => setState(() => _index = i),
                itemBuilder: (_, i) => InteractiveViewer(child: Center(child: HistoryPhotoView(widget.photos[i], fit: BoxFit.contain))),
              ),
            ),
            if (photo.caption?.isNotEmpty ?? false) Padding(padding: const EdgeInsets.all(16), child: Text(photo.caption!, style: const TextStyle(color: Colors.white))),
            if (widget.photos.length > 1)
              Row(mainAxisAlignment: MainAxisAlignment.center, children: [
                IconButton(tooltip: 'Previous photo', color: Colors.white, onPressed: _index > 0 ? () => _step(-1) : null, icon: const Icon(Icons.chevron_left)),
                IconButton(tooltip: 'Next photo', color: Colors.white, onPressed: _index < widget.photos.length - 1 ? () => _step(1) : null, icon: const Icon(Icons.chevron_right)),
              ]),
          ]),
        ),
      ),
    );
  }
}

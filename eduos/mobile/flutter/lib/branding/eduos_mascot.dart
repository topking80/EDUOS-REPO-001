import 'package:flutter/material.dart';
import 'package:rive/rive.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'dart:async';

import 'eduos_mascot_events.dart';

import 'eduos_brand_theme.dart';

const eduOsMascotAsset = 'assets/branding/eduos_mascot.riv';
const eduOsMascotArtboard = 'EduOS_Mascot';
const eduOsMascotStateMachine = 'Character_Controller';

enum EduMascotAction { none, greet, celebrate, help }

/// Reusable, lifecycle-aware EduOS mascot.
///
/// Required Rive state-machine inputs:
/// onGreet, onSuccess, onError (triggers); mood, lookX, lookY (numbers).
/// Missing inputs are tolerated so a partially-authored asset cannot crash
/// the host app. The asset is bundled locally; no runtime network fetch occurs.
class EduOsMascot extends StatefulWidget {
  const EduOsMascot({
    super.key,
    this.height = 220,
    this.mood = 0,
    this.lookX = 0,
    this.lookY = 0,
    this.action = EduMascotAction.none,
    this.actionSequence = 0,
    this.onAssetUnavailable,
    this.events,
  });

  final double height;
  final double mood;
  final double lookX;
  final double lookY;
  final EduMascotAction action;
  final int actionSequence;
  final ValueChanged<Object>? onAssetUnavailable;
  /// Optional stream of already-authorized, non-PII app outcome signals.
  final Stream<EduOsMascotSignal>? events;

  @override
  State<EduOsMascot> createState() => _EduOsMascotState();
}

class _EduOsMascotState extends State<EduOsMascot>
    with WidgetsBindingObserver, SingleTickerProviderStateMixin {
  Artboard? _artboard;
  StateMachineController? _machine;
  SMITrigger? _onGreet;
  SMITrigger? _onSuccess;
  SMITrigger? _onError;
  SMINumber? _mood;
  SMINumber? _lookX;
  SMINumber? _lookY;
  bool _foreground = true;
  bool _reduceMotion = false;
  late final AnimationController _fallbackMotion = AnimationController(
    vsync: this, duration: const Duration(milliseconds: 2400),
  )..repeat(reverse: true);
  bool _fallbackActionActive = false;
  EduMascotAction _runtimeAction = EduMascotAction.none;
  StreamSubscription<EduOsMascotSignal>? _eventSubscription;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _runtimeAction = widget.action;
    _loadBundledArt();
    _subscribeToEvents();
  }

  void _subscribeToEvents() {
    _eventSubscription?.cancel();
    _eventSubscription = widget.events?.listen(_handleSignal);
  }

  void _handleSignal(EduOsMascotSignal signal) {
    if (!mounted || !_foreground) return;
    switch (signal) {
      case EduOsMascotSignal.attendanceRecorded:
      case EduOsMascotSignal.riderArrivalConfirmed:
      case EduOsMascotSignal.staffHandoffConfirmed:
      case EduOsMascotSignal.taskCompleted:
        _onSuccess?.fire();
        _runtimeAction = EduMascotAction.celebrate;
        if (_artboard == null) _playFallbackAction();
        break;
      case EduOsMascotSignal.safetyAttentionRequired:
      case EduOsMascotSignal.workflowNeedsHelp:
        _onError?.fire();
        _runtimeAction = EduMascotAction.help;
        if (_artboard == null) _playFallbackAction();
        break;
      case EduOsMascotSignal.welcomeUser:
        _onGreet?.fire();
        _runtimeAction = EduMascotAction.greet;
        if (_artboard == null) _playFallbackAction();
        break;
    }
  }

  Future<void> _loadBundledArt() async {
    try {
      // rive 0.13: RiveFile.asset returns a non-null RiveFile (it throws if the
      // asset can't be read) and RiveFile has no dispose(); the controller does.
      final file = await RiveFile.asset(eduOsMascotAsset);
      if (!mounted) return;

      final artboard = file.artboardByName(eduOsMascotArtboard) ??
          file.mainArtboard;
      final machine = StateMachineController.fromArtboard(
        artboard,
        eduOsMascotStateMachine,
      );
      if (machine == null) {
        throw StateError('Missing state machine: $eduOsMascotStateMachine');
      }
      artboard.addController(machine);

      _fallbackMotion.stop();
      setState(() {
        _artboard = artboard;
        _machine = machine;
        // findInput<T> returns SMIInput<T>?; findSMI<T> returns the typed input.
        _onGreet = machine.findSMI<SMITrigger>('onGreet');
        _onSuccess = machine.findSMI<SMITrigger>('onSuccess');
        _onError = machine.findSMI<SMITrigger>('onError');
        _mood = machine.findSMI<SMINumber>('mood');
        _lookX = machine.findSMI<SMINumber>('lookX');
        _lookY = machine.findSMI<SMINumber>('lookY');
      });
      _applyContinuousInputs();
      switch (_runtimeAction) {
        case EduMascotAction.greet:
          _onGreet?.fire();
          break;
        case EduMascotAction.celebrate:
          _onSuccess?.fire();
          break;
        case EduMascotAction.help:
          _onError?.fire();
          break;
        case EduMascotAction.none:
          break;
      }
      _syncPlayback();
    } on Object catch (error) {
      if (!mounted) return;
      widget.onAssetUnavailable?.call(error);
      if (_runtimeAction != EduMascotAction.none) _playFallbackAction();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduceMotion = MediaQuery.disableAnimationsOf(context);
    _syncPlayback();
  }

  void _syncPlayback() {
    final shouldAnimate = _foreground && !_reduceMotion;
    if (shouldAnimate) {
      _artboard?.play();
      if (_artboard == null && !_fallbackActionActive) {
        _fallbackMotion.repeat(reverse: true);
      }
    } else {
      _artboard?.pause();
      _fallbackMotion.stop();
    }
  }

  @override
  void didUpdateWidget(covariant EduOsMascot oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.events != widget.events) _subscribeToEvents();
    if (oldWidget.mood != widget.mood ||
        oldWidget.lookX != widget.lookX ||
        oldWidget.lookY != widget.lookY) {
      _applyContinuousInputs();
    }
    if (oldWidget.actionSequence != widget.actionSequence) {
      _runtimeAction = widget.action;
      _playFallbackAction();
      switch (widget.action) {
        case EduMascotAction.greet:
          _onGreet?.fire();
          break;
        case EduMascotAction.celebrate:
          _onSuccess?.fire();
          break;
        case EduMascotAction.help:
          _onError?.fire();
          break;
        case EduMascotAction.none:
          break;
      }
    }
  }

  void _playFallbackAction() {
    if (_artboard != null || !_foreground) return;
    _fallbackActionActive = true;
    _fallbackMotion.forward(from: 0).whenCompleteOrCancel(() {
      if (mounted) setState(() => _fallbackActionActive = false);
    });
  }

  void _applyContinuousInputs() {
    _mood?.value = widget.mood.clamp(0, 2).toDouble();
    _lookX?.value = widget.lookX.clamp(-100, 100).toDouble();
    _lookY?.value = widget.lookY.clamp(-100, 100).toDouble();
  }

  /// UI event hooks. Call these from the host app's semantic actions.
  void greet() => _onGreet?.fire();
  void celebrate() => _onSuccess?.fire();
  void showError() => _onError?.fire();

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _syncPlayback();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _eventSubscription?.cancel();
    _fallbackMotion.dispose();
    _machine?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final artboard = _artboard;
    if (artboard == null) {
      if (_reduceMotion) {
        return Semantics(
          label: 'EduOS student helper mascot',
          image: true,
          child: _MascotFallback(height: widget.height, mood: widget.mood),
        );
      }
      return Semantics(
        label: 'EduOS student helper mascot',
        image: true,
        child: AnimatedBuilder(
        animation: _fallbackMotion,
        builder: (context, child) {
          final t = _fallbackMotion.value;
          final wave = _runtimeAction == EduMascotAction.greet && _fallbackActionActive;
          final celebrate = _runtimeAction == EduMascotAction.celebrate && _fallbackActionActive;
          final help = _runtimeAction == EduMascotAction.help && _fallbackActionActive;
          final angle = wave ? (t < .5 ? -.16 : .16) : help ? -.07 * t : 0.0;
          final lift = celebrate ? -18 * (1 - (2 * t - 1).abs()) : 0.0;
          final breathe = 1 + (t * .012);
          return SizedBox(height: widget.height, child: Center(
            child: Transform.translate(offset: Offset(0, lift), child: Transform.rotate(
              angle: angle, child: Transform.scale(scale: breathe, child: child),
            )),
          ));
        },
        child: _MascotFallback(height: widget.height, mood: widget.mood),
      ));
    }
    return Semantics(
      label: 'EduOS student helper mascot',
      image: true,
      child: SizedBox(
      height: widget.height,
      child: ExcludeSemantics(child: Rive(artboard: artboard, fit: BoxFit.contain)),
    ));
  }
}

class _MascotFallback extends StatelessWidget {
  const _MascotFallback({required this.height, required this.mood});
  final double height;
  final double mood;

  @override
  Widget build(BuildContext context) {
    final brand = context.eduBrand;
    return SizedBox(
      height: height,
      child: Center(
        child: Container(
          width: 116,
          height: 116,
          decoration: BoxDecoration(
            color: Color.lerp(brand.primary, brand.accent, (mood.clamp(0, 2) / 2))!,
            borderRadius: BorderRadius.circular(32),
            boxShadow: [
              BoxShadow(
                color: brand.primary.withOpacity(0.18),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Padding(
            padding: const EdgeInsets.all(7),
            child: SvgPicture.asset(
              'assets/branding/eduos_mascot.svg',
              fit: BoxFit.contain,
              semanticsLabel: 'EduOS student helper mascot',
            ),
          ),
        ),
      ),
    );
  }
}

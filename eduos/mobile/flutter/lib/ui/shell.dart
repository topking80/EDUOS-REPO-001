import 'dart:async';

import 'package:flutter/material.dart';

import '../app/app_scope.dart';
import '../app/role_tabs.dart';
import 'screens/account_screen.dart';
import 'screens/alerts_screen.dart';
import 'screens/arrival_screen.dart';
import 'screens/children_screen.dart';
import 'screens/class_register_screen.dart';
import 'screens/courses_screen.dart';
import 'screens/driver_route_screen.dart';
import 'screens/family_library_screen.dart';
import 'screens/family_pickup_screen.dart';
import 'screens/learner_screens.dart';
import 'screens/messages_screen.dart';
import 'screens/overview_screen.dart';
import 'screens/safety_board.dart';
import 'screens/staff_pickup_screen.dart';
import 'screens/staffing_screen.dart';
import 'screens/teacher_screens.dart';
import 'screens/safety_screen.dart';
import 'screens/web_fallback_screen.dart';

/// Signed-in app: the role's tabs, the SafetyOS takeover while an incident is
/// live, an offline-queue banner, and resume handling (refresh + resend).
class Shell extends StatefulWidget {
  const Shell({super.key});

  @override
  State<Shell> createState() => _ShellState();
}

class _ShellState extends State<Shell> with WidgetsBindingObserver {
  String? _tab;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      final app = AppScope.read(context);
      unawaited(app.refreshStatus());
      unawaited(app.flushQueue());
    }
  }

  void _go(String tab) => setState(() => _tab = tab);

  Widget _screen(RoleTab tab, String role) {
    if (!tab.native) return WebFallbackScreen(tab: tab);
    return switch (tab.id) {
      'children' => ChildrenScreen(onOpenArrival: () => _go('arrival')),
      'route' => const DriverRouteScreen(),
      'classes' when role == 'teacher' => const ClassRegisterScreen(),
      'library' when role == 'parent' => const FamilyLibraryScreen(),
      'library' when role == 'pupil' => const FamilyLibraryScreen(mine: true),
      'home' when role == 'pupil' => const LearnerHomeScreen(),
      'path' when role == 'pupil' => const PathScreen(),
      'christie' when role == 'pupil' => const ChristieTab(),
      'courses' when role == 'pupil' => const LearnerCoursesScreen(),
      'courses' when role == 'teacher' => const TeacherCoursesScreen(),
      'grading' when role == 'teacher' => const GradingScreen(),
      'copilot' when role == 'teacher' => const CopilotScreen(),
      'staffing' => const StaffingScreen(),
      'news' when role == 'pupil' => const NewsScreen(),
      'arrival' => const ArrivalScreen(),
      'pickup' when role == 'parent' => const FamilyPickupScreen(),
      'pickup' => const StaffPickupScreen(),
      'overview' => const OverviewScreen(),
      'safety' when role != 'sro' => const SafetyCenterScreen(embedded: true),
      'messages' => const MessagesScreen(),
      'alerts' => const AlertsScreen(),
      _ => WebFallbackScreen(tab: tab),
    };
  }

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final role = app.me?.role ?? '';
    final tabs = tabsFor(role);
    final live = app.liveIncidents;
    // SafetyOS: while an incident is live, families see the safety screen;
    // they may open pick-up once reunification starts (as in the web app).
    final reunification = live.any((i) => i.reunification);
    // Staff may still open pick-up (reunification releases happen there);
    // families only once reunification has started.
    const staffRoles = {'teacher', 'principal', 'superintendent', 'vice_principal', 'counselor', 'nurse', 'maintenance', 'lunch_staff', 'librarian', 'driver', 'sro', 'it_admin'};
    final pickupAllowed = _tab == 'pickup' && (staffRoles.contains(role) || (role == 'parent' && reunification));
    final safetyLock = live.isNotEmpty && !pickupAllowed;
    if (tabs.isEmpty) {
      return Scaffold(
        appBar: AppBar(title: const Text('EduOS')),
        body: WebFallbackScreen(tab: RoleTab('', roleNames[role] ?? 'EduOS', Icons.apps)),
      );
    }
    final current = tabs.firstWhere((t) => t.id == _tab, orElse: () => tabs.first);
    final index = tabs.indexOf(current);
    // Material guidance: at most 5 destinations; the rest go in "More".
    final primary = tabs.length <= 5 ? tabs : tabs.take(4).toList();
    final overflow = tabs.length <= 5 ? <RoleTab>[] : tabs.skip(4).toList();
    final navIndex = index < primary.length ? index : primary.length;

    return Scaffold(
      appBar: AppBar(
        title: Text(live.isNotEmpty ? 'Safety' : current.label),
        actions: [
          IconButton(
            tooltip: app.unread > 0 ? 'Alerts, ${app.unread} unread' : 'Alerts',
            onPressed: tabs.any((t) => t.id == 'alerts') ? () => _go('alerts') : null,
            icon: Badge(isLabelVisible: app.unread > 0, label: Text('${app.unread}'), child: const Icon(Icons.notifications_none)),
          ),
          if (app.canInitiateSafety || app.canLeadSafety)
            IconButton(
              tooltip: live.isNotEmpty ? 'Safety board' : 'Safety: start an alert',
              icon: Icon(Icons.shield_outlined, color: live.isNotEmpty ? Theme.of(context).colorScheme.error : null),
              onPressed: live.isNotEmpty
                  ? () => _go(tabs.first.id) // the safety takeover shows the board
                  : () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SafetyCenterScreen())),
            ),
          IconButton(
            tooltip: 'Account',
            icon: const Icon(Icons.account_circle_outlined),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const AccountScreen())),
          ),
        ],
      ),
      body: Column(children: [
        if (app.queued > 0)
          MaterialBanner(
            content: Text('${app.queued} change${app.queued == 1 ? '' : 's'} saved on this phone. ${app.queued == 1 ? 'It sends' : 'They send'} when you\'re back online.'),
            actions: [TextButton(onPressed: app.flushQueue, child: const Text('Send now'))],
          ),
        if (app.heldForOthers > 0)
          MaterialBanner(
            content: Text('${app.heldForOthers} change${app.heldForOthers == 1 ? ' was' : 's were'} saved on this phone under another account, role or school. '
                '${app.heldForOthers == 1 ? 'It is' : 'They are'} only sent when that account signs back in here, and deleted after 24 hours.'),
            actions: const [SizedBox.shrink()],
          ),
        if (app.notice != null)
          MaterialBanner(content: Text(app.notice!), actions: [TextButton(onPressed: app.clearNotice, child: const Text('Dismiss'))]),
        Expanded(
          child: safetyLock
              ? SafetyScreen(onOpenPickup: reunification && (role == 'parent' || tabs.any((t) => t.id == 'pickup')) ? () => _go('pickup') : null)
              : KeyedSubtree(key: ValueKey('$role/${current.id}'), child: _screen(current, role)),
        ),
      ]),
      bottomNavigationBar: safetyLock
          ? null
          : NavigationBar(
              selectedIndex: navIndex,
              onDestinationSelected: (i) async {
                if (i < primary.length) return _go(primary[i].id);
                final picked = await showModalBottomSheet<String>(
                  context: context,
                  builder: (context) => SafeArea(
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      for (final t in overflow) ListTile(leading: Icon(t.icon), title: Text(t.label), onTap: () => Navigator.pop(context, t.id)),
                    ]),
                  ),
                );
                if (picked != null) _go(picked);
              },
              destinations: [
                for (final t in primary) NavigationDestination(icon: Icon(t.icon), label: t.label),
                if (overflow.isNotEmpty) const NavigationDestination(icon: Icon(Icons.more_horiz), label: 'More'),
              ],
            ),
    );
  }
}

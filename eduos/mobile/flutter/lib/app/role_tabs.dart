import 'package:flutter/material.dart';

/// One bottom-navigation destination. [native] tabs have a Flutter screen in
/// this build; the rest open the EduOS web app until their phase ships.
class RoleTab {
  const RoleTab(this.id, this.label, this.icon, {this.native = false});
  final String id;
  final String label;
  final IconData icon;
  final bool native;
}

/// Same tabs, order and labels as ROLE_TABS in public/app/app.js.
/// Phase 1: the parent app. Phase 2: bus driver route, teacher class
/// register and safety roll call (the offline-critical staff screens).
/// Phase 3: school leaders: overview, pick-up desk + approvals, safety
/// board and starting alerts.
/// Phase 4: learners: home, courses and quizzes, Christie practice, path,
/// library and news.
/// Phase 5: teachers: courses, gradebook, grading and Christie copilot;
/// staffing for every staff role.
/// Phase 6: everything else: operations queues, attendance, transport,
/// library desk, nodes status and the SRO workspace. Every tab is native.
/// 37.8 Time Capsules: "Time Capsules" for families, learners and school
/// leads, "My history" for learners and "History items" for teachers. They
/// come last so each role's everyday tabs keep their place in the bar.
const roleTabs = <String, List<RoleTab>>{
  'parent': [
    RoleTab('children', 'Children', Icons.child_care, native: true),
    RoleTab('library', 'Library books', Icons.menu_book, native: true),
    RoleTab('arrival', 'Arrival', Icons.directions_bus, native: true),
    RoleTab('pickup', 'Pick-up', Icons.directions_car, native: true),
    RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true),
    RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true),
    RoleTab('capsules', 'Time Capsules', Icons.hourglass_bottom, native: true),
  ],
  'pupil': [
    RoleTab('home', 'Home', Icons.home_outlined, native: true),
    RoleTab('library', 'My library', Icons.menu_book, native: true),
    RoleTab('courses', 'Courses', Icons.school_outlined, native: true),
    RoleTab('christie', 'Christie', Icons.auto_awesome, native: true),
    RoleTab('path', 'My path', Icons.route, native: true),
    RoleTab('news', 'News', Icons.newspaper, native: true),
    RoleTab('activities', 'Clubs & Sports', Icons.emoji_events_outlined, native: true),
    RoleTab('portfolio', 'My history', Icons.auto_stories_outlined, native: true),
    RoleTab('capsules', 'Time Capsules', Icons.hourglass_bottom, native: true),
  ],
  'teacher': [
    RoleTab('dashboard', 'Dashboard', Icons.dashboard_outlined, native: true),
    RoleTab('classes', 'Classes', Icons.grid_view, native: true),
    RoleTab('schoolday', 'School day', Icons.hub_outlined, native: true),
    RoleTab('staffing', 'Staffing', Icons.groups_outlined, native: true),
    RoleTab('courses', 'Courses', Icons.school_outlined, native: true),
    RoleTab('grading', 'Grading', Icons.check_circle_outline, native: true),
    RoleTab('copilot', 'Christie', Icons.auto_awesome, native: true),
    RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true),
    RoleTab('contributions', 'History items', Icons.auto_stories_outlined, native: true),
  ],
  'librarian': [RoleTab('library', 'Library desk', Icons.menu_book, native: true), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'vice_principal': [
    RoleTab('operations', 'Operations', Icons.grid_view, native: true),
    RoleTab('staffing', 'Staffing', Icons.groups_outlined, native: true),
    RoleTab('attendance', 'Attendance', Icons.check_circle_outline, native: true),
    RoleTab('safety', 'Safety', Icons.shield_outlined, native: true),
    RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true),
    RoleTab('capsules', 'Time Capsules', Icons.hourglass_bottom, native: true),
  ],
  'counselor': [RoleTab('guidance', 'Counseling', Icons.favorite_border, native: true), RoleTab('staffing', 'Staffing', Icons.groups_outlined, native: true), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'nurse': [RoleTab('healthoffice', 'Health office', Icons.monitor_heart_outlined, native: true), RoleTab('staffing', 'Staffing', Icons.groups_outlined, native: true), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'maintenance': [RoleTab('facilities', 'Facilities', Icons.build_outlined, native: true), RoleTab('staffing', 'Staffing', Icons.groups_outlined, native: true), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'lunch_staff': [RoleTab('meals', 'Meal service', Icons.restaurant, native: true), RoleTab('staffing', 'Staffing', Icons.groups_outlined, native: true), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'principal': [
    RoleTab('overview', 'School', Icons.grid_view, native: true),
    RoleTab('staffing', 'Staffing', Icons.groups_outlined, native: true),
    RoleTab('library', 'Library', Icons.menu_book, native: true),
    RoleTab('pickup', 'Pick-up', Icons.directions_car, native: true),
    RoleTab('transport', 'Transport', Icons.directions_bus, native: true),
    RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true),
    RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true),
    RoleTab('capsules', 'Time Capsules', Icons.hourglass_bottom, native: true),
  ],
  'superintendent': [
    RoleTab('overview', 'District', Icons.grid_view, native: true),
    RoleTab('staffing', 'Staffing', Icons.groups_outlined, native: true),
    RoleTab('library', 'Library', Icons.menu_book, native: true),
    RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true),
    RoleTab('transport', 'Transport', Icons.directions_bus, native: true),
    RoleTab('nodes', 'Nodes', Icons.dns_outlined, native: true),
    RoleTab('capsules', 'Time Capsules', Icons.hourglass_bottom, native: true),
  ],
  'driver': [RoleTab('route', 'Route', Icons.directions_bus, native: true), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true), RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true)],
  'sro': [RoleTab('safety', 'Safety', Icons.shield_outlined, native: true), RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true)],
  // COACH-01: a coach profile at a school where the person coaches but doesn't teach.
  'coach': [RoleTab('teams', 'My teams', Icons.emoji_events_outlined, native: true), RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true)],
  'it_admin': [RoleTab('nodes', 'Nodes', Icons.dns_outlined, native: true), RoleTab('library', 'Library', Icons.menu_book, native: true)],
};

const roleNames = {
  'parent': 'Family',
  'pupil': 'Learner',
  'teacher': 'Teacher',
  'librarian': 'Librarian',
  'vice_principal': 'Vice principal',
  'counselor': 'Counselor',
  'nurse': 'Nurse',
  'maintenance': 'Facilities',
  'lunch_staff': 'Meal service',
  'principal': 'Principal',
  'superintendent': 'Superintendent',
  'driver': 'Bus driver',
  'sro': 'School resource officer',
  'it_admin': 'IT',
  'coach': 'Coach',
};

/// Tabs a TV doesn't show: they are for doing work (registers, routes,
/// grading, pick-up releases, Christie chats) or hold records that shouldn't
/// be up on a shared living-room screen (counseling, health office). A TV
/// session is read-only on the server anyway.
const tvHiddenTabs = {'route', 'pickup', 'grading', 'copilot', 'christie', 'attendance', 'guidance', 'healthoffice', 'facilities', 'meals', 'nodes'};

/// The role's tabs; on a TV, without [tvHiddenTabs].
List<RoleTab> tabsFor(String role, {bool tv = false}) {
  final all = roleTabs[role] ?? const <RoleTab>[];
  return tv ? [for (final t in all) if (!tvHiddenTabs.contains(t.id)) t] : all;
}

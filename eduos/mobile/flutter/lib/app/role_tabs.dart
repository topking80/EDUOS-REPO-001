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
const roleTabs = <String, List<RoleTab>>{
  'parent': [
    RoleTab('children', 'Children', Icons.child_care, native: true),
    RoleTab('library', 'Library books', Icons.menu_book, native: true),
    RoleTab('arrival', 'Arrival', Icons.directions_bus, native: true),
    RoleTab('pickup', 'Pick-up', Icons.directions_car, native: true),
    RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true),
    RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true),
  ],
  'pupil': [
    RoleTab('home', 'Home', Icons.home_outlined, native: true),
    RoleTab('library', 'My library', Icons.menu_book, native: true),
    RoleTab('courses', 'Courses', Icons.school_outlined, native: true),
    RoleTab('christie', 'Christie', Icons.auto_awesome, native: true),
    RoleTab('path', 'My path', Icons.route, native: true),
    RoleTab('news', 'News', Icons.newspaper, native: true),
  ],
  'teacher': [
    RoleTab('classes', 'Classes', Icons.grid_view, native: true),
    RoleTab('staffing', 'Staffing', Icons.groups_outlined),
    RoleTab('courses', 'Courses', Icons.school_outlined),
    RoleTab('grading', 'Grading', Icons.check_circle_outline),
    RoleTab('copilot', 'Christie', Icons.auto_awesome),
    RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true),
  ],
  'librarian': [RoleTab('library', 'Library desk', Icons.menu_book), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'vice_principal': [
    RoleTab('operations', 'Operations', Icons.grid_view),
    RoleTab('staffing', 'Staffing', Icons.groups_outlined),
    RoleTab('attendance', 'Attendance', Icons.check_circle_outline),
    RoleTab('safety', 'Safety', Icons.shield_outlined, native: true),
    RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true),
  ],
  'counselor': [RoleTab('guidance', 'Counseling', Icons.favorite_border), RoleTab('staffing', 'Staffing', Icons.groups_outlined), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'nurse': [RoleTab('healthoffice', 'Health office', Icons.monitor_heart_outlined), RoleTab('staffing', 'Staffing', Icons.groups_outlined), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'maintenance': [RoleTab('facilities', 'Facilities', Icons.build_outlined), RoleTab('staffing', 'Staffing', Icons.groups_outlined), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'lunch_staff': [RoleTab('meals', 'Meal service', Icons.restaurant), RoleTab('staffing', 'Staffing', Icons.groups_outlined), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true)],
  'principal': [
    RoleTab('overview', 'School', Icons.grid_view, native: true),
    RoleTab('staffing', 'Staffing', Icons.groups_outlined),
    RoleTab('library', 'Library', Icons.menu_book),
    RoleTab('pickup', 'Pick-up', Icons.directions_car, native: true),
    RoleTab('transport', 'Transport', Icons.directions_bus),
    RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true),
    RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true),
  ],
  'superintendent': [
    RoleTab('overview', 'District', Icons.grid_view, native: true),
    RoleTab('staffing', 'Staffing', Icons.groups_outlined),
    RoleTab('library', 'Library', Icons.menu_book),
    RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true),
    RoleTab('transport', 'Transport', Icons.directions_bus),
    RoleTab('nodes', 'Nodes', Icons.dns_outlined),
  ],
  'driver': [RoleTab('route', 'Route', Icons.directions_bus, native: true), RoleTab('messages', 'Messages', Icons.chat_bubble_outline, native: true), RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true)],
  'sro': [RoleTab('safety', 'Safety', Icons.shield_outlined), RoleTab('alerts', 'Alerts', Icons.notifications_none, native: true)],
  'it_admin': [RoleTab('nodes', 'Nodes', Icons.dns_outlined), RoleTab('library', 'Library', Icons.menu_book)],
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
};

List<RoleTab> tabsFor(String role) => roleTabs[role] ?? const [];

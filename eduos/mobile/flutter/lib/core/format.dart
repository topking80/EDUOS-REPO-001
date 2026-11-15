// Display helpers matching the web app's wording (STATUS_TEXT, fmtDay, ago).

const statusText = {
  'boarded': 'On board',
  'alighted': 'Dropped off',
  'not_riding': 'Not riding',
  'expected': 'Expected',
  'not_started': 'Run not started',
  'present': 'Present',
  'absent': 'Absent',
  'tardy': 'Tardy',
};

String statusLabel(String status) => statusText[status] ?? status.replaceAll('_', ' ');

const _weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String fmtDay(DateTime? d) => d == null ? '' : '${_weekdays[d.weekday - 1]}, ${_months[d.month - 1]} ${d.day}';

String fmtTime(DateTime? d) {
  if (d == null) return '';
  final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
  return '$h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
}

String ago(DateTime? d, {DateTime? now}) {
  if (d == null) return '';
  final minutes = (now ?? DateTime.now()).difference(d).inMinutes;
  if (minutes < 1) return 'just now';
  if (minutes < 60) return '$minutes min ago';
  if (minutes < 1440) return '${(minutes / 60).round()} h ago';
  return fmtDay(d);
}

String firstName(String name) => name.trim().split(RegExp(r'\s+')).first;

/// ISO date (yyyy-mm-dd) for API bodies.
String isoDate(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

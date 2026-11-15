// Typed views of the EduOS API responses used by the app. Parsing is lenient:
// a missing or unexpected field becomes null/empty rather than crashing a
// screen, because the same server also serves newer and older clients.

typedef Json = Map<String, Object?>;

String str(Object? v, [String fallback = '']) => v == null ? fallback : '$v';
String? strOrNull(Object? v) => v == null ? null : '$v';
int integer(Object? v) => v is int ? v : v is num ? v.toInt() : int.tryParse('$v') ?? 0;
bool boolean(Object? v) => v == true;
DateTime? date(Object? v) => v == null ? null : DateTime.tryParse('$v')?.toLocal();
Json obj(Object? v) => v is Map ? Map<String, Object?>.from(v) : const {};
List<Json> objs(Object? v) => v is List ? v.whereType<Map>().map((m) => Map<String, Object?>.from(m)).toList() : const [];

class Me {
  const Me({required this.userId, required this.displayName, required this.role, required this.districtId, this.schoolId});
  factory Me.fromJson(Json j) => Me(
        userId: str(j['userId']),
        displayName: str(j['displayName'], 'EduOS user'),
        role: str(j['role']),
        districtId: str(j['districtId']),
        schoolId: strOrNull(j['schoolId']),
      );
  final String userId, displayName, role, districtId;
  final String? schoolId;
}

class Brand {
  const Brand({this.schoolName, this.districtName, this.primaryHex, this.accentHex});
  factory Brand.fromJson(Json j) {
    final b = obj(j['branding']);
    return Brand(
      schoolName: strOrNull(obj(j['school'])['name']),
      districtName: strOrNull(j['districtName']),
      primaryHex: strOrNull(b['primary']),
      accentHex: strOrNull(b['accent']),
    );
  }
  final String? schoolName, districtName, primaryHex, accentHex;
  String get placeName => schoolName ?? districtName ?? 'EduOS';
}

class Membership {
  const Membership({required this.id, required this.role, this.schoolId, this.schoolName});
  factory Membership.fromJson(Json j) =>
      Membership(id: str(j['id']), role: str(j['role']), schoolId: strOrNull(j['school_id']), schoolName: strOrNull(j['school_name']));
  final String id, role;
  final String? schoolId, schoolName;
}

class ChildSummary {
  const ChildSummary({required this.id, required this.name, required this.grade, required this.schoolName,
      required this.absences30d, required this.due7d, required this.overdue, required this.toAcknowledge});
  factory ChildSummary.fromJson(Json j) => ChildSummary(
        id: str(j['id']),
        name: str(j['display_name']),
        grade: str(j['grade_level']),
        schoolName: str(j['school_name']),
        absences30d: integer(j['absences_30d']),
        due7d: integer(j['due_7d']),
        overdue: integer(j['overdue']),
        toAcknowledge: integer(j['to_acknowledge']),
      );
  final String id, name, grade, schoolName;
  final int absences30d, due7d, overdue, toAcknowledge;
}

class AttendanceDay {
  const AttendanceDay(this.day, this.status);
  factory AttendanceDay.fromJson(Json j) => AttendanceDay(date(j['event_date']), str(j['status']));
  final DateTime? day;
  final String status;
}

class RiderEvent {
  const RiderEvent({required this.at, required this.event, required this.isSchool, required this.stopName});
  factory RiderEvent.fromJson(Json j) =>
      RiderEvent(at: date(j['recorded_at']), event: str(j['event']), isSchool: boolean(j['is_school']), stopName: str(j['stop_name']));
  final DateTime? at;
  final String event, stopName;
  final bool isSchool;
}

class Rider {
  const Rider({required this.studentId, required this.name, required this.direction, required this.status,
      required this.routeName, required this.busLabel, required this.stopName, this.stopTime, this.runId, this.events = const []});
  factory Rider.fromJson(Json j) => Rider(
        studentId: str(j['id']),
        name: str(j['display_name']),
        direction: str(j['direction']),
        status: str(j['status']),
        routeName: str(j['route_name']),
        busLabel: str(j['bus_label']),
        stopName: str(j['stop_name']),
        stopTime: strOrNull(j['stop_time']),
        runId: strOrNull(j['run_id']),
        events: objs(j['events']).map(RiderEvent.fromJson).toList(),
      );
  final String studentId, name, direction, status, routeName, busLabel, stopName;
  final String? stopTime, runId;
  final List<RiderEvent> events;
}

class Loan {
  const Loan({required this.title, this.studentName, this.dueAt, this.returnedAt, required this.overdue});
  factory Loan.fromJson(Json j) => Loan(
      title: str(j['title'], 'Untitled'), studentName: strOrNull(j['student_name']), dueAt: date(j['due_at']),
      returnedAt: date(j['returned_at']), overdue: boolean(j['overdue']));
  final String title;
  final String? studentName;
  final DateTime? dueAt, returnedAt;
  final bool overdue;
}

class PickupAdult {
  const PickupAdult({required this.id, required this.fullName, required this.relationship, required this.status,
      required this.kind, required this.isMe, this.decisionNote, this.passExpiresAt});
  factory PickupAdult.fromJson(Json j) => PickupAdult(
        id: str(j['id']),
        fullName: str(j['full_name']),
        relationship: str(j['relationship']),
        status: str(j['status']),
        kind: str(j['kind']),
        isMe: boolean(j['is_me']),
        decisionNote: strOrNull(j['decision_note']),
        passExpiresAt: date(obj(j['pass'])['expiresAt']),
      );
  final String id, fullName, relationship, status, kind;
  final bool isMe;
  final String? decisionNote;
  final DateTime? passExpiresAt;
  bool get approved => status == 'approved';
}

class EarlyDismissal {
  const EarlyDismissal({this.day, required this.time, required this.adultName, required this.reason, required this.status});
  factory EarlyDismissal.fromJson(Json j) => EarlyDismissal(
      day: date(j['dismissal_date']), time: str(j['time']), adultName: str(j['adult_name']), reason: str(j['reason']), status: str(j['status']));
  final DateTime? day;
  final String time, adultName, reason, status;
}

class PickupLog {
  const PickupLog({this.at, required this.adultName, required this.relationship});
  factory PickupLog.fromJson(Json j) => PickupLog(at: date(j['at']), adultName: str(j['adult_name']), relationship: str(j['relationship']));
  final DateTime? at;
  final String adultName, relationship;
}

class PickupChild {
  const PickupChild({required this.id, required this.name, required this.schoolName, this.adults = const [],
      this.earlyDismissals = const [], this.log = const []});
  factory PickupChild.fromJson(Json j) => PickupChild(
        id: str(j['id']),
        name: str(j['display_name']),
        schoolName: str(j['school_name']),
        adults: objs(j['adults']).map(PickupAdult.fromJson).toList(),
        earlyDismissals: objs(j['earlyDismissals']).map(EarlyDismissal.fromJson).toList(),
        log: objs(j['log']).map(PickupLog.fromJson).toList(),
      );
  final String id, name, schoolName;
  final List<PickupAdult> adults;
  final List<EarlyDismissal> earlyDismissals;
  final List<PickupLog> log;
}

/// A pick-up pass. [qrRows] is the server-rendered QR module grid ("0101…").
class PickupPass {
  const PickupPass({required this.code, required this.qrRows, required this.adultName, this.expiresAt});
  factory PickupPass.fromJson(Json j) => PickupPass(
      code: str(j['code']),
      qrRows: (j['qr'] is List ? (j['qr'] as List).map((r) => '$r').toList() : const <String>[]),
      adultName: str(j['adultName']),
      expiresAt: date(j['expiresAt']));
  final String code, adultName;
  final List<String> qrRows;
  final DateTime? expiresAt;
}

class ThreadSummary {
  const ThreadSummary({required this.id, required this.subject, required this.withNames, this.studentName,
      this.lastMessageAt, this.lastBody, required this.unread, required this.status});
  factory ThreadSummary.fromJson(Json j) => ThreadSummary(
        id: str(j['id']),
        subject: str(j['subject']),
        withNames: str(j['with_names']),
        studentName: strOrNull(j['student_name']),
        lastMessageAt: date(j['last_message_at']),
        lastBody: strOrNull(j['last_body']),
        unread: integer(j['unread']),
        status: str(j['status']),
      );
  final String id, subject, withNames, status;
  final String? studentName, lastBody;
  final DateTime? lastMessageAt;
  final int unread;
}

class Message {
  const Message({required this.id, required this.authorId, required this.authorName, required this.body,
      required this.hidden, this.createdAt, this.readBy = const []});
  factory Message.fromJson(Json j) => Message(
        id: str(j['id']),
        authorId: str(j['author_user_id']),
        authorName: str(j['author_name']),
        body: str(j['body']),
        hidden: boolean(j['hidden']),
        createdAt: date(j['created_at']),
        readBy: objs(j['read_by']).map((r) => str(r['name'])).toList(),
      );
  final String id, authorId, authorName, body;
  final bool hidden;
  final DateTime? createdAt;
  final List<String> readBy;
}

class ThreadDetail {
  const ThreadDetail({required this.id, required this.subject, required this.kind, this.studentName,
      required this.participants, required this.messages, required this.status, this.lockReason});
  factory ThreadDetail.fromJson(Json j) => ThreadDetail(
        id: str(j['id']),
        subject: str(j['subject']),
        kind: str(j['kind']),
        studentName: strOrNull(j['student_name']),
        participants: {for (final p in objs(j['participants'])) str(p['user_id']): str(p['name'])},
        messages: objs(j['messages']).map(Message.fromJson).toList(),
        status: str(j['status']),
        lockReason: strOrNull(j['lock_reason']),
      );
  final String id, subject, kind, status;
  final String? studentName, lockReason;
  final Map<String, String> participants;
  final List<Message> messages;
}

class Contact {
  const Contact({required this.userId, required this.name, required this.role, this.studentId, this.studentName});
  factory Contact.fromJson(Json j) => Contact(
      userId: str(j['user_id']), name: str(j['name']), role: str(j['role']),
      studentId: strOrNull(j['student_id']), studentName: strOrNull(j['student_name']));
  final String userId, name, role;
  final String? studentId, studentName;
}

class AlertItem {
  const AlertItem({required this.kind, required this.title, this.body, this.createdAt, required this.read});
  factory AlertItem.fromJson(Json j) => AlertItem(
      kind: str(j['kind']), title: str(j['title']), body: strOrNull(j['body']), createdAt: date(j['created_at']), read: j['read_at'] != null);
  final String kind, title;
  final String? body;
  final DateTime? createdAt;
  final bool read;
}

class Announcement {
  const Announcement({required this.id, required this.title, required this.body, required this.scope,
      required this.authorName, this.classTeacherName, this.createdAt, this.unread = false});
  factory Announcement.fromJson(Json j) => Announcement(
        id: str(j['id']),
        title: str(j['title']),
        body: str(j['body']),
        scope: str(j['scope']),
        authorName: str(j['author_name']),
        classTeacherName: strOrNull(j['class_teacher_name']),
        createdAt: date(j['created_at']),
        unread: j['read'] == false,
      );
  final String id, title, body, scope, authorName;
  final String? classTeacherName;
  final DateTime? createdAt;
  final bool unread;
}

class IncidentChild {
  const IncidentChild({required this.name, this.releasedTo, this.releasedAt});
  factory IncidentChild.fromJson(Json j) {
    final r = obj(j['released']);
    return IncidentChild(name: str(j['name']), releasedTo: strOrNull(r['adult']), releasedAt: date(r['at']));
  }
  final String name;
  final String? releasedTo;
  final DateTime? releasedAt;
  bool get released => releasedTo != null || releasedAt != null;
}

class Incident {
  const Incident({required this.id, required this.status, required this.kind, required this.isDrill, required this.schoolName,
      this.startedAt, required this.message, this.instructions, this.reunificationPoint, this.children});
  factory Incident.fromJson(Json j) => Incident(
        id: str(j['id']),
        status: str(j['status']),
        kind: str(j['kind']),
        isDrill: boolean(j['isDrill']),
        schoolName: str(j['schoolName']),
        startedAt: date(j['startedAt']),
        message: str(j['message']),
        instructions: strOrNull(j['instructions']),
        reunificationPoint: strOrNull(j['reunificationPoint']),
        children: j['children'] is List ? objs(j['children']).map(IncidentChild.fromJson).toList() : null,
      );
  final String id, status, kind, schoolName, message;
  final bool isDrill;
  final DateTime? startedAt;
  final String? instructions, reunificationPoint;
  final List<IncidentChild>? children;
  bool get live => status == 'active' || status == 'reunification';
  bool get reunification => status == 'reunification';
}

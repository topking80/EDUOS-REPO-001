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

// ---- Phase 2: bus driver route, class register, safety roll call ----

class RouteRider {
  const RouteRider({required this.studentId, required this.name, required this.grade, required this.status});
  factory RouteRider.fromJson(Json j) =>
      RouteRider(studentId: str(j['studentId']), name: str(j['name']), grade: str(j['grade']), status: str(j['status'], 'expected'));
  final String studentId, name, grade, status;
  RouteRider withStatus(String s) => RouteRider(studentId: studentId, name: name, grade: grade, status: s);
}

class RouteStop {
  const RouteStop({required this.id, required this.seq, required this.name, this.time, required this.isSchool, this.riders = const []});
  factory RouteStop.fromJson(Json j) => RouteStop(
        id: str(j['id']),
        seq: integer(j['seq']),
        name: str(j['name']),
        time: strOrNull(j['time']),
        isSchool: boolean(j['is_school']),
        riders: objs(j['riders']).map(RouteRider.fromJson).toList(),
      );
  final String id, name;
  final int seq;
  final String? time;
  final bool isSchool;
  final List<RouteRider> riders;
}

class RunInfo {
  const RunInfo({required this.id, required this.status, this.completedAt});
  static RunInfo? fromJson(Object? v) {
    final j = obj(v);
    if (j['id'] == null) return null;
    return RunInfo(id: str(j['id']), status: str(j['status']), completedAt: date(j['completed_at']));
  }
  final String id, status;
  final DateTime? completedAt;
  bool get live => status == 'in_progress';
}

class DriverRoute {
  const DriverRoute({required this.id, required this.name, required this.busLabel, required this.direction,
      required this.schoolName, this.run, this.stops = const [], required this.onBoard, required this.expected, required this.alighted});
  factory DriverRoute.fromJson(Json j) {
    final c = obj(j['counts']);
    return DriverRoute(
      id: str(j['id']),
      name: str(j['name']),
      busLabel: str(j['bus_label']),
      direction: str(j['direction']),
      schoolName: str(j['school_name']),
      run: RunInfo.fromJson(j['run']),
      stops: objs(j['stops']).map(RouteStop.fromJson).toList(),
      onBoard: integer(c['onBoard']),
      expected: integer(c['expected']),
      alighted: integer(c['alighted']),
    );
  }
  final String id, name, busLabel, direction, schoolName;
  final RunInfo? run;
  final List<RouteStop> stops;
  final int onBoard, expected, alighted;
}

class RosterLearner {
  const RosterLearner({required this.studentId, required this.name});
  factory RosterLearner.fromJson(Json j) => RosterLearner(studentId: str(j['student_id']), name: str(j['student_name']));
  final String studentId, name;
}

class AttendanceMark {
  const AttendanceMark({required this.studentId, required this.day, required this.status});
  factory AttendanceMark.fromJson(Json j) => AttendanceMark(studentId: str(j['student_id']), day: str(j['event_date']), status: str(j['status']));
  final String studentId, day, status;
}

class RollCallLearner {
  const RollCallLearner({required this.studentId, required this.name, required this.grade, this.status});
  factory RollCallLearner.fromJson(Json j) =>
      RollCallLearner(studentId: str(j['studentId']), name: str(j['name']), grade: str(j['grade']), status: strOrNull(j['status']));
  final String studentId, name, grade;
  final String? status;
}

class RollCall {
  const RollCall({required this.learners, required this.extras, this.submittedAt});
  factory RollCall.fromJson(Json j) => RollCall(
        learners: objs(j['learners']).map(RollCallLearner.fromJson).toList(),
        extras: objs(j['extras']).map(RollCallLearner.fromJson).toList(),
        submittedAt: date(j['submittedAt']),
      );
  final List<RollCallLearner> learners, extras;
  final DateTime? submittedAt;
}

// ---- Phase 3: principal / school leader ----

class PassStudent {
  const PassStudent({required this.studentId, required this.name, required this.grade, required this.eligible,
      this.reason, required this.custodyOrder, this.flagDetail, this.earlyDismissalTime});
  factory PassStudent.fromJson(Json j) => PassStudent(
        studentId: str(j['studentId']),
        name: str(j['name']),
        grade: str(j['grade']),
        eligible: boolean(j['eligible']),
        reason: strOrNull(j['reason']),
        custodyOrder: boolean(j['custodyOrder']),
        flagDetail: strOrNull(j['flagDetail']),
        earlyDismissalTime: strOrNull(obj(j['earlyDismissal'])['time']),
      );
  final String studentId, name, grade;
  final bool eligible, custodyOrder;
  final String? reason, flagDetail, earlyDismissalTime;
}

/// Result of POST /api/pickup/verify.
class PassCheck {
  const PassCheck({required this.pass, required this.adultName, required this.relationship, required this.adultKind,
      required this.students, required this.blocked, required this.reunification, required this.instructions});
  factory PassCheck.fromJson(Json j) {
    final a = obj(j['adult']);
    return PassCheck(
      pass: str(j['pass']),
      adultName: str(a['name']),
      relationship: str(a['relationship']),
      adultKind: str(a['kind']),
      students: objs(j['students']).map(PassStudent.fromJson).toList(),
      blocked: boolean(j['blocked']),
      reunification: boolean(j['reunification']),
      instructions: str(j['instructions']),
    );
  }
  final String pass, adultName, relationship, adultKind, instructions;
  final List<PassStudent> students;
  final bool blocked, reunification;
  List<PassStudent> get eligible => students.where((s) => s.eligible).toList();
}

class PickupQueueEntry {
  const PickupQueueEntry({required this.name, required this.adult, this.relationship, this.at});
  factory PickupQueueEntry.fromJson(Json j) =>
      PickupQueueEntry(name: str(j['name']), adult: str(j['adult']), relationship: strOrNull(j['relationship']), at: date(j['at']));
  final String name, adult;
  final String? relationship;
  final DateTime? at;
}

class PickupQueue {
  const PickupQueue({this.incidentStatus, this.incidentKind, required this.waiting, required this.released,
      required this.blocked, required this.denied, required this.earlyDismissals});
  factory PickupQueue.fromJson(Json j) {
    final i = obj(j['incident']);
    return PickupQueue(
      incidentStatus: strOrNull(i['status']),
      incidentKind: strOrNull(i['kind']),
      waiting: objs(j['waiting']).map(PickupQueueEntry.fromJson).toList(),
      released: objs(j['released']).map(PickupQueueEntry.fromJson).toList(),
      blocked: integer(j['blocked']),
      denied: integer(j['denied']),
      earlyDismissals: objs(j['earlyDismissals']),
    );
  }
  final String? incidentStatus, incidentKind;
  final List<PickupQueueEntry> waiting, released;
  final int blocked, denied;
  final List<Json> earlyDismissals;
}

class BoardPerson {
  const BoardPerson({required this.name, this.grade, this.by, this.note});
  factory BoardPerson.fromJson(Json j) => BoardPerson(name: str(j['name']), grade: strOrNull(j['grade']), by: strOrNull(j['by']), note: strOrNull(j['note']));
  final String name;
  final String? grade, by, note;
  String get detail => [if (grade != null) 'gr $grade', if (by != null) by!, if (note != null) note!].join(' · ');
}

class BoardTeacher {
  const BoardTeacher({required this.name, required this.roster, this.submittedAt});
  factory BoardTeacher.fromJson(Json j) => BoardTeacher(name: str(j['name']), roster: integer(j['roster']), submittedAt: date(j['submittedAt']));
  final String name;
  final int roster;
  final DateTime? submittedAt;
}

class IncidentLogEntry {
  const IncidentLogEntry({required this.event, this.detail, this.at, required this.actorName});
  factory IncidentLogEntry.fromJson(Json j) =>
      IncidentLogEntry(event: str(j['event']), detail: strOrNull(j['detail']), at: date(j['at']), actorName: str(j['actor_name']));
  final String event, actorName;
  final String? detail;
  final DateTime? at;
}

/// GET /api/safety/incidents/:id/board (school leaders).
class SafetyBoard {
  const SafetyBoard({required this.totals, required this.missing, required this.injured, required this.teachers,
      required this.unaccounted, required this.events});
  factory SafetyBoard.fromJson(Json j) => SafetyBoard(
        totals: {for (final e in obj(j['totals']).entries) e.key: integer(e.value)},
        missing: objs(j['missing']).map(BoardPerson.fromJson).toList(),
        injured: objs(j['injured']).map(BoardPerson.fromJson).toList(),
        teachers: objs(j['teachers']).map(BoardTeacher.fromJson).toList(),
        unaccounted: objs(j['unaccounted']).map(BoardPerson.fromJson).toList(),
        events: objs(j['events']).map(IncidentLogEntry.fromJson).toList(),
      );
  final Map<String, int> totals;
  final List<BoardPerson> missing, injured, unaccounted;
  final List<BoardTeacher> teachers;
  final List<IncidentLogEntry> events;
  int total(String k) => totals[k] ?? 0;
}

class PastIncident {
  const PastIncident({required this.id, required this.label, required this.isDrill, required this.schoolName,
      this.startedAt, required this.status, required this.debriefed});
  factory PastIncident.fromJson(Json j) => PastIncident(
        id: str(j['id']),
        label: str(j['label']),
        isDrill: boolean(j['isDrill']),
        schoolName: str(j['schoolName']),
        startedAt: date(j['startedAt']),
        status: str(j['status']),
        debriefed: j['debrief'] != null && '${j['debrief']}'.isNotEmpty,
      );
  final String id, label, schoolName, status;
  final bool isDrill, debriefed;
  final DateTime? startedAt;
}

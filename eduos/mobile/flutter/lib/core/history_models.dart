// Student history and Time Capsule models, matching the server's JSON
// (src/student-history-*-routes.js, src/history-*-routes.js and, once merged,
// src/family-storage-routes.js). Labels match public/app/app.js.
import 'models.dart';

const milestoneText = {
  'grade_5_completion': 'Finishing grade 5',
  'grade_8_completion': 'Finishing grade 8',
  'graduation': 'Graduation',
  'age_18': 'Turning 18',
};

const capsuleStatusText = {
  'draft': 'Draft',
  'sealed': 'Sealed, waiting for the milestone',
  'scheduled': 'Sealed',
  'released': 'Released',
  'cancelled': 'Cancelled',
};

const consentText = {'pending': "Hasn't answered", 'approved': 'Accepted', 'denied': 'Declined', 'withdrawn': 'Withdrew'};

const historyKindText = {
  'official_record': 'School record',
  'family_memory': 'Family memory',
  'student_portfolio': 'My work',
  'teacher_artifact': 'From a teacher',
  'system_milestone': 'Milestone',
};

const historyTypeText = {
  'achievement': 'Achievement',
  'project': 'Project',
  'coursework': 'Coursework',
  'reflection': 'Reflection',
  'event': 'Event',
  'portfolio_artifact': 'Portfolio piece',
  'educator_note': 'Teacher note',
  'system_milestone': 'Milestone',
};

/// Types a teacher may submit (server ENTRY_TYPES in the teacher routes).
const teacherItemTypes = ['project', 'achievement', 'coursework', 'event', 'reflection'];

const itemStatusText = {
  'draft': 'Changes requested',
  'submitted': 'With the school',
  'approved': 'With the family',
  'published': "In the student's history",
  'restricted': 'Not shared',
  'rejected': 'Not accepted',
  'declined': 'Declined by the family',
  'withdrawn': 'Withdrawn',
};

const decisionText = {
  'submitted': 'Submitted',
  'approved': 'Approved by the school',
  'changes_requested': 'Changes requested',
  'rejected': 'Rejected by the school',
  'accepted': 'Accepted by the family',
  'declined': 'Declined by the family',
};

const historyReasons = [
  ('needs_edits', 'Needs edits'),
  ('inaccurate', 'Inaccurate'),
  ('privacy_concern', 'Privacy concern'),
  ('other_students_identifiable', 'Other students identifiable'),
  ('not_appropriate', 'Not appropriate'),
  ('duplicate', 'Duplicate'),
  ('not_relevant', 'Not relevant'),
  ('family_preference', 'Family preference'),
  ('other', 'Other'),
];

String reasonLabel(String? code) => historyReasons.firstWhere((r) => r.$1 == code, orElse: () => (code ?? '', code ?? '')).$2;

const recipientTypeText = {'student': 'Student', 'guardian': 'Family', 'teacher': 'Teacher', 'school_staff': 'School staff'};

class HistoryPhoto {
  const HistoryPhoto({required this.id, this.entryId, this.caption, this.alt, this.width, this.height});
  factory HistoryPhoto.fromJson(Json j) => HistoryPhoto(
        id: str(j['id']),
        entryId: strOrNull(j['entryId']),
        caption: strOrNull(j['caption']),
        alt: strOrNull(j['alt']),
        width: j['width'] == null ? null : integer(j['width']),
        height: j['height'] == null ? null : integer(j['height']),
      );
  final String id;
  final String? entryId, caption, alt;
  final int? width, height;

  /// What a screen reader says for the photo.
  String get label => (alt?.isNotEmpty ?? false)
      ? alt!
      : (caption?.isNotEmpty ?? false)
          ? caption!
          : 'Photo';
}

List<HistoryPhoto> _photos(Object? v) => objs(v).map(HistoryPhoto.fromJson).toList();

class Capsule {
  const Capsule({
    required this.id,
    required this.studentId,
    required this.studentName,
    required this.title,
    required this.message,
    required this.status,
    required this.releaseKind,
    this.releaseAt,
    this.milestone,
    required this.mine,
    this.sealedAt,
    this.releasedAt,
    this.createdAt,
  });
  factory Capsule.fromJson(Json j) => Capsule(
        id: str(j['id']),
        studentId: str(j['studentId']),
        studentName: str(j['studentName']),
        title: str(j['title']),
        message: str(j['message']),
        status: str(j['status'], 'draft'),
        releaseKind: str(j['releaseKind'], 'scheduled'),
        releaseAt: date(j['releaseAt']),
        milestone: strOrNull(j['milestone']),
        mine: boolean(j['mine']),
        sealedAt: date(j['sealedAt']),
        releasedAt: date(j['releasedAt']),
        createdAt: date(j['createdAt']),
      );
  final String id, studentId, studentName, title, message, status, releaseKind;
  final DateTime? releaseAt, sealedAt, releasedAt, createdAt;
  final String? milestone;
  final bool mine;

  bool get isDraft => status == 'draft';
  bool get isReleased => status == 'released';
}

String opensText(String releaseKind, DateTime? releaseAt, String? milestone, String Function(DateTime?) day) =>
    releaseKind == 'milestone' ? 'Opens at: ${milestoneText[milestone] ?? milestone ?? 'a milestone'}' : 'Opens ${day(releaseAt)}';

class CapsuleItem {
  const CapsuleItem({required this.position, this.entryId, required this.withheld, this.entryType, this.kind, this.title, this.body, this.occurredAt, this.photos = const []});
  factory CapsuleItem.fromJson(Json j) => CapsuleItem(
        position: integer(j['position']),
        entryId: strOrNull(j['entryId']),
        withheld: boolean(j['withheld']),
        entryType: strOrNull(j['entryType']),
        kind: strOrNull(j['kind']),
        title: strOrNull(j['title']),
        body: strOrNull(j['body']),
        occurredAt: date(j['occurredAt']),
        photos: _photos(j['photos']),
      );
  final int position;
  final String? entryId, entryType, kind, title, body;
  final bool withheld;
  final DateTime? occurredAt;
  final List<HistoryPhoto> photos;
}

class CapsuleRecipient {
  const CapsuleRecipient(this.userId, this.name, this.type, this.consent);
  factory CapsuleRecipient.fromJson(Json j) => CapsuleRecipient(str(j['userId']), str(j['name']), str(j['type']), str(j['consent'], 'pending'));
  final String userId, name, type, consent;
}

class CapsuleEvent {
  const CapsuleEvent(this.type, this.outcome, this.reason, this.at);
  factory CapsuleEvent.fromJson(Json j) => CapsuleEvent(str(j['type']), strOrNull(j['outcome']), strOrNull(j['reason']), date(j['at']));
  final String type;
  final String? outcome, reason;
  final DateTime? at;
}

class CapsuleDetail {
  const CapsuleDetail(this.capsule, this.items, this.photos, this.recipients, this.events);
  factory CapsuleDetail.fromJson(Json j) => CapsuleDetail(
        Capsule.fromJson(j),
        objs(j['items']).map(CapsuleItem.fromJson).toList(),
        _photos(j['photos']),
        objs(j['recipients']).map(CapsuleRecipient.fromJson).toList(),
        objs(j['events']).map(CapsuleEvent.fromJson).toList(),
      );
  final Capsule capsule;
  final List<CapsuleItem> items;
  final List<HistoryPhoto> photos;
  final List<CapsuleRecipient> recipients;
  final List<CapsuleEvent> events;
}

class CapsuleInvitation {
  const CapsuleInvitation(
      {required this.capsuleId, required this.studentName, required this.from, required this.status, required this.releaseKind, this.releaseAt, this.milestone, required this.consent});
  factory CapsuleInvitation.fromJson(Json j) => CapsuleInvitation(
        capsuleId: str(j['capsuleId']),
        studentName: str(j['studentName']),
        from: str(j['from']),
        status: str(j['status']),
        releaseKind: str(j['releaseKind'], 'scheduled'),
        releaseAt: date(j['releaseAt']),
        milestone: strOrNull(j['milestone']),
        consent: str(j['consent'], 'pending'),
      );
  final String capsuleId, studentName, from, status, releaseKind, consent;
  final DateTime? releaseAt;
  final String? milestone;
}

class PendingMilestone {
  const PendingMilestone(this.capsuleId, this.studentName, this.from, this.milestone, this.sealedAt, this.accepted);
  factory PendingMilestone.fromJson(Json j) => PendingMilestone(str(j['capsuleId']), str(j['studentName']), str(j['from']), str(j['milestone']), date(j['sealedAt']), integer(j['accepted']));
  final String capsuleId, studentName, from, milestone;
  final DateTime? sealedAt;
  final int accepted;
}

class Candidate {
  const Candidate(this.id, this.title, this.entryType, this.kind, this.occurredAt);
  factory Candidate.fromJson(Json j) => Candidate(str(j['id']), str(j['title']), str(j['entryType']), str(j['kind']), date(j['occurredAt']));
  final String id, title, entryType, kind;
  final DateTime? occurredAt;
}

class RecipientOption {
  const RecipientOption(this.userId, this.name, this.type);
  factory RecipientOption.fromJson(Json j) => RecipientOption(str(j['userId']), str(j['name']), str(j['type']));
  final String userId, name, type;
}

class PortfolioItem {
  const PortfolioItem({
    required this.id,
    required this.entryType,
    required this.kind,
    required this.title,
    required this.body,
    this.occurredAt,
    required this.schoolYear,
    this.authorName,
    this.transferredFrom,
    this.photos = const [],
  });
  factory PortfolioItem.fromJson(Json j) => PortfolioItem(
        id: str(j['id']),
        entryType: str(j['entryType']),
        kind: str(j['kind']),
        title: str(j['title']),
        body: str(j['body']),
        occurredAt: date(j['occurredAt']),
        schoolYear: str(j['schoolYear']),
        authorName: strOrNull(j['authorName']),
        transferredFrom: strOrNull(j['transferredFrom']),
        photos: _photos(j['photos']),
      );
  final String id, entryType, kind, title, body, schoolYear;
  final DateTime? occurredAt;
  final String? authorName, transferredFrom;
  final List<HistoryPhoto> photos;
}

class PortfolioPage {
  const PortfolioPage({required this.studentId, required this.studentName, required this.items, this.nextCursor, this.years = const [], this.types = const [], this.kinds = const [], this.total = 0});
  factory PortfolioPage.fromJson(Json j) {
    final student = obj(j['student']);
    final facets = obj(j['facets']);
    List<String> strs(Object? v) => v is List ? v.map((e) => '$e').toList() : const [];
    return PortfolioPage(
      studentId: str(student['id']),
      studentName: str(student['name']),
      items: objs(j['items']).map(PortfolioItem.fromJson).toList(),
      nextCursor: strOrNull(j['nextCursor']),
      years: strs(facets['years']),
      types: strs(facets['types']),
      kinds: strs(facets['kinds']),
      total: integer(facets['total']),
    );
  }
  final String studentId, studentName;
  final List<PortfolioItem> items;
  final String? nextCursor;
  final List<String> years, types, kinds;
  final int total;
}

class HistoryDecision {
  const HistoryDecision(this.decision, this.reasonCode, this.note, this.at);
  factory HistoryDecision.fromJson(Json j) => HistoryDecision(str(j['decision']), strOrNull(j['reasonCode']), strOrNull(j['note']), date(j['at']));
  final String decision;
  final String? reasonCode, note;
  final DateTime? at;
  String get label => [decisionText[decision] ?? decision, if (reasonCode != null) reasonLabel(reasonCode), if (note != null && note!.isNotEmpty) '“$note”'].join(' · ');
}

/// A teacher's item (teacher list, review queue, family "from teachers").
class HistoryItem {
  const HistoryItem(
      {required this.id,
      required this.studentId,
      this.studentName,
      required this.entryType,
      required this.title,
      required this.body,
      this.occurredAt,
      required this.status,
      this.authorName,
      this.decisions = const [],
      this.photos = const []});
  factory HistoryItem.fromJson(Json j) => HistoryItem(
        id: str(j['id']),
        studentId: str(j['studentId']),
        studentName: strOrNull(j['studentName']),
        entryType: str(j['entryType']),
        title: str(j['title']),
        body: str(j['body']),
        occurredAt: date(j['occurredAt']),
        status: str(j['status']),
        authorName: strOrNull(j['authorName']),
        decisions: objs(j['decisions']).map(HistoryDecision.fromJson).toList(),
        photos: _photos(j['photos']),
      );
  final String id, studentId, entryType, title, body, status;
  final String? studentName, authorName;
  final DateTime? occurredAt;
  final List<HistoryDecision> decisions;
  final List<HistoryPhoto> photos;
}

/// A guardian's family memory (snake_case: the contribution routes return rows).
class Contribution {
  const Contribution({required this.id, required this.title, required this.body, this.occurredAt, required this.status, this.reviewNote, this.createdAt, this.photos = const []});
  factory Contribution.fromJson(Json j) => Contribution(
        id: str(j['id']),
        title: str(j['title']),
        body: str(j['body']),
        occurredAt: date(j['occurred_at'] ?? j['occurredAt']),
        status: str(j['status']),
        reviewNote: strOrNull(j['review_note'] ?? j['reviewNote']),
        createdAt: date(j['created_at'] ?? j['createdAt']),
        photos: _photos(j['photos']),
      );
  final String id, title, body, status;
  final String? reviewNote;
  final DateTime? occurredAt, createdAt;
  final List<HistoryPhoto> photos;
}

class FamilyTransfer {
  const FamilyTransfer({required this.id, required this.studentName, required this.school, required this.receivingDistrict, required this.basis, this.note, this.createdAt});
  factory FamilyTransfer.fromJson(Json j) => FamilyTransfer(
        id: str(j['id']),
        studentName: str(j['studentName']),
        school: str(j['school']),
        receivingDistrict: str(j['receivingDistrict']),
        basis: str(j['basis']),
        note: strOrNull(j['note']),
        createdAt: date(j['createdAt']),
      );
  final String id, studentName, school, receivingDistrict, basis;
  final String? note;
  final DateTime? createdAt;
}

const shareClassText = {'family_memory': 'Family memories', 'student_portfolio': 'My portfolio', 'teacher_artifact': "Teachers' items", 'official_record': 'Official records'};

class SharingGrant {
  const SharingGrant({required this.id, required this.who, required this.classifications, this.expiresAt, required this.active, this.studentId});
  factory SharingGrant.fromJson(Json j) => SharingGrant(
        id: str(j['id']),
        who: str(j['grantee'] ?? j['student']),
        studentId: strOrNull(j['studentId']),
        classifications: j['classifications'] is List ? (j['classifications'] as List).map((e) => '$e').toList() : const [],
        expiresAt: date(j['expiresAt']),
        active: j['active'] == null ? true : boolean(j['active']),
      );
  final String id, who;
  final String? studentId;
  final List<String> classifications;
  final DateTime? expiresAt;
  final bool active;
}

/// TC-11 GET /api/history/storage (only on servers with the family storage dashboard).
class StorageDashboard {
  const StorageDashboard({
    required this.studentName,
    required this.photosAllowed,
    required this.maxPhotoBytes,
    required this.maxPhotosPerItem,
    required this.maxBytesPerStudent,
    required this.usedBytes,
    required this.percent,
    required this.photos,
    required this.inLongTermStorage,
    required this.roomForAnotherPhoto,
    required this.inHistory,
    required this.waitingForReview,
    required this.drafts,
    this.myContributions,
    required this.capsules,
    required this.retentionText,
    required this.recordsScheduleRef,
    this.exportHref,
    required this.guidance,
    required this.donationsText,
  });
  factory StorageDashboard.fromJson(Json j) {
    final limits = obj(j['limits']), usage = obj(j['usage']), items = obj(j['items']), retention = obj(j['retention']);
    final mine = j['myContributions'] == null ? null : obj(j['myContributions']);
    return StorageDashboard(
      studentName: str(obj(j['student'])['name']),
      photosAllowed: boolean(limits['photosAllowed']),
      maxPhotoBytes: integer(limits['maxPhotoBytes']),
      maxPhotosPerItem: integer(limits['maxPhotosPerItem']),
      maxBytesPerStudent: integer(limits['maxBytesPerStudent']),
      usedBytes: integer(usage['usedBytes']),
      percent: number(usage['percent']) ?? 0,
      photos: integer(usage['photos']),
      inLongTermStorage: integer(usage['inLongTermStorage']),
      roomForAnotherPhoto: boolean(usage['roomForAnotherPhoto']),
      inHistory: integer(items['inHistory']),
      waitingForReview: integer(items['waitingForReview']),
      drafts: integer(items['drafts']),
      myContributions: mine == null
          ? null
          : {
              for (final k in ['waiting', 'accepted', 'declined', 'withdrawn']) k: integer(mine[k])
            },
      capsules: objs(j['capsules']).map((c) {
        final opens = obj(c['opens']);
        return (title: str(c['title']), status: str(c['status']), on: date(opens['on']), milestone: strOrNull(opens['milestone']));
      }).toList(),
      retentionText: str(retention['text']),
      recordsScheduleRef: str(retention['recordsScheduleRef']),
      exportHref: strOrNull(obj(j['export'])['href']),
      guidance: j['guidance'] is List ? (j['guidance'] as List).map((e) => '$e').toList() : const [],
      donationsText: str(obj(j['donations'])['text']),
    );
  }
  final String studentName;
  final bool photosAllowed, roomForAnotherPhoto;
  final int maxPhotoBytes, maxPhotosPerItem, maxBytesPerStudent, usedBytes, photos, inLongTermStorage, inHistory, waitingForReview, drafts;
  final double percent;
  final Map<String, int>? myContributions;
  final List<({String title, String status, DateTime? on, String? milestone})> capsules;
  final String retentionText, recordsScheduleRef, donationsText;
  final String? exportHref;
  final List<String> guidance;
}

/// "12.5 MB" style sizes for the storage dashboard.
String fmtBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  var v = bytes / 1024;
  var i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return '${v >= 100 ? v.round() : v.toStringAsFixed(1)} ${units[i]}';
}

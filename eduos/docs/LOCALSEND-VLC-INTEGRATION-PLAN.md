# LocalSend and VLC: integration plan

**Status:** plan, 2026-11-27. Nothing from either project is added to EduOS by this document. Work items in §6 build it later, one per PR.
**Asked for:** "incorporate" LocalSend (`localsend/localsend`) and VLC.
**Decisions recorded:**
- audit and plan first;
- students **may** share files with each other **within a class**, with the teacher able to see and stop it.

The second decision is a deliberate exception to the student app roadmap's "no unsupervised direct messaging" rule. It holds only because sharing is supervised: the district turns it on, the teacher opens each session, and every transfer is logged and visible to the teacher (§3.3).

## 1. Summary

| | LocalSend | VLC |
|---|---|---|
| What it is | Cross-platform AirDrop alternative: files between nearby devices over the local network, no internet or servers | Media player and engine (libVLC) that plays nearly every format and streaming protocol |
| Licence | Apache-2.0 | VLC app GPLv2+; libVLC engine and most playback modules LGPLv2.1+; Flutter binding `flutter_vlc_player` BSD-3-Clause |
| Fits EduOS as | **The pattern** (offer → accept → per-file token → hashed upload over TLS), rebuilt inside EduOS with EduOS deciding who may send to whom | **An optional playback engine** in the Flutter app for formats the platform players can't handle, limited to media from EduOS and the school node |
| Not as | The stock LocalSend app or open protocol on student devices: any device on the network could send to a student | A general-purpose player for arbitrary URLs, or casting from student devices |
| First step | Class Share on the school node (CS-01) | A format check of platform players against what schools actually have (MP-01) |

## 2. LocalSend

### 2.1 What it does
- **Platforms and reach:** a Flutter app for Windows, macOS, Linux, Android, iOS and Fire OS. It needs no internet connection or third-party servers.
- **Discovery:** devices announce themselves by UDP multicast (default `224.0.0.167`, port 53317) and register by HTTP, with an HTTP scan of the subnet as fallback.
- **Transfer:**
  - the sender posts file metadata to `prepare-upload`;
  - the receiver accepts all, some or none, and returns a session id and a token per file;
  - each file is uploaded with its token and, optionally, checked against a SHA-256.
- **Security:** HTTPS with a certificate generated on each device, whose SHA-256 is the device's fingerprint. An optional PIN is sent as a query parameter.
- **Browser receive:** works over plain HTTP, because browsers reject self-signed certificates.

### 2.2 Why not the stock app or open protocol on student devices
- **No identity:** a receiver can't tell a teacher from anyone else on the network. Fingerprints are self-generated, and in HTTP mode they're random strings.
- **Weak PIN:** an optional PIN in a URL is weak, and may end up in logs.
- **Visible names:** devices announce an alias on the whole network. On a school network that would show students' names to every device in range.
- **Unencrypted options:** browser receive is unencrypted, and the app suggests turning encryption off to go faster.
- **No oversight:** nothing records who sent what to whom, and nobody can stop it.

Each of these breaks an EduOS rule: identity from the district, school boundaries, no unapproved sharing, an audit trail, and protection for minors. EduOS therefore borrows LocalSend's **transfer design** and replaces its **trust model**.

### 2.3 Class Share: the EduOS design

**Sessions come from EduOS, not the network.**
- A teacher opens a Class Share session for one of their classes. The session holds: the class roster, an expiry (one period by default), whether student-to-student sharing is on, and allowed file types and sizes.
- It's created on the server, or on the school node when the internet is down (EDEN, `docs/EDEN-32.7.0.md`).

**Devices join with a pinned identity.**
- Each enrolled device's app creates a TLS key, as LocalSend does, and registers its certificate fingerprint with the session under the signed-in person.
- Devices then accept connections only from fingerprints on that session's list, so a stock LocalSend client, or any other device, is refused.

**No names on the network.**
- Discovery announces an opaque session-scoped id, never a name.
- Names appear only inside the EduOS app, from the roster, to people in the session.

**The transfer itself keeps LocalSend's steps:**
- an offer of metadata, which the receiver accepts or declines;
- a per-file token;
- SHA-256 required (not optional), with a mismatch rejected;
- TLS only (no unencrypted mode, no browser receive for students).

**Who can send:**
- **Teacher to students** (handouts) go direct, device to device, for speed. A student's app accepts automatically within the session, or asks, as the teacher sets.
- **Student to student** (only when the teacher turns it on) goes **through the school node**:
  - it's scanned with ClamAV, as EduOS media already is (`docs/MEDIA-STORAGE.md`);
  - its metadata is logged;
  - it's delivered to the recipient, who must accept it.
- Routing student files through the node is what makes "the teacher can see and stop it" real.

**Teacher console.** The teacher can see every transfer in the session (sender, recipient, file name, type, size, hash, time) and can:
- stop the session;
- pause a student's sending;
- remove a file still waiting at the node.

The district sees the same log through its audit.

**Content limits.**
- Documents, images, PDFs, audio and video only. Executables, scripts, installers and archives are refused by magic bytes, not by file extension.
- There are size limits per file and per session. No camera capture, under the existing no-camera policy: only files already on the device.

**After the session.**
- Received files stay in the app's own storage, not shared device storage, and are listed under the class.
- Student-to-student files at the node are deleted on a short retention schedule. Logs keep metadata only, never content.
- A **Report** button on any received file goes to the teacher and the principal.

### 2.4 Governance check

| Rule | How Class Share meets it |
|---|---|
| No unapproved third-party data sharing | Peer-to-peer on the school network, or via the district's own school node; no outside service |
| No weakening of RLS or school boundaries | Sessions are created through the same RLS as classes; peers are limited to the session roster |
| No vendor with unrestricted student-data access | None involved |
| Student-to-student sharing (roadmap Phase E rule) | Off unless the district enables it and the teacher turns it on per session; scanned, logged, visible and stoppable |
| No compliance claims without evidence | The plan makes none |

## 3. VLC

### 3.1 What it brings and what it costs
- **What it brings:** libVLC plays nearly every file format, codec and streaming protocol, and can cast to remote renderers. It can be embedded under LGPL terms if the application keeps libVLC clearly separate, which dynamic linking makes easier. The VLC application itself stays GPLv2+.
- **The Flutter binding:** `flutter_vlc_player` (BSD-3-Clause) supports Android and iOS only, not Windows, macOS, Linux or the web.
- **Costs to weigh:**
  - a large native library in every Android and iOS build;
  - LGPL obligations (notices, source availability, letting users relink). These are straightforward on Android, but need legal review on iOS, where the library is bundled into the app;
  - a media parser exposed to untrusted files, which must be kept up to date.

### 3.2 Where it would help EduOS
- **Offline and school-node media:** recordings, LRH digital resources (audio, video, offline archives) and older classroom media in formats the platform players don't support (for example MKV, or older codecs).
- **Clubs & Sports highlights** and approved event replays (`docs/CLUBS-SPORTS-MULTIMEDIA.md`). Live streams stay with the approved provider's player.
- **Not needed:**
  - **web:** the browser's own `<video>` covers common formats;
  - **Roku:** the TV channel has its own player;
  - **classroom displays:** these already follow the existing device rules.

### 3.3 Rules if it's added
- **Behind an interface:** a `MediaPlayer` interface in the Flutter app. The platform player (ExoPlayer and AVPlayer through `video_player`) is the default, and VLC is used only where MP-01 shows it's needed. Removing VLC must leave the app working, which is the removable-augmentation rule in `docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md` §4.1.
- **Allowed sources only:** EduOS's own origin, the school node, and allowlisted provider origins. No arbitrary URLs, and no `file://` outside the app's own storage.
- **Casting and network discovery switched off:** no Chromecast or UPnP renderer search from student devices.
- **Keep it current:** dependency tracking and CVE watch for libVLC.
- **Accessibility:** captions and subtitle tracks shown when present, and reduce-motion respected for autoplay. Media follows the same moderation and retention rules as other EduOS media.

## 4. What exists already

| Need | EduOS today |
|---|---|
| Offline operation | School nodes (EDEN), offline queue in the Flutter app |
| Media scanning and storage | S3-compatible storage with ClamAV (`docs/MEDIA-STORAGE.md`) |
| Device identity in classrooms | Classroom device pairing and room timetable (db/108–110) |
| Digital resources with checksums | LRH-01 catalog (db/171); provisioning to nodes is LRH-03 |
| Video playback | Browser `<video>` on the web, the Roku channel; **no video player in the Flutter app yet** |

## 5. Risks

| Risk | Mitigation |
|---|---|
| Bullying or inappropriate content in student-to-student sharing | Off by default; the teacher opens each session; scanned, logged, visible, stoppable, Report button; principal review |
| A device outside the session sends to a student | Only pinned session fingerprints are accepted; tests with a stock LocalSend client (CS-04) |
| Names exposed on the school network | Opaque ids in discovery; names only inside the app |
| Malware through shared files | Type allowlist by magic bytes; student files scanned at the node; no executables |
| Network isolation (AP isolation, VLANs) stops direct transfer | Fall back to relay through the school node |
| LGPL compliance for libVLC on iOS | Legal review before MP-02 ships on iOS; Android first |
| Media parser vulnerabilities | Allowed sources only; keep libVLC current; platform player by default |

## 6. Work items

| ID | Item | Depends on |
|---|---|---|
| LSV-00 | District decisions: Class Share on or off by default per district; peer sharing allowed; retention days; size limits | — |
| CS-01 | Class Share sessions: API and tables (session, roster, device fingerprints, transfer log), RLS, audit; school-node mirror for offline | LSV-00 |
| CS-02 | Flutter teacher-to-class handout: pinned TLS, offer/accept, per-file token, required SHA-256, type and size checks | CS-01 |
| CS-03 | Student-to-student via the school node: ClamAV scan, recipient accept, teacher console (see, pause, remove, stop), Report | CS-01, CS-02 |
| CS-04 | Tests: a stock LocalSend client and an out-of-session device are refused; an executable is refused; hash mismatch; teacher stop; no names in discovery packets | CS-02 |
| MP-01 | Format check: what platform players play from real school media and LRH resources, and what only libVLC plays | — |
| MP-02 | `MediaPlayer` interface in Flutter; platform player default; VLC on Android behind it if MP-01 shows a need; allowed sources; casting off | MP-01 |
| MP-03 | LGPL notices and source-availability page; iOS legal review | MP-02 |
| MP-04 | School-node media playback for LRH offline packages | LRH-03, MP-02 |

## Sources

- LocalSend: https://github.com/localsend/localsend (README) and https://github.com/localsend/protocol (protocol v2.2)
- libVLC licence: https://wiki.videolan.org/LibVLC and https://videolan.org/press/lgpl-libvlc.html, https://images.videolan.org/press/lgpl-modules.html
- `flutter_vlc_player`: https://pub.dev/packages/flutter_vlc_player/license and https://pub.dev/packages/flutter_vlc_player/score
- EduOS: `docs/EDEN-32.7.0.md`, `docs/MEDIA-STORAGE.md`, `docs/CLUBS-SPORTS-MULTIMEDIA.md`, `docs/STUDENT-APP-EXPANSION-ROADMAP.md`, `docs/RUFLO-BUGHUNTER-CAPABILITY-AUDIT.md`

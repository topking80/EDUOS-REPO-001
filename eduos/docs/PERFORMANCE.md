# Performance: mobile app and its hot API paths

These are measurements, not targets. Each number comes from a benchmark in this
repository that runs in CI, so a regression fails the build.

## How to run

- Flutter app, network and keystore paths: `cd mobile/flutter && flutter test test/performance_test.dart`.
  It simulates a 60 ms round trip per request and 3 ms per keystore operation,
  and prints `[perf]` lines.
- Server hot paths at district scale: `EDUOS_TEST_PG_URL=… node --test test/integration/performance-paths.test.js`.
  It uses 180,000 notifications for 3,000 people and a 2,000-student school day.

## Results (60 ms simulated round trip)

| Path | Before | After |
|---|---|---|
| App launch, signed in, to a ready home | 302 ms (4 requests in a row) | 99 ms (all at once) |
| Status poll (every 30 s per phone) | 134 ms, 26.5 KB | 62 ms, 82 bytes |
| Queue 200 marks offline: keystore operations | 400 | 201 (one read, then one write per mark) |
| Send 200 queued marks when the signal returns | 14.9 s, 603 keystore ops | 3.3 s, 50 keystore ops |
| The same mark tapped 5 times offline | 5 kept, 5 sent | 1 kept |
| Going back to a tab | spinner, then a fresh load | shown at once, refreshed in the background |
| Attendance today, 2,002-student school | the latest 500 marks of every day, filtered on the phone (students past 500 missing, corrected marks counted twice) | one response: 18 ms, 28 KB, every student counted once |
| Unread badge query, 180,000 notifications | all of the person's notifications scanned | partial index, 3.6 ms per request |

## What changed

- **Launch and poll.** The profile, branding, safety status and unread count
  are requested together. The poll asks for the unread count only
  (`GET /api/notifications?summary=1`), and screens are rebuilt only when
  something they show has changed.
- **API client.** Identical GETs that are already on the wire share one
  request. Responses of 48 KB or more are parsed off the UI thread.
- **Offline queue.**
  - The keystore is read once and kept in memory; the queue is its only
    writer.
  - Queued marks are sent four at a time for different students. One
    student's marks (or one roll call) stay in order.
  - A repeated identical mark is kept once. A change and a change back are
    both kept.
  - Replays stay safe because the server applies each Idempotency-Key once
    and judges every mark by when it happened.
- **Tabs.** The four most recent tabs stay built, so going back shows them at
  once. `Loader` refreshes the tab in the background.
- **Attendance today.** `GET /api/attendance/day?date=` returns each student's
  latest mark that day counted by status, plus the students who weren't
  present. Visibility is the same as `GET /api/attendance`. The web app and
  the Flutter app both use it; the list is built lazily as it scrolls.
- **Indexes.** Migration 045 adds a partial index for unread notifications and
  an index for "a student's marks on a day".

## Not measured here

- Frame timings on real devices.
- Release-build app size.
- Battery use.

These need a device lab (`flutter drive --profile` with a timeline summary)
and aren't part of CI.

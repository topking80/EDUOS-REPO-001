// ROOM-02: remote lesson links are limited to the approved meeting services.
import { test } from "node:test";
import assert from "node:assert/strict";
import { meetingProvider } from "../src/remote-lesson.js";

test("allowed meeting links name their service", () => {
  assert.equal(meetingProvider("https://meet.google.com/abc-defg-hij"), "Google Meet");
  assert.equal(meetingProvider("https://us02web.zoom.us/j/123456789?pwd=x"), "Zoom");
  assert.equal(meetingProvider("https://teams.microsoft.com/l/meetup-join/abc"), "Microsoft Teams");
  assert.equal(meetingProvider("https://district.webex.com/meet/teacher"), "Webex");
});

test("anything else is refused", () => {
  for (const u of ["http://meet.google.com/abc", "https://meet.google.com.evil.example/abc", "https://evilzoom.us/j/1", "https://u:p@zoom.us/j/1",
    "https://zoom.us:8443/j/1", "https://example.org/meet", "javascript:alert(1)", "https://zoom.us/j/1 x", "", null, 5])
    assert.equal(meetingProvider(u), null, String(u));
});

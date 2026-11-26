import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  EVENT_KINDS, PASS_KINDS, STREAM_ACCESS_MODES, STREAM_PROVIDER_CHOICES,
  canPublishEvents, eventSchoolAllowed,
  hashStreamSecret, signStreamToken, verifyStreamToken, evaluateStreamAccess
} from "../src/event-streaming.js";

const root = new URL("../", import.meta.url);
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("event kinds and pass kinds cover plays, live events, and stream passes", () => {
  for (const k of ["sport", "play", "concert", "assembly", "ceremony", "club_showcase", "recital", "other"]) {
    assert.ok(EVENT_KINDS.includes(k));
  }
  assert.ok(STREAM_PROVIDER_CHOICES.includes("mux") && STREAM_PROVIDER_CHOICES.includes("none"));
  assert.equal(canPublishEvents("teacher"), true);
  assert.equal(canPublishEvents("vice_principal"), true);
  assert.equal(canPublishEvents("parent"), false);
  assert.equal(eventSchoolAllowed({ role: "teacher", schoolId: id(1) }, id(1)), true);
  assert.equal(eventSchoolAllowed({ role: "teacher", schoolId: id(1) }, id(2)), false);
  assert.equal(eventSchoolAllowed({ role: "superintendent", schoolId: null }, id(2)), true);
  assert.deepEqual([...PASS_KINDS], ["admission", "stream_pass", "season_stream_pass"]);
  assert.deepEqual([...STREAM_ACCESS_MODES], ["free", "paid_pass"]);
  assert.equal(hashStreamSecret("short"), null);
  assert.equal(hashStreamSecret("stream-secret-value-12345")?.length, 64);
});

test("stream access tokens sign and verify strictly within scope", () => {
  const sec = "unit-test-signing-secret-32-chars";
  const { token } = signStreamToken({ streamId: id(1), eventId: id(2), districtId: id(3), userId: id(4), masked: true }, sec, 120);
  const ok = verifyStreamToken(token, sec, { eventId: id(2), districtId: id(3), userId: id(4) });
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.masked, true);
  assert.equal(verifyStreamToken(token, sec, { eventId: id(9), districtId: id(3), userId: id(4) }).reason, "stream_token_scope_mismatch");
  assert.equal(verifyStreamToken(token + "x", sec, { eventId: id(2) }).reason, "invalid_stream_token");
});

test("stream access fails closed for kill switch, unmasked minors, and missing paid pass", () => {
  assert.equal(evaluateStreamAccess({ stream: null, hasPass: true, isLead: true }).reason, "stream_live_kill_switch_off" === "x" ? "x" : "stream_not_found");
  assert.equal(evaluateStreamAccess({ stream: { live_enabled: false }, hasPass: true, isLead: true }).reason, "stream_live_kill_switch_off");
  assert.equal(evaluateStreamAccess({
    stream: { live_enabled: true, media_consent_required: true, unconsented_minors_masked: false, access_mode: "free" },
    hasPass: true, isLead: true, unconsentedCount: 2
  }).reason, "media_consent_masking_required");
  assert.equal(evaluateStreamAccess({
    stream: { live_enabled: true, media_consent_required: true, unconsented_minors_masked: true, access_mode: "paid_pass", audience: "ticket_holders" },
    hasPass: false, isLead: false, unconsentedCount: 2
  }).reason, "stream_pass_required");
  const ok = evaluateStreamAccess({
    stream: { live_enabled: true, media_consent_required: true, unconsented_minors_masked: true, access_mode: "paid_pass", audience: "ticket_holders" },
    hasPass: true, isLead: false, unconsentedCount: 2
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.unconsentedExcludedOrBlurred, true);
});

test("migration 156 forces RLS, keeps live_enabled false by default, and grants via template only", async () => {
  const sql = await readFile(new URL("db/156_event_tickets_paid_streams.sql", root), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS school_stream_seasons/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS district_stream_settings/);
  assert.match(sql, /recital/);
  assert.match(sql, /live_enabled boolean NOT NULL DEFAULT false/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.doesNotMatch(sql, /TO eduos_app/);
  const grants = await readFile(new URL("db/runtime_grants.template.sql", root), "utf8");
  assert.match(grants, /GRANT SELECT, INSERT ON school_stream_seasons TO eduos_app/);
  assert.match(grants, /GRANT SELECT, INSERT ON district_stream_settings TO eduos_app/);
  const server = await readFile(new URL("src/server.js", root), "utf8");
  assert.match(server, /registerEventStreamingRoutes\(app\)/);
});

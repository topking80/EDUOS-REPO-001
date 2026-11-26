// Standalone live events (plays, concerts), tickets, and paywalled streams
// against real PostgreSQL + sandbox commerce.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PG_URL, ID, USERS, startIdp, baseEnv, run, createDatabase, seed, startServer, login, client } from "./harness.js";

const skip = PG_URL ? false : "set EDUOS_TEST_PG_URL to a PostgreSQL 15+ superuser URL to run";
const future = h => new Date(Date.now() + h * 3600e3).toISOString();
const key = n => `evt-stream-test-key-${n}-${"0".repeat(20)}`;

describe("live event tickets & paywalled streams against real PostgreSQL", { skip }, () => {
  let db, idp, server, admin, s = {}, play, concert, season, admType, playPassType, seasonPassType;
  const as = name => client(server.base, s[name]);

  before(async () => {
    db = await createDatabase();
    idp = await startIdp();
    const env = baseEnv({ OIDC_ISSUER: idp.issuer, EDUOS_APP_ROLE: db.names.app });
    const migrated = await run(["src/migrate.js"], { ...env, DATABASE_URL: db.ownerUrl });
    assert.equal(migrated.code, 0, migrated.out);
    await seed(db.adminUrl, idp.issuer);
    admin = new pg.Client(db.adminUrl); await admin.connect();
    server = await startServer({ ...env, DATABASE_URL: db.appUrl, COMMERCE_SECRETS_KEY: "k".repeat(16) + "-commerce-test-key-0123456789" });
    for (const name of ["supt1", "p1", "p2", "t1", "vp1", "pa", "pb", "pu"]) s[name] = await login(server.base, idp, name, { email_verified: true });
    assert.equal((await as("supt1")("PUT", "/api/commerce/payment-methods", { enabledMethods: ["sandbox"], defaultMethod: "sandbox" })).status, 200);
    assert.equal((await as("supt1")("PUT", "/api/commerce/settings", { enabled: true })).status, 200);
    // Keep sandbox-only mode explicit (no live payments).
    const st = (await as("supt1")("GET", "/api/commerce/status")).body.data;
    assert.equal(st.live, false);

    // Create a stream season and two standalone live events (play + concert).
    const ss = await as("p1")("POST", "/api/stream-seasons", {
      title: "2026-2027 Performing Arts", schoolYear: "2026-2027", startsAt: future(-24), endsAt: future(24 * 180)
    });
    assert.equal(ss.status, 201, JSON.stringify(ss.body));
    season = ss.body.data;

    const pRes = await as("p1")("POST", "/api/events", {
      eventKind: "play", title: "Spring Musical", venue: "Main Auditorium", startsAt: future(24), endsAt: future(27), publish: true
    });
    assert.equal(pRes.status, 201, JSON.stringify(pRes.body));
    play = pRes.body.data;
    assert.equal(play.activity_id, null);
    assert.equal(play.event_kind, "play");

    const cRes = await as("p1")("POST", "/api/events", {
      eventKind: "concert", title: "Winter Band Concert", venue: "Auditorium", startsAt: future(48), endsAt: future(50), publish: true
    });
    assert.equal(cRes.status, 201, JSON.stringify(cRes.body));
    concert = cRes.body.data;

    admType = (await as("p1")("POST", `/api/events/${play.id}/ticket-types`, {
      name: "Front Row", passKind: "admission", priceCents: 1200, capacity: 50, salesOpen: true
    })).body.data;
    playPassType = (await as("p1")("POST", `/api/events/${play.id}/ticket-types`, {
      name: "Play Livestream Pass", passKind: "stream_pass", priceCents: 800, capacity: 200, salesOpen: true
    })).body.data;
    seasonPassType = (await as("p1")("POST", `/api/events/${concert.id}/ticket-types`, {
      name: "Season Stream Pass", passKind: "season_stream_pass", streamSeasonId: season.id, priceCents: 2500, capacity: 200, salesOpen: true
    })).body.data;
  });

  after(async () => { await server?.stop(); await admin?.end(); await idp?.close(); await db?.drop(); });

  it("parents buy standalone play tickets in sandbox; teachers check in play tickets at the door", async () => {
    const shop = await as("pa")("GET", "/api/commerce/shop");
    assert.equal(shop.status, 200);
    const shopPlay = shop.body.data.events.find(e => e.id === play.id);
    assert.equal(shopPlay.eventKind, "play");
    assert.equal(shopPlay.ticketTypes.find(t => t.id === admType.id).passKind, "admission");

    const order = await as("pa")("POST", `/api/events/${play.id}/tickets`, {
      ticketTypeId: admType.id, quantity: 1, idempotencyKey: key(1), paymentMethod: "sandbox"
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    const conf = await as("pa")("POST", `/api/commerce/payments/${order.body.data.payment.id}/confirm`, { testOutcome: "sandbox_success" });
    assert.equal(conf.status, 200, JSON.stringify(conf.body));
    assert.equal(conf.body.data.status, "succeeded");
    const code = conf.body.data.tickets[0].code;

    const ci = await as("t1")("POST", `/api/events/${play.id}/check-in`, { ticketCode: code });
    assert.equal(ci.status, 200, JSON.stringify(ci.body));
    assert.equal(ci.body.data.status, "checked_in");
  });

  it("paywalled streams enforce kill switch, media consent masking, per-event passes, and season passes", async () => {
    // Default kill switch is OFF; streamSecret is write-only.
    const cfg1 = await as("p1")("PUT", `/api/events/${play.id}/stream`, {
      audience: "ticket_holders", accessMode: "paid_pass", streamSeasonId: season.id,
      liveEnabled: false, mediaConsentRequired: true, unconsentedMinorsMasked: false,
      streamSecret: "my-super-secret-stream-key-2026"
    });
    assert.equal(cfg1.status, 200, JSON.stringify(cfg1.body));
    assert.equal(cfg1.body.data.liveEnabled, false);
    assert.equal(cfg1.body.data.hasStreamSecret, true);
    assert.equal(cfg1.body.data.stream_secret_hash, undefined);

    assert.equal((await as("pa")("POST", `/api/events/${play.id}/stream/access`)).body.error, "stream_live_kill_switch_off");

    // Register unconsented minor participant on play media; turning stream live without masking fails closed.
    const asset = (await admin.query(
      `INSERT INTO activity_media_assets(district_id,school_id,event_id,media_kind,storage_key,mime_type,byte_size,uploaded_by)
       VALUES($1,$2,$3,'video','events/play-preview.mp4','video/mp4',1024,$4) RETURNING id`,
      [ID.d1, ID.s1, play.id, USERS.p1[0]])).rows[0].id;
    await admin.query(
      `INSERT INTO activity_media_participants(district_id,school_id,media_asset_id,student_id,consent_status,added_by)
       VALUES($1,$2,$3,$4,'pending',$5)`,
      [ID.d1, ID.s1, asset, ID.alice, USERS.p1[0]]);

    assert.equal((await as("p1")("PUT", `/api/events/${play.id}/stream`, {
      audience: "ticket_holders", accessMode: "paid_pass", streamSeasonId: season.id,
      liveEnabled: true, mediaConsentRequired: true, unconsentedMinorsMasked: false
    })).status, 200);
    assert.equal((await as("p1")("POST", `/api/events/${play.id}/stream/access`)).body.error, "media_consent_masking_required");

    // Enable unconsented minor masking; pa (admission-only, no stream pass) still blocked until buying stream_pass.
    assert.equal((await as("p1")("PUT", `/api/events/${play.id}/stream`, {
      audience: "ticket_holders", accessMode: "paid_pass", streamSeasonId: season.id,
      liveEnabled: true, mediaConsentRequired: true, unconsentedMinorsMasked: true
    })).status, 200);
    assert.equal((await as("pa")("POST", `/api/events/${play.id}/stream/access`)).body.error, "stream_pass_required");
    assert.equal((await as("pb")("POST", `/api/events/${play.id}/stream/access`)).body.error, "stream_pass_required");

    // pa buys per-event stream pass via sandbox -> access granted + token verified.
    const passOrder = await as("pa")("POST", `/api/events/${play.id}/tickets`, {
      ticketTypeId: playPassType.id, quantity: 1, idempotencyKey: key(2), paymentMethod: "sandbox"
    });
    assert.equal(passOrder.status, 201, JSON.stringify(passOrder.body));
    assert.equal((await as("pa")("POST", `/api/commerce/payments/${passOrder.body.data.payment.id}/confirm`, { testOutcome: "sandbox_success" })).status, 200);
    const access = await as("pa")("POST", `/api/events/${play.id}/stream/access`);
    assert.equal(access.status, 200, JSON.stringify(access.body));
    assert.equal(access.body.data.playbackEnabled, true);
    assert.equal(access.body.data.mediaPolicy.unconsentedExcludedOrBlurred, true);

    const ver = await as("pa")("GET", `/api/events/${play.id}/stream/verify?token=${encodeURIComponent(access.body.data.token)}`);
    assert.equal(ver.status, 200, JSON.stringify(ver.body));
    assert.equal(ver.body.data.valid, true);
    assert.equal((await as("pb")("GET", `/api/events/${play.id}/stream/verify?token=${encodeURIComponent(access.body.data.token)}`)).status, 403);

    // pb buys season_stream_pass on concert -> gets stream access to BOTH concert AND play in that season.
    assert.equal((await as("p1")("PUT", `/api/events/${concert.id}/stream`, {
      audience: "ticket_holders", accessMode: "paid_pass", streamSeasonId: season.id, liveEnabled: true
    })).status, 200);
    const seasonOrder = await as("pb")("POST", `/api/events/${concert.id}/tickets`, {
      ticketTypeId: seasonPassType.id, quantity: 1, idempotencyKey: key(3), paymentMethod: "sandbox"
    });
    assert.equal(seasonOrder.status, 201, JSON.stringify(seasonOrder.body));
    assert.equal((await as("pb")("POST", `/api/commerce/payments/${seasonOrder.body.data.payment.id}/confirm`, { testOutcome: "sandbox_success" })).status, 200);
    assert.equal((await as("pb")("POST", `/api/events/${concert.id}/stream/access`)).status, 200);
    assert.equal((await as("pb")("POST", `/api/events/${play.id}/stream/access`)).status, 200);
    assert.equal((await as("pa")("POST", `/api/events/${concert.id}/stream/access`)).status, 403);

    const auditRow = await admin.query("SELECT detail FROM audit_events WHERE resource_type='event_stream' AND action='stream_access' ORDER BY occurred_at DESC LIMIT 1");
    assert.match(String(auditRow.rows[0].detail), /granted=1/);
  });

  it("teachers, vice principals and athletic directors publish recitals for their own school and can add stream passes", async () => {
    const recital = await as("t1")("POST", "/api/events", {
      eventKind: "recital", title: "Spring Choir Recital", venue: "Choir Room", startsAt: future(72), endsAt: future(74), publish: true
    });
    assert.equal(recital.status, 201, JSON.stringify(recital.body));
    assert.equal(recital.body.data.event_kind, "recital");
    assert.equal(recital.body.data.status, "published");
    assert.equal(recital.body.data.school_id, ID.s1);

    const vpPub = await as("vp1")("POST", "/api/events", {
      eventKind: "concert", title: "VP Band Concert", venue: "Auditorium", startsAt: future(80), endsAt: future(82), publish: true
    });
    assert.equal(vpPub.status, 201, JSON.stringify(vpPub.body));
    assert.equal(vpPub.body.data.status, "published");

    await admin.query("INSERT INTO school_athletic_directors(district_id,school_id,user_id,assigned_by) VALUES($1,$2,$3,$4)",
      [ID.d1, ID.s1, USERS.t1[0], USERS.p1[0]]);
    const adPub = await as("t1")("PATCH", `/api/events/${recital.body.data.id}`, { status: "published", title: "Spring Choir Recital (AD)" });
    assert.equal(adPub.status, 200, JSON.stringify(adPub.body));

    const pass = await as("t1")("POST", `/api/events/${recital.body.data.id}/ticket-types`, {
      name: "Recital Livestream", passKind: "stream_pass", priceCents: 500, capacity: 100, salesOpen: true
    });
    assert.equal(pass.status, 201, JSON.stringify(pass.body));
    assert.equal(pass.body.data.pass_kind, "stream_pass");

    assert.equal((await as("pa")("POST", "/api/events", {
      eventKind: "recital", title: "Family Recital", startsAt: future(90), endsAt: future(92), publish: true
    })).status, 403);
    const cross = await as("p2")("POST", "/api/events", {
      eventKind: "recital", title: "Other school recital", schoolId: ID.s1, startsAt: future(90), endsAt: future(92), publish: true
    });
    assert.equal(cross.status, 201, JSON.stringify(cross.body));
    assert.equal(cross.body.data.school_id, ID.s2, "a principal cannot publish to another school");
  });

  it("the superintendent picks a district stream provider; credentials are write-only and never returned", async () => {
    const empty = await as("p1")("GET", "/api/stream-provider");
    assert.equal(empty.status, 200);
    assert.equal(empty.body.data.provider, "none");
    assert.equal(empty.body.data.hasCredentials, false);

    assert.equal((await as("t1")("PUT", "/api/stream-provider", { provider: "mux", credentials: { apiToken: "mux-live-token-should-never-return" } })).status, 403);
    const saved = await as("supt1")("PUT", "/api/stream-provider", { provider: "mux", credentials: { apiToken: "mux-live-token-should-never-return" } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.provider, "mux");
    assert.equal(saved.body.data.hasCredentials, true);
    assert.equal(saved.body.data.apiToken, undefined);
    assert.equal(saved.body.data.credentials, undefined);
    assert.equal(saved.body.data.secrets_enc, undefined);
    const raw = JSON.stringify(saved.body);
    assert.equal(raw.includes("mux-live-token-should-never-return"), false);

    const again = await as("pa")("GET", "/api/stream-provider");
    assert.equal(again.status, 200);
    assert.equal(again.body.data.provider, "mux");
    assert.equal(again.body.data.hasCredentials, true);
    assert.equal(JSON.stringify(again.body).includes("mux-live-token-should-never-return"), false);

    const stored = await admin.query("SELECT secrets_enc, provider FROM district_stream_settings WHERE district_id=$1", [ID.d1]);
    assert.equal(stored.rows[0].provider, "mux");
    assert.match(stored.rows[0].secrets_enc, /^c1\./);
    assert.equal(stored.rows[0].secrets_enc.includes("mux-live-token-should-never-return"), false);
  });
});

// Standalone live events (plays, concerts, assemblies) and paywalled livestreams (db/154).
import { requireSession, requireCsrf } from "./auth.js";
import { withTenantTransaction } from "./db.js";
import { config } from "./config.js";
import { audit, rows, one, validId, cleanText, HttpError, sendError } from "./role-app-util.js";
import { EVENT_KINDS, STREAM_ACCESS_MODES, hashStreamSecret, signStreamToken, verifyStreamToken, evaluateStreamAccess } from "./event-streaming.js";

const DISTRICT = role => ["superintendent", "it_admin"].includes(role);
const LEAD = role => ["superintendent", "principal"].includes(role);
const EVENT_CREATOR = role => LEAD(role) || ["vice_principal", "teacher"].includes(role);
const STREAM_PROVIDERS = ["mux", "cloudflare_stream", "vimeo", "youtube_unlisted"];
const signingSecret = () => config.commerceSecretsKey || config.oidcClientSecret;

const wrap = fn => async (req, res, next) => {
  try {
    const data = await withTenantTransaction(req.actor, c => fn(c, req));
    res.setHeader("Cache-Control", "no-store");
    res.json({ data });
  } catch (e) { sendError(res, next, e); }
};

function safeStream(s) {
  if (!s) return null;
  return {
    id: s.id, eventId: s.event_id, schoolId: s.school_id, status: s.status, audience: s.audience,
    accessMode: s.access_mode, liveEnabled: Boolean(s.live_enabled), streamSeasonId: s.stream_season_id || null,
    mediaConsentRequired: Boolean(s.media_consent_required), unconsentedMinorsMasked: Boolean(s.unconsented_minors_masked),
    startsAt: s.starts_at, endsAt: s.ends_at, recordingAllowed: Boolean(s.recording_allowed),
    provider: s.provider || null, hasStreamSecret: Boolean(s.has_stream_secret)
  };
}

async function countUnconsentedParticipants(c, districtId, event) {
  const row = await one(c, `SELECT count(DISTINCT p.student_id)::int AS n
      FROM activity_media_participants p
      JOIN activity_media_assets m ON m.id=p.media_asset_id AND m.district_id=p.district_id
     WHERE p.district_id=$1 AND p.school_id=$2
       AND (m.event_id=$3 OR ($4::uuid IS NOT NULL AND m.activity_id=$4))
       AND p.consent_status <> 'approved'`,
    [districtId, event.school_id, event.id, event.activity_id || null]);
  return row?.n ?? 0;
}

async function userHasStreamPass(c, districtId, userId, stream) {
  const row = await one(c, `SELECT 1
      FROM event_ticket_orders o
      JOIN event_tickets t ON t.order_id=o.id AND t.district_id=o.district_id
      JOIN event_ticket_types tt ON tt.id=o.ticket_type_id AND tt.district_id=o.district_id
     WHERE o.district_id=$1 AND o.buyer_user_id=$2
       AND o.status IN ('complimentary', 'paid') AND o.refund_pending=false
       AND t.status IN ('issued', 'checked_in')
       AND (
         (o.event_id=$3 AND (
           ($4='paid_pass' AND tt.pass_kind IN ('stream_pass','season_stream_pass'))
           OR ($4='free' AND tt.pass_kind IN ('admission','stream_pass','season_stream_pass'))
         ))
         OR ($5::uuid IS NOT NULL AND tt.pass_kind='season_stream_pass' AND tt.stream_season_id=$5)
       )
     LIMIT 1`,
    [districtId, userId, stream.event_id, stream.access_mode, stream.stream_season_id || null]);
  return Boolean(row);
}

export function registerEventStreamingRoutes(app) {
  // Standalone live events (plays, concerts, assemblies, ceremonies, club showcases, etc.).
  app.post("/api/events", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!EVENT_CREATOR(a.role)) return res.status(403).json({ error: "event_creator_role_required" });
    const kind = b.eventKind || (b.activityId ? "sport" : "play");
    if (!EVENT_KINDS.includes(kind) || (b.activityId && !validId(b.activityId))
      || !cleanText(b.title, 180, 2) || !Number.isFinite(Date.parse(b.startsAt)) || !Number.isFinite(Date.parse(b.endsAt))
      || Date.parse(b.endsAt) <= Date.parse(b.startsAt) || !cleanText(b.venue || "", 300, 0)) {
      return res.status(400).json({ error: "invalid_event" });
    }
    try {
      const data = await withTenantTransaction(a, async c => {
        const schoolId = DISTRICT(a.role) && validId(b.schoolId) ? b.schoolId : a.schoolId;
        if (!schoolId) throw new HttpError(400, "school_context_required");
        let activityId = null;
        if (b.activityId) {
          const act = await one(c, "SELECT id, school_id FROM school_activities WHERE id=$1 AND district_id=$2", [b.activityId, a.districtId]);
          if (!act || act.school_id !== schoolId) throw new HttpError(404, "activity_not_found");
          activityId = act.id;
        }
        const status = LEAD(a.role) && b.publish === true ? "published" : "draft";
        const r = await one(c, `INSERT INTO school_events(district_id,school_id,activity_id,event_kind,title,description,starts_at,ends_at,venue,status,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
          [a.districtId, schoolId, activityId, kind, b.title.trim(), String(b.description || "").slice(0, 4000),
           new Date(b.startsAt).toISOString(), new Date(b.endsAt).toISOString(), (b.venue || "").trim(), status, a.userId]);
        await audit(c, req, "create", "school_event", r.id, `kind=${kind};status=${r.status}`);
        return r;
      });
      res.status(201).json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.patch("/api/events/:id", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!LEAD(a.role)) return res.status(403).json({ error: "school_lead_required" });
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_event_id" });
    if (b.eventKind !== undefined && !EVENT_KINDS.includes(b.eventKind)) return res.status(400).json({ error: "invalid_event_kind" });
    if (b.status !== undefined && !["draft", "published", "cancelled"].includes(b.status)) return res.status(400).json({ error: "invalid_event_status" });
    try {
      const data = await withTenantTransaction(a, async c => {
        const cur = await one(c, "SELECT * FROM school_events WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) FOR UPDATE",
          [req.params.id, a.districtId, DISTRICT(a.role) ? null : a.schoolId]);
        if (!cur) throw new HttpError(404, "event_not_found");
        const title = b.title !== undefined ? cleanText(b.title, 180, 2) : cur.title;
        if (!title) throw new HttpError(400, "invalid_event_title");
        const startsAt = b.startsAt !== undefined ? new Date(b.startsAt).toISOString() : cur.starts_at;
        const endsAt = b.endsAt !== undefined ? new Date(b.endsAt).toISOString() : cur.ends_at;
        if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new HttpError(400, "invalid_event_dates");
        const r = await one(c, `UPDATE school_events SET event_kind=$2,title=$3,description=$4,venue=$5,starts_at=$6,ends_at=$7,status=$8 WHERE id=$1 RETURNING *`,
          [cur.id, b.eventKind ?? cur.event_kind, title, b.description !== undefined ? String(b.description).slice(0, 4000) : cur.description,
           b.venue !== undefined ? String(b.venue).trim().slice(0, 300) : cur.venue, startsAt, endsAt, b.status ?? cur.status]);
        await audit(c, req, "update", "school_event", r.id, `kind=${r.event_kind};status=${r.status}`);
        return r;
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Stream seasons for season passes.
  app.get("/api/stream-seasons", requireSession, wrap(async (c, req) => {
    const a = req.actor;
    if (!["superintendent", "it_admin", "principal", "vice_principal", "teacher", "parent", "pupil"].includes(a.role)) {
      throw new HttpError(403, "stream_seasons_forbidden");
    }
    return rows(c, `SELECT s.id,s.school_id,sc.name AS school_name,s.title,s.school_year,s.starts_at,s.ends_at,s.status
        FROM school_stream_seasons s JOIN schools sc ON sc.id=s.school_id AND sc.district_id=s.district_id
       WHERE s.district_id=$1 AND ($2::uuid IS NULL OR s.school_id=$2)
       ORDER BY s.starts_at DESC LIMIT 100`,
      [a.districtId, DISTRICT(a.role) ? null : a.schoolId]);
  }));

  app.post("/api/stream-seasons", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!LEAD(a.role)) return res.status(403).json({ error: "school_lead_required" });
    if (!cleanText(b.title, 140, 2) || typeof b.schoolYear !== "string" || !/^\d{4}-\d{4}$/.test(b.schoolYear)
      || !Number.isFinite(Date.parse(b.startsAt)) || !Number.isFinite(Date.parse(b.endsAt)) || Date.parse(b.endsAt) <= Date.parse(b.startsAt)) {
      return res.status(400).json({ error: "invalid_stream_season" });
    }
    try {
      const data = await withTenantTransaction(a, async c => {
        const schoolId = DISTRICT(a.role) && validId(b.schoolId) ? b.schoolId : a.schoolId;
        if (!schoolId) throw new HttpError(400, "school_context_required");
        const r = await one(c, `INSERT INTO school_stream_seasons(district_id,school_id,title,school_year,starts_at,ends_at,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,school_id,title,school_year,starts_at,ends_at,status`,
          [a.districtId, schoolId, b.title.trim(), b.schoolYear, new Date(b.startsAt).toISOString(), new Date(b.endsAt).toISOString(), a.userId]);
        await audit(c, req, "create", "school_stream_season", r.id, `year=${r.school_year}`);
        return r;
      });
      res.status(201).json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Configure or update an event stream (paywall, season pass, default-off kill switch, consent masking, write-only secret).
  app.put("/api/events/:id/stream", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor, b = req.body || {};
    if (!LEAD(a.role)) return res.status(403).json({ error: "school_lead_required" });
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_event_id" });
    const audience = b.audience || "school";
    const accessMode = b.accessMode || "free";
    if (!["school", "district", "ticket_holders"].includes(audience) || !STREAM_ACCESS_MODES.includes(accessMode)) {
      return res.status(400).json({ error: "invalid_stream_config" });
    }
    if (b.provider !== undefined && b.provider !== null && !STREAM_PROVIDERS.includes(b.provider)) {
      return res.status(400).json({ error: "invalid_stream_provider" });
    }
    if (b.streamSeasonId !== undefined && b.streamSeasonId !== null && !validId(b.streamSeasonId)) {
      return res.status(400).json({ error: "invalid_stream_season_id" });
    }
    let secretHash = undefined;
    if (b.streamSecret !== undefined && b.streamSecret !== null && b.streamSecret !== "") {
      secretHash = hashStreamSecret(b.streamSecret);
      if (!secretHash) return res.status(400).json({ error: "invalid_stream_secret" });
    }
    try {
      const data = await withTenantTransaction(a, async c => {
        const event = await one(c, "SELECT * FROM school_events WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3) FOR UPDATE",
          [req.params.id, a.districtId, DISTRICT(a.role) ? null : a.schoolId]);
        if (!event) throw new HttpError(404, "event_not_found");
        if (b.streamSeasonId) {
          const season = await one(c, "SELECT id FROM school_stream_seasons WHERE id=$1 AND district_id=$2 AND school_id=$3",
            [b.streamSeasonId, a.districtId, event.school_id]);
          if (!season) throw new HttpError(404, "stream_season_not_found");
        }
        const startsAt = b.startsAt ? new Date(b.startsAt).toISOString() : event.starts_at;
        const endsAt = b.endsAt ? new Date(b.endsAt).toISOString() : event.ends_at;
        if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new HttpError(400, "invalid_stream_schedule");
        const cur = await one(c, "SELECT * FROM event_streams WHERE event_id=$1 AND district_id=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE",
          [event.id, a.districtId]);
        const liveEnabled = b.liveEnabled === true;
        const mediaConsentRequired = b.mediaConsentRequired !== false;
        const unconsentedMasked = b.unconsentedMinorsMasked === true;
        const status = liveEnabled ? "live" : (b.status && ["planned", "provider_pending", "ended", "cancelled"].includes(b.status) ? b.status : "planned");
        let r;
        if (cur) {
          r = await one(c, `UPDATE event_streams SET status=$2,audience=$3,access_mode=$4,live_enabled=$5,stream_season_id=$6,
              media_consent_required=$7,unconsented_minors_masked=$8,starts_at=$9,ends_at=$10,provider=$11,
              stream_secret_hash=coalesce($12, stream_secret_hash),approved_by=$13
            WHERE id=$1 RETURNING id,event_id,school_id,status,audience,access_mode,live_enabled,stream_season_id,
              media_consent_required,unconsented_minors_masked,starts_at,ends_at,recording_allowed,provider,(stream_secret_hash IS NOT NULL) AS has_stream_secret`,
            [cur.id, status, audience, accessMode, liveEnabled, b.streamSeasonId || null,
             mediaConsentRequired, unconsentedMasked, startsAt, endsAt, b.provider ?? cur.provider, secretHash ?? null, a.userId]);
        } else {
          r = await one(c, `INSERT INTO event_streams(district_id,school_id,event_id,status,audience,access_mode,live_enabled,stream_season_id,
              media_consent_required,unconsented_minors_masked,starts_at,ends_at,recording_allowed,provider,stream_secret_hash,approved_by,created_by)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,false,$13,$14,$15,$15)
            RETURNING id,event_id,school_id,status,audience,access_mode,live_enabled,stream_season_id,
              media_consent_required,unconsented_minors_masked,starts_at,ends_at,recording_allowed,provider,(stream_secret_hash IS NOT NULL) AS has_stream_secret`,
            [a.districtId, event.school_id, event.id, status, audience, accessMode, liveEnabled, b.streamSeasonId || null,
             mediaConsentRequired, unconsentedMasked, startsAt, endsAt, b.provider || null, secretHash || null, a.userId]);
        }
        await audit(c, req, "configure", "event_stream", r.id, `access=${r.access_mode};live=${r.live_enabled};masked=${r.unconsented_minors_masked}`);
        return safeStream(r);
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  // Server-side paywall, kill switch, and media consent gate issuing a short-lived playback token.
  app.post("/api/events/:id/stream/access", requireSession, requireCsrf, async (req, res, next) => {
    const a = req.actor;
    if (!validId(req.params.id)) return res.status(400).json({ error: "invalid_event_id" });
    if (!["superintendent", "it_admin", "principal", "vice_principal", "teacher", "parent", "pupil"].includes(a.role)) {
      return res.status(403).json({ error: "stream_access_forbidden" });
    }
    try {
      const data = await withTenantTransaction(a, async c => {
        const event = await one(c, `SELECT id,school_id,activity_id,status FROM school_events
            WHERE id=$1 AND district_id=$2 AND ($3::uuid IS NULL OR school_id=$3)`,
          [req.params.id, a.districtId, DISTRICT(a.role) ? null : a.schoolId]);
        if (!event || (event.status !== "published" && !LEAD(a.role))) throw new HttpError(404, "event_not_found");
        const stream = await one(c, `SELECT * FROM event_streams WHERE event_id=$1 AND district_id=$2 ORDER BY created_at DESC LIMIT 1`,
          [event.id, a.districtId]);
        if (!stream) throw new HttpError(404, "stream_not_found");
        if (stream.audience === "district" && !DISTRICT(a.role)) throw new HttpError(403, "district_stream_audience_required");
        const hasPass = await userHasStreamPass(c, a.districtId, a.userId, stream);
        const unconsentedCount = await countUnconsentedParticipants(c, a.districtId, event);
        const gate = evaluateStreamAccess({ stream, hasPass, isLead: LEAD(a.role), unconsentedCount });
        if (!gate.allowed) {
          await audit(c, req, "stream_access_denied", "event_stream", stream.id, `reason=${gate.reason}`, "failure");
          throw new HttpError(gate.status, gate.reason);
        }
        const issued = signStreamToken({
          streamId: stream.id, eventId: event.id, districtId: a.districtId, userId: a.userId,
          accessMode: stream.access_mode, masked: gate.unconsentedExcludedOrBlurred
        }, signingSecret());
        await audit(c, req, "stream_access", "event_stream", stream.id, `granted=1;masked=${gate.unconsentedExcludedOrBlurred ? 1 : 0}`);
        return {
          playbackEnabled: true,
          streamId: stream.id,
          eventId: event.id,
          accessMode: stream.access_mode,
          token: issued.token,
          expiresAt: issued.expiresAt,
          mediaPolicy: {
            consentRequired: Boolean(stream.media_consent_required),
            unconsentedExcludedOrBlurred: gate.unconsentedExcludedOrBlurred,
            unconsentedCount: gate.unconsentedCount
          }
        };
      });
      res.json({ data });
    } catch (e) { sendError(res, next, e); }
  });

  app.get("/api/events/:id/stream/verify", requireSession, wrap(async (c, req) => {
    const a = req.actor, token = req.query.token;
    if (!validId(req.params.id)) throw new HttpError(400, "invalid_event_id");
    const check = verifyStreamToken(token, signingSecret(), { eventId: req.params.id, districtId: a.districtId, userId: a.userId });
    if (!check.ok) throw new HttpError(403, check.reason);
    const stream = await one(c, "SELECT id,live_enabled,access_mode,unconsented_minors_masked FROM event_streams WHERE id=$1 AND event_id=$2 AND district_id=$3",
      [check.claims.streamId, req.params.id, a.districtId]);
    if (!stream || !stream.live_enabled) throw new HttpError(403, "stream_live_kill_switch_off");
    return { valid: true, streamId: stream.id, eventId: req.params.id, accessMode: stream.access_mode, masked: Boolean(check.claims.masked) };
  }));
}

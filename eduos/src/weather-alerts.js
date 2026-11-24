// SAFE-04: National Weather Service alerts for each school (db/124).
//
// Every WEATHER_ALERTS_INTERVAL_SECONDS (default 120) the API asks
// api.weather.gov for the active alerts at each school's location, in
// districts whose superintendent turned it on. Only the coordinates are sent.
// NWS asks every client to identify itself with a User-Agent that includes a
// contact; WEATHER_ALERTS_USER_AGENT must be set (e.g. "EduOS (it@district.org)")
// or the sweep doesn't run.
//
// A new warning that matches a hazard alerts the school's leaders and shows a
// "Start shelter" prompt. EduOS never starts an alert on its own.
import { pool } from "./db.js";
import { enqueueNotifications } from "./notify.js";
import { config } from "./config.js";
import { HAZARD_KIND, HAZARD_LABEL } from "./safety-model.js";
import { parseAlerts } from "./weather-nws.js";
export { parseAlerts };

export const NWS_BASE = "https://api.weather.gov";
// Tests (never production) may point the sweep at a loopback mock.
const TEST_BASE = (process.env.NODE_ENV || "development") !== "production" && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(process.env.WEATHER_API_TEST_BASE || "")
  ? process.env.WEATHER_API_TEST_BASE : "";

/** Active alerts at a point. Throws on a network or NWS error (the sweep tries again next time). */
export async function fetchAlerts(lat, lon, { base = TEST_BASE || NWS_BASE, userAgent = config.weatherAlertsUserAgent, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const point = `${Number(lat).toFixed(4)},${Number(lon).toFixed(4)}`;
  const r = await fetchImpl(`${base}/alerts/active?point=${encodeURIComponent(point)}`, {
    headers: { "user-agent": userAgent, accept: "application/geo+json" }, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!r.ok) throw new Error(`NWS answered ${r.status}`);
  return parseAlerts(await r.json());
}

/** One sweep: fetch each distinct location once, record per school, alert leaders of new warnings. */
export async function sweepWeather({ db = pool, fetchAlertsImpl = fetchAlerts, log = console } = {}) {
  const targets = (await db.query("SELECT * FROM eduos_weather_targets()")).rows;
  const byPoint = new Map();
  for (const t of targets) { const k = `${Number(t.lat).toFixed(4)},${Number(t.lon).toFixed(4)}`; (byPoint.get(k) || byPoint.set(k, []).get(k)).push(t); }
  let fresh = 0, failed = 0;
  for (const [, schools] of byPoint) {
    let alerts;
    try { alerts = await fetchAlertsImpl(schools[0].lat, schools[0].lon); }
    catch (e) { failed++; log.error?.("Weather alerts fetch failed", { message: e.message }); continue; }
    for (const t of schools) {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.district_id',$1,true)", [t.district_id]);
        const news = (await client.query("SELECT eduos_weather_record($1,$2,$3::jsonb) AS out", [t.district_id, t.school_id, JSON.stringify(alerts)])).rows[0].out || [];
        if (news.length) {
          const to = (await client.query("SELECT user_id FROM eduos_weather_recipients($1,$2)", [t.district_id, t.school_id])).rows.map(r => r.user_id);
          for (const w of news) {
            await enqueueNotifications(client, { districtId: t.district_id, schoolId: t.school_id, recipients: to, kind: "safety", refType: "weather_alert", refId: w.id,
              title: `${w.event} for ${t.school_name} (National Weather Service)`,
              body: `${w.headline || w.event}. Open Safety to start a ${HAZARD_KIND[w.hazard] === "hold" ? "hold" : "shelter"} for ${HAZARD_LABEL[w.hazard].toLowerCase()}, or dismiss it. EduOS doesn't start one on its own.` });
            fresh++;
          }
        }
        await client.query("COMMIT");
      } catch (e) { await client.query("ROLLBACK").catch(() => {}); failed++; log.error?.("Weather alerts record failed", { message: e.message }); }
      finally { client.release(); }
    }
  }
  return { locations: byPoint.size, schools: targets.length, newWarnings: fresh, failed };
}

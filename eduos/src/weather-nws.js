// SAFE-04: National Weather Service alert parsing (pure; shared by the sweep and tests).
// NWS event names -> EduOS hazards. Anything else is shown for information only.
const EVENT_HAZARD = {
  "Tornado Warning": "tornado", "Tornado Watch": "tornado",
  "Severe Thunderstorm Warning": "severe_thunderstorm", "Severe Thunderstorm Watch": "severe_thunderstorm",
  "Hurricane Warning": "hurricane", "Hurricane Watch": "hurricane", "Tropical Storm Warning": "hurricane", "Extreme Wind Warning": "hurricane",
  "Flash Flood Warning": "flood", "Flood Warning": "flood", "Flash Flood Watch": "flood",
  "Winter Storm Warning": "winter_storm", "Blizzard Warning": "winter_storm", "Ice Storm Warning": "winter_storm", "Winter Storm Watch": "winter_storm",
  "Excessive Heat Warning": "extreme_heat", "Extreme Heat Warning": "extreme_heat", "Excessive Heat Watch": "extreme_heat", "Extreme Heat Watch": "extreme_heat",
  "Hazardous Materials Warning": "hazmat", "Shelter In Place Warning": "hazmat"
};
const levelOf = event => /Warning$/.test(event) ? "warning" : /Watch$/.test(event) ? "watch" : /Advisory$/.test(event) ? "advisory" : "statement";
const text = (v, n) => typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null;
const time = v => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

// NWS message types (CAP): "Alert" is a new product; "Update" replaces an
// earlier message, under a NEW id, and lists the messages it replaces in
// properties.references; "Cancel" withdraws the messages it references.
// Updates are kept: they carry the current headline, area, severity and
// instructions, and eduos_weather_record (db/130) folds each one into the alert
// it replaces. Cancels are kept as markers so the alerts they name end.
// Test and Exercise messages are skipped.
const MESSAGE_TYPES = new Set(["Alert", "Update", "Cancel"]);
const refsOf = p => [...new Set((Array.isArray(p.references) ? p.references : [])
  .map(r => text(r?.identifier, 300) || text(r?.["@id"], 300)).filter(Boolean))].slice(0, 20);

/** NWS GeoJSON -> the alerts EduOS records: {id, messageType, references, event, level, hazard, ...}. */
export function parseAlerts(geojson) {
  const out = [];
  for (const f of Array.isArray(geojson?.features) ? geojson.features : []) {
    const p = f?.properties || {};
    const event = text(p.event, 100), id = text(p.id || f.id, 300);
    if (!event || !id || p.status !== "Actual") continue;
    const messageType = MESSAGE_TYPES.has(p.messageType) ? p.messageType : "Alert";
    const references = refsOf(p).filter(r => r !== id);
    if (messageType === "Cancel") { out.push({ id, messageType, references, event }); continue; }
    out.push({ id, messageType, references, event, level: levelOf(event), hazard: EVENT_HAZARD[event] || null, severity: text(p.severity, 20), headline: text(p.headline, 300),
      area: text(p.areaDesc, 500), instruction: text(p.instruction, 1000), onset: time(p.onset || p.effective), expires: time(p.ends || p.expires) });
  }
  return out;
}

// ROOM-02: a remote lesson's video-call link must be one of these services
// (db/112 holds the same list).
const PROVIDERS = [["meet.google.com", "Google Meet"], ["zoom.us", "Zoom"], ["teams.microsoft.com", "Microsoft Teams"], ["teams.live.com", "Microsoft Teams"], ["webex.com", "Webex"]];

/** The service's name for an allowed https meeting link, or null. */
export function meetingProvider(url) {
  if (typeof url !== "string" || url.length > 500 || /\s/.test(url)) return null;
  let u; try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const hit = PROVIDERS.find(([d]) => host === d || host.endsWith(`.${d}`));
  return hit ? hit[1] : null;
}

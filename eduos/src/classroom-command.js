// DEV-03: the arguments each classroom command takes. Anything else is refused.
// No command shows, captures or streams a student's screen.
const httpsUrl = u => { try { const x = new URL(u); return x.protocol === "https:" && !x.username && !x.password && u.length <= 500; } catch { return false; } };
const bool = v => typeof v === "boolean";
const level = v => Number.isInteger(v) && v >= 0 && v <= 100;

/** Normalized arguments for a capability, or null if they don't fit. */
export function parseCommand(capability, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  switch (capability) {
    case "show": return {};                                   // the display shows the paired teacher's screen
    case "blank": return bool(args.on) ? { on: args.on } : null;
    case "power": return bool(args.on) ? { on: args.on } : null;
    case "input": return typeof args.source === "string" && /^[A-Za-z0-9 _-]{1,40}$/.test(args.source.trim()) ? { source: args.source.trim() } : null;
    case "volume": return level(args.level) ? { level: args.level } : null;
    case "lights": return bool(args.on) && (args.level == null || level(args.level)) ? { on: args.on, ...(args.level != null ? { level: args.level } : {}) } : null;
    case "lock": return args.message == null || (typeof args.message === "string" && args.message.trim().length <= 120)
      ? (args.message?.trim() ? { message: args.message.trim() } : {}) : null;
    case "unlock": return {};
    case "open_link": return httpsUrl(args.url) ? { url: args.url } : null;
    case "focus": return args.off === true ? { off: true } : httpsUrl(args.url) ? { url: args.url } : null;
    default: return null;
  }
}

// Edge Phase 2: the device health report the server keeps (db/038).
// Pure, with no imports, so the edge agent's tests can check their reports
// against it without a server or database.
const num = (v, min, max) => (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 10) / 10 : null);
const txt = (v, max, re = null) => (typeof v === "string" && v.length > 0 && v.length <= max && (!re || re.test(v)) ? v : null);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)$/;
const VERSION = /^[A-Za-z0-9._:+-]+$/;

/** Keeps only the fields the device health view uses; drops everything else. */
export function sanitizeReport(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const m = r.metrics && typeof r.metrics === "object" ? r.metrics : {};
  const c = r.compliance && typeof r.compliance === "object" ? r.compliance : {};
  const o = r.os && typeof r.os === "object" ? r.os : {};
  const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));
  return clean({
    timestamp: txt(r.timestamp, 40, ISO),
    hostname: txt(r.hostname, 64, /^[A-Za-z0-9.-]+$/),
    role: txt(r.role, 32, /^[a-z-]+$/),
    agentVersion: txt(r.agent_version ?? r.agentVersion, 40, VERSION),
    buffered: num(r.buffered, 0, 100000),
    metrics: clean({
      cpu_percent: num(m.cpu_percent, 0, 100),
      mem_total_kb: num(m.mem_total_kb, 0, 2 ** 40),
      mem_available_kb: num(m.mem_available_kb, 0, 2 ** 40),
      root_disk_used_percent: num(m.root_disk_used_percent, 0, 100),
      temperature_c: num(m.temperature_c, -50, 150),
      uptime_seconds: num(m.uptime_seconds, 0, 10 * 365 * 86400),
    }),
    compliance: clean({
      selinux: txt(c.selinux, 16, /^(Enforcing|Permissive|Disabled|unknown)$/),
      secure_boot: txt(c.secure_boot, 16, /^(enabled|disabled|unknown)$/),
      boot_time: txt(c.boot_time, 40, /^[0-9 :T.+-]+Z?$/),
      eduos_version: txt(c.eduos_version, 40, VERSION),
    }),
    os: clean({
      booted_version: txt(o.booted_version, 80, VERSION),
      booted_checksum: txt(o.booted_checksum, 64, /^[a-f0-9]{64}$/),
      staged_version: txt(o.staged_version, 80, VERSION),
      updates: txt(o.updates, 16, /^(enabled|held|disabled)$/),
      hold_reason: txt(o.hold_reason, 200),
      cohort: txt(o.cohort, 16, /^(canary|standard)$/),
      last_verify: txt(o.last_verify, 32, /^(healthy|rolled_back|unhealthy|pending|first_boot)$/),
      zincati: txt(o.zincati, 16, /^(active|inactive|failed|unknown)$/),
    }),
  });
}

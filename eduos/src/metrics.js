// Prometheus-style operational metrics (32.1.0). No personal data: labels are
// the HTTP method, the matched route template (never the raw URL) and the
// status class. GET /metrics is served only when METRICS_TOKEN is set, and only
// with "Authorization: Bearer <METRICS_TOKEN>". The Caddy edge does not proxy
// /metrics; scrape the app on the internal network.
import crypto from "node:crypto";

const started = Date.now();
const requests = new Map(); // `${method} ${route} ${class}` -> { count, seconds }
let inFlight = 0;

export function metricsMiddleware(req, res, next) {
  const t0 = process.hrtime.bigint();
  inFlight++;
  res.once("close", () => {
    inFlight--;
    const route = req.route?.path ? `${req.baseUrl || ""}${req.route.path}` : (res.statusCode === 404 ? "unmatched" : "static");
    const key = `${req.method}\u0000${route}\u0000${String(res.statusCode)[0]}xx`;
    const entry = requests.get(key) || { count: 0, seconds: 0 };
    entry.count++; entry.seconds += Number(process.hrtime.bigint() - t0) / 1e9;
    if (requests.size < 2000 || requests.has(key)) requests.set(key, entry);
  });
  next();
}

const label = v => String(v).replace(/["\\\n]/g, "_");
export function renderMetrics({ version, poolStats = null } = {}) {
  const lines = [
    "# HELP eduos_build_info EduOS build information.", "# TYPE eduos_build_info gauge",
    `eduos_build_info{version="${label(version)}"} 1`,
    "# HELP eduos_uptime_seconds Seconds since the API process started.", "# TYPE eduos_uptime_seconds gauge",
    `eduos_uptime_seconds ${((Date.now() - started) / 1000).toFixed(0)}`,
    "# HELP eduos_http_requests_in_flight Requests currently being served.", "# TYPE eduos_http_requests_in_flight gauge",
    `eduos_http_requests_in_flight ${inFlight}`,
    "# HELP eduos_http_requests_total HTTP requests by method, route template and status class.", "# TYPE eduos_http_requests_total counter"
  ];
  const durations = ["# HELP eduos_http_request_duration_seconds_sum Total time spent serving requests.", "# TYPE eduos_http_request_duration_seconds_sum counter"];
  for (const [key, { count, seconds }] of requests) {
    const [method, route, status] = key.split("\u0000");
    const l = `method="${label(method)}",route="${label(route)}",status="${status}"`;
    lines.push(`eduos_http_requests_total{${l}} ${count}`);
    durations.push(`eduos_http_request_duration_seconds_sum{${l}} ${seconds.toFixed(6)}`);
  }
  const mem = process.memoryUsage();
  lines.push(...durations,
    "# HELP eduos_process_resident_memory_bytes Resident memory.", "# TYPE eduos_process_resident_memory_bytes gauge",
    `eduos_process_resident_memory_bytes ${mem.rss}`);
  if (poolStats) {
    lines.push("# HELP eduos_db_pool_connections PostgreSQL pool connections by state.", "# TYPE eduos_db_pool_connections gauge",
      `eduos_db_pool_connections{state="total"} ${poolStats.total}`, `eduos_db_pool_connections{state="idle"} ${poolStats.idle}`,
      `eduos_db_pool_connections{state="waiting"} ${poolStats.waiting}`);
  }
  return lines.join("\n") + "\n";
}

export function metricsHandler({ token, version, poolStats }) {
  const expected = token ? crypto.createHash("sha256").update(token).digest() : null;
  return (req, res) => {
    if (!expected) return res.status(404).json({ error: "not_found" });
    const supplied = /^Bearer (\S{1,256})$/.exec(req.get("authorization") || "")?.[1] || "";
    const digest = crypto.createHash("sha256").update(supplied).digest();
    if (!supplied || !crypto.timingSafeEqual(digest, expected)) return res.status(401).json({ error: "metrics_token_required" });
    res.setHeader("Cache-Control", "no-store");
    res.type("text/plain; version=0.0.4").send(renderMetrics({ version, poolStats: poolStats?.() }));
  };
}

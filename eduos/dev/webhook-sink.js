// Local webhook receiver for evaluation and the smoke test (32.1.0).
// In docker-compose.dev.yml it shares the API container's network namespace and
// listens on 127.0.0.1, the only plain-HTTP destination EduOS accepts outside
// production (WEBHOOK_ALLOW_INSECURE_LOOPBACK=true). It records every delivery
// (headers + raw body) so a caller holding the subscription secret can verify
// the X-EduOS-Signature itself. GET /deliveries lists what was received.
import http from "node:http";

if ((process.env.NODE_ENV || "development") === "production") {
  console.error("webhook-sink: refusing to start with NODE_ENV=production"); process.exit(1);
}
const PORT = Number(process.env.PORT || 9999);
const received = [];
http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/deliveries") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ data: received }));
  }
  if (req.method === "POST" && req.url.startsWith("/hooks/")) {
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 1_000_000) break; }
    const pick = k => req.headers[k.toLowerCase()] || null;
    received.push({ path: req.url, receivedAt: new Date().toISOString(), body,
      event: pick("X-EduOS-Event"), delivery: pick("X-EduOS-Delivery"), signature: pick("X-EduOS-Signature") });
    if (received.length > 500) received.shift();
    console.log(`webhook-sink: ${pick("X-EduOS-Event")} ${pick("X-EduOS-Delivery")}`);
    res.writeHead(204); return res.end();
  }
  res.writeHead(404); res.end();
}).listen(PORT, process.env.SINK_BIND || "127.0.0.1", () => console.log(`webhook-sink listening on 127.0.0.1:${PORT} (development only)`));

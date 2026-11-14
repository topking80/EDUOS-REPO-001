// Local LTI 1.3 TOOL for trying the "Science Lab (LTI demo)" app (32.2.0).
// DEVELOPMENT ONLY: it plays the vendor side of an LTI launch so you can see
// exactly which claims EduOS sends. It stores nothing.
//   node dev/lti-tool.js            (listens on http://localhost:5199)
// Flow: EduOS /api/apps/:id/launch -> GET /login (third-party initiated login)
//   -> EduOS /lti/authorize -> POST /launch with a signed id_token.
// The id_token signature is verified against EduOS's /.well-known/jwks.json.
// For the local Caddy certificate the JWKS fetch skips TLS verification, but
// only when the issuer host is localhost/127.0.0.1.
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";

const PORT = Number(process.env.LTI_TOOL_PORT || 5199);
const ORIGIN = `http://localhost:${PORT}`;
const CLIENT_ID = process.env.LTI_TOOL_CLIENT_ID || "eduos-demo-tool";
const pending = new Map(); // state -> { nonce, iss, at }
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function getJson(url) {
  const u = new URL(url);
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    mod.get(u, { rejectUnauthorized: !local, timeout: 5000 }, res => {
      let body = ""; res.setEncoding("utf8");
      res.on("data", c => { body += c; if (body.length > 65536) res.destroy(); });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

async function verify(idToken, iss) {
  const [h, p, s] = idToken.split(".");
  const header = JSON.parse(Buffer.from(h, "base64url"));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  const jwks = await getJson(`${iss}/.well-known/jwks.json`);
  const jwk = (jwks.keys || []).find(k => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") throw new Error("no matching RS256 key in JWKS");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new Error("bad signature");
  return claims;
}

function page(res, status, title, body) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#15263a}
.warn{background:#7a3e00;color:#fff;padding:6px 10px;border-radius:6px}pre{background:#f1f5f9;padding:12px;border-radius:8px;overflow:auto}</style></head>
<body><p class="warn">Local LTI demo tool (development only)</p><main><h1>${esc(title)}</h1>${body}</main></body></html>`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 65536) req.destroy(); });
  req.on("end", async () => {
    const params = req.method === "POST" ? new URLSearchParams(raw) : url.searchParams;
    if (url.pathname === "/login") {
      const iss = params.get("iss");
      if (!iss || !/^https?:\/\//.test(iss) || params.get("client_id") !== CLIENT_ID) return page(res, 400, "Launch refused", "<p>Unknown platform or client.</p>");
      const state = crypto.randomBytes(16).toString("hex"), nonce = crypto.randomBytes(16).toString("hex");
      pending.set(state, { nonce, iss, at: Date.now() });
      const a = new URL(`${iss}/lti/authorize`);
      for (const [k, v] of Object.entries({ scope: "openid", response_type: "id_token", response_mode: "form_post", prompt: "none",
        client_id: CLIENT_ID, redirect_uri: `${ORIGIN}/launch`, login_hint: params.get("login_hint") || "",
        lti_message_hint: params.get("lti_message_hint") || "", state, nonce })) a.searchParams.set(k, v);
      res.writeHead(302, { Location: a.toString(), "Cache-Control": "no-store" }); return res.end();
    }
    if (url.pathname === "/launch" && req.method === "POST") {
      const st = pending.get(params.get("state") || "");
      pending.delete(params.get("state") || "");
      if (!st || Date.now() - st.at > 300000) return page(res, 400, "Launch refused", "<p>Unknown or expired state.</p>");
      try {
        const c = await verify(params.get("id_token") || "", st.iss);
        if (c.nonce !== st.nonce || c.aud !== CLIENT_ID || c.iss !== st.iss) throw new Error("nonce/aud/iss mismatch");
        const name = c.given_name || c.name || "there";
        return page(res, 200, `Welcome to Science Lab, ${name}!`,
          `<p data-lti-verified="true">Signature verified with the district's public key. These are all the claims EduOS sent:</p><pre>${esc(JSON.stringify(c, null, 2))}</pre>`);
      } catch (e) { return page(res, 400, "Launch refused", `<p>${esc(e.message)}</p>`); }
    }
    page(res, 404, "Not found", "");
  });
});
server.listen(PORT, "127.0.0.1", () => console.log(`LTI demo tool on ${ORIGIN} (client_id ${CLIENT_ID})`));

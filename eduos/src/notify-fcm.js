// Firebase Cloud Messaging HTTP v1 adapter. Uses a service-account JWT
// exchange and never logs tokens, credentials, or notification content.
import { SignJWT, importPKCS8 } from "jose";
import { config } from "./config.js";
import { decryptPushToken, hashPushToken } from "./notify-push-token.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

export function createFcmClient(cfg = config, request = fetch) {
  let accessToken = null, expiresAt = 0, tokenPromise = null;
  async function oauthToken() {
    if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      const key = await importPKCS8(cfg.fcmPrivateKey.replace(/\\n/g, "\n"), "RS256");
      const now = Math.floor(Date.now() / 1000);
      const assertion = await new SignJWT({ scope: FCM_SCOPE })
        .setProtectedHeader({ alg: "RS256", typ: "JWT" })
        .setIssuer(cfg.fcmClientEmail)
        .setSubject(cfg.fcmClientEmail)
        .setAudience(TOKEN_URL)
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(key);
      const response = await request(TOKEN_URL, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
        signal: AbortSignal.timeout(cfg.fcmTimeoutMs)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.access_token !== "string") {
        const error = new Error("FCM OAuth token request failed");
        error.status = response.status;
        throw error;
      }
      accessToken = body.access_token;
      expiresAt = Date.now() + Math.max(60, Number(body.expires_in) || 3600) * 1000;
      return accessToken;
    })();
    try { return await tokenPromise; } finally { tokenPromise = null; }
  }

  return Object.freeze({
    async send(token, notificationId) {
      const bearer = await oauthToken();
      const response = await request("https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(cfg.fcmProjectId) + "/messages:send", {
        method: "POST",
        headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: "EduOS", body: "You have a new notification. Open the EduOS app to read it." },
            data: { notificationId },
            android: { priority: "high" },
            apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } }
          }
        }),
        signal: AbortSignal.timeout(cfg.fcmTimeoutMs)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error("FCM message request failed");
        error.status = response.status;
        error.providerCode = body.error?.details?.find?.(x => x.errorCode)?.errorCode || body.error?.status || null;
        throw error;
      }
      return body;
    }
  });
}

export function createFcmPushAdapter(client = createFcmClient(), cfg = config) {
  return Object.freeze({
    name: "fcm",
    async send(row) {
      const devices = Array.isArray(row.recipient_push_tokens) ? row.recipient_push_tokens : [];
      if (!devices.length) return { status: "skipped", note: "recipient has no active push devices" };
      let accepted = 0, transient = 0, permanent = 0;
      const invalidTokenHashes = [];
      for (const encrypted of devices.slice(0, 20)) {
        let token;
        try { token = decryptPushToken(encrypted, cfg); }
        catch { permanent++; continue; }
        try {
          await client.send(token, row.id);
          accepted++;
        } catch (error) {
          if (error.providerCode === "UNREGISTERED") invalidTokenHashes.push(hashPushToken(token));
          else if (Number(error.status) === 429 || Number(error.status) >= 500 || !error.status) transient++;
          else permanent++;
        }
      }
      if (accepted) return { status: "accepted", note: "accepted by FCM; device display is not confirmed", invalidTokenHashes };
      if (transient) return { status: "pending", note: "FCM temporarily unavailable", invalidTokenHashes };
      if (invalidTokenHashes.length || permanent) return { status: "failed", note: "FCM rejected all active device tokens", invalidTokenHashes };
      return { status: "skipped", note: "no usable push devices" };
    }
  });
}

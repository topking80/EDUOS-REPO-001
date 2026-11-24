// MEDIA-01: private media in S3-compatible object storage (AWS S3, Cloudflare
// R2, Backblaze B2, Wasabi, MinIO). AWS Signature Version 4, no SDK.
//
// Browsers upload straight to the bucket with a presigned PUT (5 minutes; the
// content type and exact length are signed, so nothing else fits) and read
// with a presigned GET (60 seconds). The bucket stays private: no public
// reads, no listing. Storage keys never leave the server.
import crypto from "node:crypto";

const sha256 = v => crypto.createHash("sha256").update(v).digest("hex");
const hmac = (key, v) => crypto.createHmac("sha256", key).update(v).digest();
// RFC 3986 encoding as SigV4 wants it; "/" kept in paths.
const enc = (s, keepSlash = false) => encodeURIComponent(s).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(keepSlash ? /%2F/g : /$^/, "/");
const amzDate = d => d.toISOString().replace(/[:-]|\.\d{3}/g, "");
export const EMPTY_SHA256 = sha256("");

/**
 * Sign a request (SigV4). Returns { url, headers } for header auth, or a
 * presigned url when `presign` is set (seconds).
 */
export function signS3({ method, host, path, query = {}, headers = {}, region, accessKeyId, secretAccessKey, date = new Date(), presign = 0, payloadHash = "UNSIGNED-PAYLOAD", service = "s3" }) {
  const stamp = amzDate(date), day = stamp.slice(0, 8), scope = `${day}/${region}/${service}/aws4_request`;
  const h = { host, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) };
  if (!presign) { h["x-amz-date"] = stamp; h["x-amz-content-sha256"] = payloadHash; }
  const signedHeaders = Object.keys(h).sort().join(";");
  const q = { ...query };
  if (presign) Object.assign(q, { "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${accessKeyId}/${scope}`, "X-Amz-Date": stamp,
    "X-Amz-Expires": String(presign), "X-Amz-SignedHeaders": signedHeaders });
  const canonicalQuery = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonicalHeaders = Object.keys(h).sort().map(k => `${k}:${h[k]}\n`).join("");
  const canonical = [method, enc(path, true), canonicalQuery, canonicalHeaders, signedHeaders, presign ? "UNSIGNED-PAYLOAD" : payloadHash].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  if (presign) return { query: `${canonicalQuery}&X-Amz-Signature=${signature}`, signature };
  const { host: _host, ...sent } = h;
  return { headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` }, signature };
}

/** S3 client for the storage interface used by history media. */
export function createS3Storage({ endpoint, region, bucket, accessKeyId, secretAccessKey, pathStyle = false, fetchImpl = fetch, allowHttpLoopback = false } = {}) {
  if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) return null;
  const base = new URL(endpoint);
  const loopback = base.protocol === "http:" && base.hostname === "127.0.0.1" && allowHttpLoopback;
  if (base.protocol !== "https:" && !loopback) throw new Error("MEDIA_S3_ENDPOINT must be https");
  const host = pathStyle ? base.host : `${bucket}.${base.host}`;
  const origin = `${base.protocol}//${host}`;
  const pathOf = key => pathStyle ? `/${bucket}/${key}` : `/${key}`;
  const creds = { region, accessKeyId, secretAccessKey };
  const send = async (method, key, { headers = {}, body, payloadHash } = {}) => {
    const path = pathOf(key);
    const signed = signS3({ method, host, path, headers, ...creds, payloadHash: payloadHash || (body ? sha256(body) : EMPTY_SHA256) });
    return fetchImpl(`${origin}${enc(path, true)}`, { method, headers: { ...headers, ...signed.headers }, body, redirect: "error", signal: AbortSignal.timeout(30_000) });
  };
  const presigned = (method, key, seconds, headers = {}) => {
    const path = pathOf(key);
    const { query } = signS3({ method, host, path, headers, ...creds, presign: seconds });
    return `${origin}${enc(path, true)}?${query}`;
  };
  return Object.freeze({
    origin,
    /** A presigned PUT; the browser must send exactly this type and length. */
    uploadUrl(key, mimeType, byteSize, seconds = 300) {
      return { url: presigned("PUT", key, seconds, { "content-type": mimeType, "content-length": String(byteSize) }),
        headers: { "content-type": mimeType }, expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
    },
    readUrl(key, seconds = 60) {
      return { url: presigned("GET", key, seconds), expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
    },
    async head(key) {
      const r = await send("HEAD", key);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`storage HEAD ${r.status}`);
      return { byteSize: Number(r.headers.get("content-length")), mimeType: (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() };
    },
    async get(key, maxBytes) {
      const r = await send("GET", key);
      if (!r.ok) throw new Error(`storage GET ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > maxBytes) throw new Error("storage object too large");
      return buf;
    },
    async put(key, body, mimeType) {
      const r = await send("PUT", key, { body, headers: { "content-type": mimeType, "content-length": String(body.length) } });
      if (!r.ok) throw new Error(`storage PUT ${r.status}`);
    },
    /**
     * TC-08: move an object to another storage class in place (same key, same
     * permissions; S3 copies it onto itself). Only instant-read classes are
     * used, so presigned reads keep working.
     */
    async setStorageClass(key, storageClass) {
      const source = `/${[bucket, ...key.split("/")].map(p => enc(p)).join("/")}`;
      const r = await send("PUT", key, { headers: { "x-amz-copy-source": source, "x-amz-metadata-directive": "COPY", "x-amz-storage-class": storageClass } });
      if (!r.ok) throw new Error(`storage COPY ${r.status}`);
      const text = await r.text();
      if (/<Error>/.test(text)) throw new Error("storage COPY error");
    },
    async remove(key) {
      const r = await send("DELETE", key);
      if (!r.ok && r.status !== 404) throw new Error(`storage DELETE ${r.status}`);
    }
  });
}

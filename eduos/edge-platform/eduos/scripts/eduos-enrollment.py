#!/usr/bin/env python3
"""EduOS enrollment intake. Stages requests; it never activates devices/accounts."""
import hashlib, hmac, json, os, re, secrets, socket, time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOST = os.environ.get("EDUOS_ENROLL_HOST", "127.0.0.1")
PORT = int(os.environ.get("EDUOS_ENROLL_PORT", "8080"))
# Canonical path: eduos-bootstrap.sh generates a fresh per-boot token here
# (root:eduos-enrollment 0640); the unit and the Quadlet both use it.
TOKEN_FILE = Path(os.environ.get("EDUOS_ENROLL_TOKEN_FILE", "/run/eduos/enrollment-token"))
# Shipped example/placeholder values must never authenticate anyone.
PLACEHOLDER_MARKERS = ("PLACEHOLDER", "CHANGE", "REPLACE", "EXAMPLE")
QUEUE = Path(os.environ.get("EDUOS_ENROLL_DIR", "/var/lib/eduos/enrollments/pending"))
ROLE_FILE = Path(os.environ.get("EDUOS_ROLE_FILE", "/etc/eduos/role"))
MAX_BODY = 4096
RATE_WINDOW, RATE_MAX = 60, 10
# Hardening bounds: cap the pending queue (disk-fill DoS), the rate-limit table
# (memory growth), and per-connection time (slow-read / slowloris thread hold).
MAX_PENDING = int(os.environ.get("EDUOS_ENROLL_MAX_PENDING", "1000"))
MAX_TRACKED_IPS = int(os.environ.get("EDUOS_ENROLL_MAX_TRACKED_IPS", "1024"))
REQUEST_TIMEOUT = int(os.environ.get("EDUOS_ENROLL_TIMEOUT", "10"))
attempts = {}

def loopback_only(host):
    return host in {"127.0.0.1", "::1"}

def load_token():
    try:
        token = TOKEN_FILE.read_text().strip()
    except OSError:
        return ""
    if any(marker in token.upper() for marker in PLACEHOLDER_MARKERS):
        return ""
    return token if len(token) >= 32 and re.fullmatch(r"[A-Za-z0-9_-]+", token) else ""

class Handler(BaseHTTPRequestHandler):
    server_version = "EduOSEnrollment"
    sys_version = ""
    timeout = REQUEST_TIMEOUT  # kill slow-read / slowloris connections holding a thread
    def reply(self, code, payload):
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"status":"ok"})
        else:
            self.reply(404, {"error":"not_found"})
    def do_POST(self):
        if self.path != "/api/v1/enrollments":
            return self.reply(404, {"error":"not_found"})
        now = time.time()
        # Prune stale rate-limit state so the table cannot grow without bound.
        for k in [k for k, v in attempts.items() if not v or now - v[-1] >= RATE_WINDOW]:
            attempts.pop(k, None)
        ip = self.client_address[0]
        if ip not in attempts and len(attempts) >= MAX_TRACKED_IPS:
            return self.reply(429, {"error":"rate_limited"})
        recent = [t for t in attempts.get(ip, []) if now-t < RATE_WINDOW]
        if len(recent) >= RATE_MAX:
            attempts[ip] = recent
            return self.reply(429, {"error":"rate_limited"})
        recent.append(now); attempts[ip] = recent
        expected = load_token()
        supplied = self.headers.get("Authorization", "")
        if not expected or not supplied.startswith("Bearer ") or not hmac.compare_digest(supplied[7:], expected):
            return self.reply(401, {"error":"unauthorized"})
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return self.reply(415, {"error":"application_json_required"})
        # Require an explicit, bounded Content-Length; reject chunked/streamed
        # framing so the body size is known before a single byte is read.
        if self.headers.get("Transfer-Encoding"):
            return self.reply(411, {"error":"length_required"})
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return self.reply(400, {"error":"invalid_content_length"})
        if length < 2 or length > MAX_BODY:
            return self.reply(413, {"error":"invalid_body_size"})
        try:
            raw = self.rfile.read(length)
        except (socket.timeout, TimeoutError):
            return self.reply(408, {"error":"request_timeout"})
        if len(raw) != length:
            return self.reply(400, {"error":"incomplete_body"})
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            return self.reply(400, {"error":"invalid_json"})
        if not isinstance(data, dict) or set(data) - {"device_id", "requested_role"}:
            return self.reply(400, {"error":"invalid_fields"})
        device_id = data.get("device_id")
        requested_role = data.get("requested_role", "edge")
        if not isinstance(device_id, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{2,63}", device_id):
            return self.reply(400, {"error":"invalid_device_id"})
        if requested_role not in {"student","teacher","admin","edge","district","state"}:
            return self.reply(400, {"error":"invalid_role"})
        QUEUE.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Bound the pending queue so an authenticated client cannot fill the disk.
        try:
            pending = sum(1 for _ in QUEUE.glob("*.json"))
        except OSError:
            return self.reply(503, {"error":"queue_unavailable"})
        if pending >= MAX_PENDING:
            return self.reply(503, {"error":"queue_full"})
        request_id = secrets.token_urlsafe(24)
        record = {"request_id":request_id, "device_id":device_id,
                  "requested_role":requested_role,
                  "reported_host_role":ROLE_FILE.read_text().strip()[:32] if ROLE_FILE.exists() else "unknown",
                  "created_at":datetime.now(timezone.utc).isoformat(),
                  "status":"pending_review"}
        target = QUEUE / (hashlib.sha256(request_id.encode()).hexdigest()+".json")
        fd = os.open(target, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(record, f)
            f.flush(); os.fsync(f.fileno())
        self.reply(202, {"status":"pending_review", "request_id":request_id})
    def log_message(self, fmt, *args):
        # Never log request bodies, authorization headers or identifiers.
        super().log_message("request")
    def do_PUT(self): self.reply(405, {"error":"method_not_allowed"})
    def do_DELETE(self): self.reply(405, {"error":"method_not_allowed"})

if __name__ == "__main__":
    if not load_token():
        raise SystemExit("Enrollment token missing/invalid; refusing to start")
    if not loopback_only(HOST):
        raise SystemExit("Refusing non-loopback bind; terminate TLS at a trusted local proxy")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

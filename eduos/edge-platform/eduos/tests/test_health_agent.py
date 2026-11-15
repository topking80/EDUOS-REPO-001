"""Edge Phase 2: scripts/eduos-health.sh against a local HTTP server.

One agent cycle (EDUOS_HEALTH_ONCE=1) collects a report into the outbox and
sends the outbox oldest-first with the device token; failures keep reports for
later, refusals drop them, and the outbox is capped.
"""
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "eduos-health.sh"
SERVER_SRC = ROOT.parent.parent / "src" / "edge-report.js"
TOKEN = "edh1.11111111-2222-4333-8444-555555555555." + "A" * 43
OS_STATUS = '{"booted_version":"45.20261110.3.0","booted_checksum":"' + "a" * 64 + '","staged_version":"","updates":"enabled","hold_reason":"","cohort":"standard","last_verify":"healthy","zincati":"active"}'


class Server:
    def __init__(self):
        self.status = 202
        self.requests = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("content-length", 0)))
                outer.requests.append((self.path, dict(self.headers), json.loads(body)))
                self.send_response(outer.status)
                self.end_headers()

            def log_message(self, *a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/api/edge/health"

    def close(self):
        self.httpd.shutdown()


class HealthAgent(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="eduos-health-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.etc, self.dir, self.bin = self.tmp / "etc", self.tmp / "health", self.tmp / "bin"
        for d in (self.etc / "eduos", self.dir, self.bin):
            d.mkdir(parents=True)
        (self.etc / "eduos" / "role").write_text("edge\n")
        (self.etc / "eduos" / "health.toml").write_text((ROOT / "configs" / "health.toml").read_text())
        (self.bin / "logger").write_text("#!/bin/bash\nexit 0\n")
        (self.bin / "logger").chmod(0o755)
        self.status_file = self.tmp / "status.json"
        self.status_file.write_text(OS_STATUS + "\n")
        self.server = Server()
        self.addCleanup(self.server.close)

    def token(self, value=TOKEN):
        (self.etc / "eduos" / "health-token").write_text(value + "\n")

    def run_once(self, endpoint=None, allow_http=True, **extra):
        env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "EDUOS_ETC": str(self.etc), "EDUOS_HEALTH_DIR": str(self.dir),
            "EDUOS_OS_STATUS": str(self.status_file), "EDUOS_HEALTH_ONCE": "1",
            "EDUOS_HEALTH_ENDPOINT": self.server.url if endpoint is None else endpoint,
            "EDUOS_HEALTH_ALLOW_HTTP": "1" if allow_http else "0",
            # Don't read the test machine's own firmware (CI runners have UEFI).
            "EDUOS_SECUREBOOT_VAR": str(self.tmp / "no-SecureBoot-var"), **extra,
        }
        r = subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r

    def outbox(self):
        return sorted(p.name for p in (self.dir / "outbox").glob("*.json"))

    def test_without_a_token_reports_stay_on_the_device(self):
        r = self.run_once()
        self.assertEqual(self.server.requests, [])
        self.assertEqual(len(self.outbox()), 1)
        self.assertIn("no device token", r.stderr)
        json.loads((self.dir / "report.json").read_text())

    def test_sends_the_report_with_the_device_token_and_empties_the_outbox(self):
        self.token()
        self.run_once()
        self.assertEqual(len(self.server.requests), 1)
        path, headers, body = self.server.requests[0]
        self.assertEqual(path, "/api/edge/health")
        self.assertEqual(headers["Authorization"], f"Bearer {TOKEN}")
        self.assertEqual(body["role"], "edge")
        self.assertEqual(body["os"]["booted_version"], "45.20261110.3.0", "includes eduos-update's OS status")
        self.assertIsInstance(body["metrics"]["cpu_percent"], (int, float))
        self.assertEqual(set(body), {"timestamp", "hostname", "role", "agent_version", "buffered", "metrics", "compliance", "os"})
        self.assertEqual(self.outbox(), [])
        self.assertEqual(body["compliance"]["secure_boot"], "unknown")

    def test_secure_boot_comes_from_the_uefi_variable(self):
        self.token()
        var = self.tmp / "SecureBoot"
        for raw, want in ((b"\x06\x00\x00\x00\x01", "enabled"), (b"\x06\x00\x00\x00\x00", "disabled")):
            var.write_bytes(raw)
            self.server.requests.clear()
            self.run_once(EDUOS_SECUREBOOT_VAR=str(var))
            self.assertEqual(self.server.requests[0][2]["compliance"]["secure_boot"], want)

    def test_server_down_keeps_reports_and_sends_them_oldest_first_later(self):
        self.token()
        self.server.status = 503
        self.run_once()
        self.run_once()
        self.assertEqual(len(self.outbox()), 2)
        first = json.loads((self.dir / "outbox" / self.outbox()[0]).read_text())["timestamp"]
        self.server.status = 202
        self.server.requests.clear()
        self.run_once()
        self.assertEqual(len(self.server.requests), 3)
        self.assertEqual(self.server.requests[0][2]["timestamp"], first)
        self.assertEqual(self.outbox(), [])

    def test_a_refused_token_keeps_reports_and_a_refused_report_is_dropped(self):
        self.token()
        self.server.status = 401
        self.run_once()
        self.assertEqual(len(self.outbox()), 1)
        self.server.status = 400
        self.run_once()
        self.assertEqual(self.outbox(), [])

    def test_an_invalid_token_or_a_non_https_endpoint_is_never_used(self):
        self.token("not-a-token")
        self.run_once()
        self.assertEqual(self.server.requests, [])
        self.token()
        r = self.run_once(allow_http=False)
        self.assertEqual(self.server.requests, [])
        self.assertIn("non-https", r.stderr)

    def test_the_outbox_is_capped_and_no_endpoint_keeps_only_the_newest(self):
        cfg = self.etc / "eduos" / "health.toml"
        cfg.write_text(cfg.read_text().replace("max_cache_entries = 1000", "max_cache_entries = 3"))
        self.token()
        self.server.status = 503
        for _ in range(5):
            self.run_once()
        self.assertEqual(len(self.outbox()), 3)
        shutil.rmtree(self.dir / "outbox")
        for _ in range(3):
            self.run_once(endpoint="")
        self.assertEqual(len(self.outbox()), 1)

    @unittest.skipUnless(shutil.which("node") and SERVER_SRC.exists(), "needs node and the server source")
    def test_the_server_keeps_every_field_the_agent_sends(self):
        self.token()
        self.run_once()
        report = self.server.requests[0][2]
        js = (
            "import(process.argv[1]).then(m => { const out = m.sanitizeReport(JSON.parse(process.argv[2]));"
            " process.stdout.write(JSON.stringify(out)); })"
        )
        r = subprocess.run(["node", "-e", js, SERVER_SRC.as_uri(), json.dumps(report)], capture_output=True, text=True, timeout=30,
                           cwd=SERVER_SRC.parent.parent)
        self.assertEqual(r.returncode, 0, r.stderr)
        kept = json.loads(r.stdout)
        self.assertEqual(kept["os"], {k: v for k, v in json.loads(OS_STATUS).items() if v != ""}, "empty strings are dropped, the rest kept")
        for k in ("cpu_percent", "mem_total_kb", "mem_available_kb", "root_disk_used_percent", "uptime_seconds"):
            self.assertIn(k, kept["metrics"], k)
        self.assertEqual(kept["role"], "edge")
        self.assertEqual(kept["agentVersion"], "2.0.0")


if __name__ == "__main__":
    unittest.main()

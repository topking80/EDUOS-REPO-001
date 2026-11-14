#!/usr/bin/env python3
"""Behavioral security tests for the EduOS enrollment intake.

Runs the real handler on an ephemeral loopback port against a temp token/queue
and asserts the security contract: authn, strict schema, framing, size/rate
limits, queue cap, method allow-list, and the loopback-only startup guard.

Run:  python3 -m unittest -v tests/test_enrollment.py   (from edge-platform/eduos)
"""
import http.client, importlib.util, json, os, tempfile, threading, unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
TMP = tempfile.mkdtemp(prefix="enroll-test-")
TOKEN = "T" * 48
os.environ.update({
    "EDUOS_ENROLL_TOKEN_FILE": str(Path(TMP, "token")),
    "EDUOS_ENROLL_DIR": str(Path(TMP, "pending")),
    "EDUOS_ROLE_FILE": str(Path(TMP, "role")),
    "EDUOS_ENROLL_MAX_PENDING": "1000",
})
Path(TMP, "token").write_text(TOKEN)
Path(TMP, "role").write_text("edge")

spec = importlib.util.spec_from_file_location("enroll", HERE.parent / "scripts" / "eduos-enrollment.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class EnrollmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), mod.Handler)
        cls.port = cls.srv.server_address[1]
        cls.t = threading.Thread(target=cls.srv.serve_forever, daemon=True)
        cls.t.start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        mod.attempts.clear()  # isolate rate-limit state per test

    def req(self, method, path, body=None, headers=None, token=TOKEN, raw_headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        h = {"Content-Type": "application/json"}
        if token is not None:
            h["Authorization"] = f"Bearer {token}"
        if headers:
            h.update(headers)
        payload = None if body is None else (body if isinstance(body, (bytes, str)) else json.dumps(body))
        c.request(method, path, body=payload, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        try:
            data = json.loads(data)
        except ValueError:
            pass
        return r.status, data

    # --- authn ---
    def test_health_open(self):
        self.assertEqual(self.req("GET", "/health", token=None)[0], 200)

    def test_missing_token_401(self):
        self.assertEqual(self.req("POST", "/api/v1/enrollments", {"device_id": "dev-001"}, token=None)[0], 401)

    def test_wrong_token_401(self):
        self.assertEqual(self.req("POST", "/api/v1/enrollments", {"device_id": "dev-001"}, token="x" * 48)[0], 401)

    def test_valid_enrollment_202_and_file(self):
        before = len(list(Path(TMP, "pending").glob("*.json"))) if Path(TMP, "pending").exists() else 0
        status, data = self.req("POST", "/api/v1/enrollments", {"device_id": "campus-lab-07", "requested_role": "teacher"})
        self.assertEqual(status, 202)
        self.assertEqual(data["status"], "pending_review")
        files = list(Path(TMP, "pending").glob("*.json"))
        self.assertEqual(len(files), before + 1)
        # written 0600, pending_review, never active
        self.assertEqual(oct(files[-1].stat().st_mode)[-3:], "600")
        rec = json.loads(files[-1].read_text())
        self.assertEqual(rec["status"], "pending_review")

    # --- strict schema / framing ---
    def test_extra_fields_rejected(self):
        self.assertEqual(self.req("POST", "/api/v1/enrollments", {"device_id": "d-123", "role": "admin"})[0], 400)

    def test_bad_device_id_rejected(self):
        self.assertEqual(self.req("POST", "/api/v1/enrollments", {"device_id": "a b/c"})[0], 400)

    def test_bad_role_rejected(self):
        self.assertEqual(self.req("POST", "/api/v1/enrollments", {"device_id": "dev-001", "requested_role": "root"})[0], 400)

    def test_wrong_content_type_415(self):
        self.assertEqual(self.req("POST", "/api/v1/enrollments", {"device_id": "dev-001"},
                                  headers={"Content-Type": "text/plain"})[0], 415)

    def test_chunked_rejected_411(self):
        # explicit chunked framing must be refused (new hardening)
        self.assertEqual(self.req("POST", "/api/v1/enrollments", b'{"device_id":"dev-001"}',
                                  headers={"Transfer-Encoding": "chunked"})[0], 411)

    def test_oversize_body_413(self):
        big = json.dumps({"device_id": "d" * 5000})
        self.assertEqual(self.req("POST", "/api/v1/enrollments", big)[0], 413)

    def test_methods_not_allowed(self):
        self.assertEqual(self.req("PUT", "/api/v1/enrollments", {"device_id": "d-1"})[0], 405)
        self.assertEqual(self.req("DELETE", "/api/v1/enrollments")[0], 405)

    # --- rate limit & queue cap (new hardening) ---
    def test_rate_limit_429(self):
        last = None
        for _ in range(mod.RATE_MAX + 3):
            last = self.req("POST", "/api/v1/enrollments", {"device_id": "ratelimit-dev"})[0]
        self.assertEqual(last, 429)

    def test_queue_full_503(self):
        orig = mod.MAX_PENDING
        mod.MAX_PENDING = 0  # force the cap
        try:
            self.assertEqual(self.req("POST", "/api/v1/enrollments", {"device_id": "queue-dev"})[0], 503)
        finally:
            mod.MAX_PENDING = orig

    # --- startup guards ---
    def test_loopback_guard(self):
        self.assertTrue(mod.loopback_only("127.0.0.1"))
        self.assertTrue(mod.loopback_only("::1"))
        self.assertFalse(mod.loopback_only("0.0.0.0"))
        self.assertFalse(mod.loopback_only("10.0.0.5"))

    def test_token_validation(self):
        self.assertEqual(mod.load_token(), TOKEN)          # valid
        p = Path(TMP, "token")
        p.write_text("short")                              # too short -> rejected
        self.assertEqual(mod.load_token(), "")
        p.write_text("bad token with spaces!" + "x" * 40)  # bad charset -> rejected
        self.assertEqual(mod.load_token(), "")
        p.write_text(TOKEN)                                # restore for other tests


if __name__ == "__main__":
    unittest.main(verbosity=2)

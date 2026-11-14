#!/usr/bin/env python3
"""32.0.53: the enrollment intake must refuse shipped placeholder tokens.

Run:  python3 -m unittest -v tests/test_enrollment_token.py   (from edge-platform/eduos)
"""
import importlib.util, os, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TMP = Path(tempfile.mkdtemp(prefix="enroll-token-test-"))
os.environ.update({"EDUOS_ENROLL_TOKEN_FILE": str(TMP / "token"), "EDUOS_ENROLL_DIR": str(TMP / "pending"),
                   "EDUOS_ROLE_FILE": str(TMP / "role")})
spec = importlib.util.spec_from_file_location("enroll_token", HERE.parent / "scripts" / "eduos-enrollment.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TokenTests(unittest.TestCase):
    def load(self, value):
        (TMP / "token").write_text(value)
        return mod.load_token()

    def test_shipped_placeholder_is_rejected(self):
        # The exact value 32.0.52 student.bu wrote to /etc/eduos/enrollment-token.
        self.assertEqual(self.load("EDUOS-STUDENT-ENROLL-TOKEN-PLACEHOLDER\n"), "")

    def test_other_placeholder_markers_are_rejected(self):
        for value in ("change-me-" + "x" * 40, "REPLACE_WITH_REAL_TOKEN_" + "y" * 20, "example-token-" + "z" * 30):
            self.assertEqual(self.load(value), "", value)

    def test_short_or_malformed_tokens_are_rejected(self):
        self.assertEqual(self.load("a" * 31), "")
        self.assertEqual(self.load("a" * 40 + " b"), "")

    def test_random_token_is_accepted(self):
        token = "q7Vb3kP0xY_r9LmN2-sT4uW6zA8cD1eF5gH7jK9"
        self.assertEqual(self.load(token + "\n"), token)

    def test_missing_file_is_rejected(self):
        (TMP / "token").unlink(missing_ok=True)
        self.assertEqual(mod.load_token(), "")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""32.0.54: build-time edge credentials and config lint.

Run:  python3 -m unittest -v tests/test_edge_config.py   (from edge-platform/eduos)
"""
import importlib.util, os, shutil, subprocess, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("edge_config", HERE.parent / "scripts" / "eduos-edge-config.py")
cfg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cfg)

GOOD_HASH = "$6$rounds=656000$abcdefghABCDEFGH$" + ("aB3./xYz9Q" * 9)[:86]
OLD_PLACEHOLDER_HASH = "$6$rounds=4096$CHANGE_ME$ EduOS-student-hash"
OLD_PLACEHOLDER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI...REPLACE... student-access-key"


def good_key():
    return cfg.synthetic_values(["X_SSH_KEYS"])["X_SSH_KEYS"]


def env_for(role, **overrides):
    names = sorted(set(cfg.MARKER.findall(cfg.role_source(role).read_text())))
    env = {"EDUOS_EDGE_SECRETS": "/nonexistent/secrets.env", **cfg.synthetic_values(names)}
    env.update(overrides)
    return env


class CredentialValidation(unittest.TestCase):
    def test_shipped_32_0_53_placeholders_are_rejected(self):
        with self.assertRaisesRegex(cfg.ConfigError, "placeholder"):
            cfg.validate_hash("H", OLD_PLACEHOLDER_HASH)
        with self.assertRaisesRegex(cfg.ConfigError, "placeholder|base64"):
            cfg.validate_key("K", OLD_PLACEHOLDER_KEY)

    def test_hash_formats(self):
        self.assertEqual(cfg.validate_hash("H", GOOD_HASH), GOOD_HASH)
        # A real hash may contain "..." by chance; it must still pass.
        lucky = "$6$saltsalt$" + "ab...cd" + "x" * 79
        self.assertEqual(cfg.validate_hash("H", lucky), lucky)
        for bad in ["", "plaintext-password", "$1$md5$deprecated", "$6$salt$short", "$6$REPLACEME$" + "a" * 86, "$6$...$..."]:
            with self.assertRaises(cfg.ConfigError, msg=bad):
                cfg.validate_hash("H", bad)
        openssl = shutil.which("openssl")
        if openssl:
            real = subprocess.run([openssl, "passwd", "-6", "pw-for-test"], capture_output=True, text=True).stdout.strip()
            self.assertEqual(cfg.validate_hash("H", real), real)

    def test_synthetic_hashes_always_pass_validation(self):
        # `make check` draws random throw-away hashes; one containing "..." or
        # an uppercase placeholder word must never fail CI.
        draws = iter(["...", "CHANGE"] + [None] * 10)
        real_choice = cfg.secrets.choice
        def rigged(alphabet):
            nxt = next(draws, None)
            if nxt == "...":
                return "..."
            if nxt == "CHANGE":
                return "CHANGE"
            return real_choice(alphabet)
        cfg.secrets.choice = rigged
        try:
            value = cfg.synthetic_values(["EDUOS_ADMIN_PASSWORD_HASH"])["EDUOS_ADMIN_PASSWORD_HASH"]
        finally:
            cfg.secrets.choice = real_choice
        cfg.validate_hash("EDUOS_ADMIN_PASSWORD_HASH", value)
        for _ in range(500):
            v = cfg.synthetic_values(["X_PASSWORD_HASH"])["X_PASSWORD_HASH"]
            cfg.validate_hash("X_PASSWORD_HASH", v)

    def test_key_formats(self):
        key = good_key()
        self.assertEqual(cfg.validate_key("K", key), key)
        for bad in ["ssh-dss AAAAB3NzaC1kc3M= x", "ssh-ed25519", "ssh-rsa " + key.split()[1],  # type mismatch
                    "ssh-ed25519 " + key.split()[1] + " REPLACE-me", "ssh-ed25519 AAAA@@@@ x"]:
            with self.assertRaises(cfg.ConfigError, msg=bad):
                cfg.validate_key("K", bad)
        keygen = shutil.which("ssh-keygen")
        if keygen:
            with tempfile.TemporaryDirectory() as d:
                subprocess.run([keygen, "-q", "-t", "ed25519", "-N", "", "-f", f"{d}/k"], check=True)
                real = Path(d, "k.pub").read_text().strip()
                self.assertEqual(cfg.validate_key("K", real), real)


class Rendering(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="edge-render-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_missing_values_fail_loudly_and_name_every_missing_credential(self):
        with self.assertRaises(cfg.ConfigError) as ctx:
            cfg.render("student", self.tmp / "s.bu", {"EDUOS_EDGE_SECRETS": "/nonexistent"})
        for name in ("EDUOS_STUDENT_PASSWORD_HASH", "EDUOS_STUDENT_DEVICE_ADMIN_PASSWORD_HASH", "EDUOS_STUDENT_DEVICE_ADMIN_SSH_KEYS"):
            self.assertIn(name, str(ctx.exception))
        self.assertFalse((self.tmp / "s.bu").exists())

    def test_placeholder_value_fails(self):
        with self.assertRaisesRegex(cfg.ConfigError, "placeholder"):
            cfg.render("student", self.tmp / "s.bu", env_for("student", EDUOS_STUDENT_PASSWORD_HASH=OLD_PLACEHOLDER_HASH))

    def test_render_substitutes_and_expands_key_lists(self):
        k1, k2 = good_key(), good_key()
        env = env_for("teacher", EDUOS_TEACHER_PASSWORD_HASH=GOOD_HASH, EDUOS_TEACHER_SSH_KEYS=f"{k1};{k2}")
        cfg.render("teacher", self.tmp / "t.bu", env)
        out = (self.tmp / "t.bu").read_text()
        self.assertIn(GOOD_HASH, out)
        self.assertIn(f'- "{k1}"', out)
        self.assertIn(f'- "{k2}"', out)
        self.assertNotIn("@@", out)
        self.assertEqual((self.tmp / "t.bu").stat().st_mode & 0o777, 0o600)

    def test_secrets_file_and_key_file(self):
        key_file = self.tmp / "admin.pub"
        key_file.write_text(good_key() + "\n")
        secrets = self.tmp / "edge.env"
        secrets.write_text(f"# operator file\nEDUOS_ADMIN_PASSWORD_HASH='{GOOD_HASH}'\nEDUOS_ADMIN_SSH_KEYS_FILE={key_file}\n")
        secrets.chmod(0o600)
        cfg.render("admin", self.tmp / "a.bu", {"EDUOS_EDGE_SECRETS": str(secrets)})
        self.assertIn(GOOD_HASH, (self.tmp / "a.bu").read_text())


class Lint(unittest.TestCase):
    def test_repository_sources_are_clean(self):
        self.assertEqual(cfg.lint(), [])

    def test_lint_flags_committed_credentials_and_kiosk_admin_groups(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "butane").mkdir()
            (root / "butane" / "student.bu").write_text(
                "passwd:\n  users:\n    - name: student\n      groups: [ wheel ]\n"
                f"      password_hash: {OLD_PLACEHOLDER_HASH}\n      ssh_authorized_keys:\n        - \"{good_key()}\"\n"
                "storage:\n  files:\n    - path: /etc/eduos/enrollment-token\n")
            problems = "\n".join(cfg.lint(root))
            self.assertIn("committed password_hash", problems)
            self.assertIn("committed SSH public key", problems)
            self.assertIn("kiosk account 'student'", problems)
            self.assertIn("enrollment token", problems)

    def test_student_is_not_admin_and_has_separate_admin_account(self):
        text = cfg.role_source("student").read_text()
        users = dict(cfg.users_in(text))
        self.assertEqual(users["student"] & cfg.KIOSK_FORBIDDEN_GROUPS, set())
        self.assertIn("wheel", users["eduos-admin"])
        self.assertNotIn("ssh_authorized_keys", text.split("- name: eduos-admin")[0].split("- name: student")[1])


if __name__ == "__main__":
    unittest.main()

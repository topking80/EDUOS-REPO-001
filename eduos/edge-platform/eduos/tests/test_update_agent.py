"""Edge Phase 2: scripts/eduos-update.sh against fake rpm-ostree and systemctl.

The agent configures Zincati from the district update policy, verifies a new
deployment after it boots, holds updates and rolls back once if it's
unhealthy, and writes a status file for the health agent.
"""
import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "eduos-update.sh"
SHIPPED_POLICY = (ROOT / "configs" / "update-policy.toml").read_text()
OLD = "a" * 64
NEW = "b" * 64
V1, V2 = "45.20261110.3.0", "45.20261117.3.0"
TOKEN = "edh1.11111111-2222-4333-8444-555555555555." + "A" * 43

FAKE_RPM_OSTREE = r"""#!/bin/bash
echo "rpm-ostree $*" >> "$FAKE_CALLS"
if [[ "$1" == status ]]; then
  q="$*"
  case "$q" in
    *"booted==true)].checksum"*) echo "[\"$FAKE_BOOTED\"]" ;;
    *"booted==true)].version"*) echo "[\"$FAKE_BOOTED_VERSION\"]" ;;
    *"staged==true)].version"*) [[ -n "${FAKE_STAGED_VERSION:-}" ]] && echo "[\"$FAKE_STAGED_VERSION\"]" || echo "[]" ;;
  esac
fi
exit 0
"""
FAKE_CURL = r"""#!/bin/bash
echo "curl $*" >> "$FAKE_CALLS"
[[ -n "${FAKE_CURL_FAIL:-}" ]] && exit 22
printf '%s' "${FAKE_TARGET_BODY:-}"
"""
FAKE_SYSTEMCTL = r"""#!/bin/bash
echo "systemctl $*" >> "$FAKE_CALLS"
case "$1" in
  list-units) [[ -n "${FAKE_FAILED:-}" ]] && echo "$FAKE_FAILED loaded failed failed EduOS thing" ;;
  is-active) echo "${FAKE_ZINCATI:-active}" ;;
esac
exit 0
"""


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="eduos-update-test-"))
        self.etc, self.var, self.bin = self.tmp / "etc", self.tmp / "var", self.tmp / "bin"
        for d in (self.etc / "eduos", self.var, self.bin):
            d.mkdir(parents=True)
        (self.etc / "machine-id").write_text("0123456789abcdef0123456789abcdef\n")
        for name, body in (("rpm-ostree", FAKE_RPM_OSTREE), ("systemctl", FAKE_SYSTEMCTL), ("curl", FAKE_CURL), ("logger", "#!/bin/bash\nexit 0\n")):
            p = self.bin / name
            p.write_text(body)
            p.chmod(0o755)
        self.calls = self.tmp / "calls.log"
        self.calls.write_text("")
        self.uptime, self.loadavg = self.tmp / "uptime", self.tmp / "loadavg"
        self.set_uptime(7200)
        self.loadavg.write_text("0.10 0.10 0.10 1/100 1\n")
        self.policy(SHIPPED_POLICY)

    def policy(self, text):
        (self.etc / "eduos" / "update-policy.toml").write_text(textwrap.dedent(text))

    def set_uptime(self, seconds):
        self.uptime.write_text(f"{seconds}.00 100.00\n")

    def run_agent(self, *args, booted=OLD, failed="", expect=0, **extra):
        env = {
            "PATH": f"{self.bin}:{os.environ['PATH']}", "EDUOS_ETC": str(self.etc), "EDUOS_VAR": str(self.var),
            "FAKE_CALLS": str(self.calls), "FAKE_BOOTED": booted, "FAKE_BOOTED_VERSION": "45.20261110.3.0",
            "FAKE_FAILED": failed, "EDUOS_CLOCK": "12:00", "EDUOS_UPTIME": str(self.uptime), "EDUOS_LOADAVG": str(self.loadavg), **extra,
        }
        r = subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, expect, r.stderr)
        return r

    def fragment(self):
        return (self.etc / "zincati" / "config.d" / "55-eduos-policy.toml").read_text()

    def calls_matching(self, pattern):
        return [line for line in self.calls.read_text().splitlines() if re.search(pattern, line)]

    def status(self):
        return json.loads((self.var / "os-status" / "status.json").read_text())

    def state(self, name):
        return (self.var / "updates" / name).read_text().strip()



class UpdateAgent(Harness):
    # ---- policy -> Zincati ----

    def test_shipped_policy_gives_district_windows_and_a_canary_cohort(self):
        self.policy(SHIPPED_POLICY.replace("require_district_signoff = true", "require_district_signoff = false"))
        self.run_agent("apply-policy")
        f = self.fragment()
        self.assertIn('strategy = "periodic"', f)
        self.assertIn('time_zone = "America/Chicago"', f)
        self.assertIn('start_time = "02:00"', f)
        self.assertIn("length_minutes = 120", f)
        self.assertIn("enabled = true", f)
        self.assertRegex(f, r"rollout_wariness = (0\.0|1\.0)")
        self.assertIn(self.state("cohort"), ("canary", "standard"))
        self.assertEqual(len(self.calls_matching("try-restart zincati")), 1)
        self.run_agent("apply-policy")
        self.assertEqual(len(self.calls_matching("try-restart zincati")), 1, "unchanged policy doesn't restart Zincati")

    def test_cohort_follows_the_canary_percent_and_is_stable(self):
        self.policy('[general]\nstrategy = "canary"\n[canary]\npercent = 0\n')
        self.run_agent("apply-policy")
        self.assertEqual(self.state("cohort"), "standard")
        self.assertIn("rollout_wariness = 1.0", self.fragment())
        self.policy('[general]\nstrategy = "canary"\n[canary]\npercent = 100\n')
        self.run_agent("apply-policy")
        self.assertEqual(self.state("cohort"), "canary")
        self.assertIn("rollout_wariness = 0.0", self.fragment())
        hits = 0
        for i in range(200):
            (self.etc / "machine-id").write_text(f"{i:032x}\n")
            self.policy('[general]\nstrategy = "canary"\n[canary]\npercent = 10\n')
            self.run_agent("apply-policy")
            hits += self.state("cohort") == "canary"
        self.assertTrue(5 <= hits <= 40, f"about 10% of devices are canaries, got {hits}/200")

    def test_immediate_and_disabled_and_wrapping_windows(self):
        self.policy('[general]\nstrategy = "immediate"\n')
        self.run_agent("apply-policy")
        self.assertIn('strategy = "immediate"', self.fragment())
        self.assertNotIn("window", self.fragment())
        self.assertNotIn("rollout_wariness", self.fragment())
        self.policy('[general]\nenabled = false\nstrategy = "maintenance-window-only"\n[maintenance_window]\nstart = "23:00"\nend = "01:30"\n')
        self.run_agent("apply-policy")
        self.assertIn("enabled = false", self.fragment())
        self.assertIn("length_minutes = 150", self.fragment(), "a window can wrap past midnight")
        self.assertIn('time_zone = "localtime"', self.fragment())

    def test_shipped_policy_needs_district_sign_off_before_any_update(self):
        self.run_agent("run")
        self.assertIn("enabled = false", self.fragment(), "no endpoint or token yet: Zincati must not update on its own")
        self.assertEqual(self.calls_matching("^curl"), [])
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [])
        self.assertEqual(self.status()["approval"], "unreachable")

    def test_a_bad_policy_is_refused_and_the_last_good_config_stays(self):
        self.run_agent("apply-policy")
        before = self.fragment()
        for bad in ('[maintenance_window]\nstart = "25:00"\n', '[canary]\npercent = 150\n', '[general]\nstrategy = "yolo"\n',
                    '[maintenance_window]\ntimezone = "Bad; rm -rf /"\n', '[maintenance_window]\nstart = "03:00"\nend = "03:00"\n'):
            self.policy(bad)
            self.run_agent("apply-policy", expect=2)
            self.assertEqual(self.fragment(), before, bad)

    # ---- verify after an update ----

    def test_first_boot_waits_for_the_health_window_then_becomes_known_good(self):
        self.set_uptime(60)
        self.run_agent("verify")
        self.assertEqual(self.state("last-verify"), "pending")
        self.assertFalse((self.var / "updates" / "known-good").exists())
        self.set_uptime(3600)
        self.run_agent("verify")
        self.assertEqual(self.state("known-good"), OLD)
        self.assertEqual(self.state("last-verify"), "first_boot")

    def test_a_healthy_update_becomes_known_good_without_rollback(self):
        self.run_agent("verify")
        self.run_agent("verify", booted=NEW)
        self.assertEqual(self.state("known-good"), NEW)
        self.assertEqual(self.state("last-verify"), "healthy")
        self.assertEqual(self.calls_matching("rollback"), [])

    def test_an_unhealthy_update_holds_updates_and_rolls_back_once(self):
        self.run_agent("verify")
        self.run_agent("verify", booted=NEW, failed="eduos-school-node.service")
        self.assertEqual(self.calls_matching(r"rpm-ostree rollback --reboot"), ["rpm-ostree rollback --reboot"])
        self.assertEqual(self.state("last-verify"), "rolled_back")
        self.assertEqual(self.state("known-good"), OLD)
        hold = (self.etc / "zincati" / "config.d" / "90-eduos-hold.toml").read_text()
        self.assertIn("enabled = false", hold, "Zincati must not re-apply the same release")
        self.assertIn("eduos-school-node.service", self.state("hold-reason"))
        # If the device is still on the bad deployment next time, it doesn't loop.
        self.run_agent("verify", booted=NEW, failed="eduos-school-node.service")
        self.assertEqual(len(self.calls_matching("rollback")), 1)
        self.assertEqual(self.state("last-verify"), "unhealthy")

    def test_no_automatic_rollback_when_the_policy_says_so(self):
        self.run_agent("verify")
        self.policy('[rollback]\nautomatic = false\n')
        self.run_agent("verify", booted=NEW, failed="eduos-health.service")
        self.assertEqual(self.calls_matching("rollback"), [])
        self.assertEqual(self.state("last-verify"), "unhealthy")
        self.assertTrue((self.etc / "zincati" / "config.d" / "90-eduos-hold.toml").exists())

    def test_cpu_over_the_threshold_counts_as_unhealthy(self):
        self.run_agent("verify")
        self.loadavg.write_text(f"9 {os.cpu_count() * 2} 9 1/100 1\n")
        self.run_agent("verify", booted=NEW)
        self.assertIn("CPU load", self.state("hold-reason"))

    # ---- status for the health agent ----

    def test_status_reports_versions_hold_and_cohort_as_json(self):
        self.run_agent("run", FAKE_STAGED_VERSION="45.20261117.3.0")
        s = json.loads((self.var / "os-status" / "status.json").read_text())
        self.assertEqual(s["booted_version"], "45.20261110.3.0")
        self.assertEqual(s["booted_checksum"], OLD)
        self.assertEqual(s["staged_version"], "45.20261117.3.0")
        self.assertEqual(s["updates"], "enabled")
        self.assertIn(s["cohort"], ("canary", "standard"))
        self.run_agent("verify", booted=NEW, failed="eduos-x.service")
        self.run_agent("status", booted=OLD)
        s = json.loads((self.var / "os-status" / "status.json").read_text())
        self.assertEqual(s["updates"], "held")
        self.assertIn("eduos-x.service", s["hold_reason"])
        self.run_agent("release-hold")
        s = json.loads((self.var / "os-status" / "status.json").read_text())
        self.assertEqual(s["updates"], "enabled")
        self.assertFalse((self.etc / "zincati" / "config.d" / "90-eduos-hold.toml").exists())


class DistrictSignoff(Harness):
    """[approvals].require_district_signoff: install only what EduOS approved."""

    def setUp(self):
        super().setUp()
        (self.etc / "eduos" / "health.toml").write_text('[reporting]\nendpoint = "https://eduos.example.org/api/edge/health"\n')
        (self.etc / "eduos" / "health-token").write_text(TOKEN + "\n")
        self.policy(SHIPPED_POLICY.replace("percent = 10 ", "percent = 100"))

    def answer(self, target=None, require=True, stage=None):
        t = "null" if target is None else f'"{target}"'
        return {"FAKE_TARGET_BODY": f'{{"data":{{"requireApproval":{str(require).lower()},"target":{t},"stage":"{stage or "canary"}"}}}}'}

    def test_asks_eduos_with_the_device_token_and_cohort(self):
        self.run_agent("run", **self.answer())
        (call,) = self.calls_matching("^curl")
        self.assertIn(f"Authorization: Bearer {TOKEN}", call)
        self.assertIn("https://eduos.example.org/api/edge/update-target?cohort=canary", call)
        self.assertIn("enabled = false", self.fragment())
        self.assertEqual(self.status()["approval"], "waiting", "nothing approved: install nothing")
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [])

    def test_installs_the_approved_version_inside_the_window_once(self):
        self.run_agent("run", **self.answer(V2))
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [], "12:00 is outside the 02:00-04:00 window")
        self.assertEqual(self.status()["target_version"], V2)
        self.assertEqual(self.status()["approval"], "waiting")
        self.run_agent("run", EDUOS_CLOCK="02:30", **self.answer(V2))
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [f"rpm-ostree deploy --bypass-driver --reboot {V2}"])
        self.assertEqual(self.status()["approval"], "installing")
        self.run_agent("run", EDUOS_CLOCK="02:45", **self.answer(V2))
        self.assertEqual(len(self.calls_matching("rpm-ostree deploy ")), 1, "not retried within six hours")

    def test_already_on_the_approved_version(self):
        self.run_agent("run", EDUOS_CLOCK="02:30", **self.answer(V1))
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [])
        self.assertEqual(self.status()["approval"], "current")

    def test_held_or_rolled_back_versions_are_not_installed(self):
        self.run_agent("verify")
        self.run_agent("verify", booted=NEW, failed="eduos-x.service", FAKE_BOOTED_VERSION=V2)
        self.assertEqual(self.state("rollback-from-version"), V2)
        self.run_agent("run", EDUOS_CLOCK="02:30", **self.answer(V2))
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [], "held")
        self.assertEqual(self.status()["rollback_from_version"], V2, "reported so EduOS blocks its promotion")
        self.run_agent("release-hold")
        self.run_agent("run", EDUOS_CLOCK="02:30", **self.answer(V2))
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [], "never re-installs a version it rolled back from")

    def test_districts_without_approvals_keep_zincati_through_outages(self):
        self.run_agent("run", **self.answer(require=False))
        self.assertIn("enabled = true", self.fragment())
        self.assertEqual(self.status()["approval"], "off")
        self.run_agent("run", FAKE_CURL_FAIL="1")
        self.assertIn("enabled = true", self.fragment(), "a network blip doesn't flip Zincati")
        self.assertEqual(self.status()["approval"], "unreachable")

    def test_bad_answers_and_plain_http_install_nothing(self):
        self.run_agent("run", EDUOS_CLOCK="02:30", FAKE_TARGET_BODY='{"data":{"requireApproval":true,"target":"$(reboot)"}}')
        self.run_agent("run", EDUOS_CLOCK="02:30", FAKE_TARGET_BODY="<html>proxy error</html>")
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [])
        self.assertIn("enabled = false", self.fragment())
        (self.etc / "eduos" / "health.toml").write_text('[reporting]\nendpoint = "http://eduos.example.org/api/edge/health"\n')
        n = len(self.calls_matching("^curl"))
        self.run_agent("run", EDUOS_CLOCK="02:30", **self.answer(V2))
        self.assertEqual(len(self.calls_matching("^curl")), n, "never over plain http")
        self.assertEqual(self.calls_matching("rpm-ostree deploy "), [])


if __name__ == "__main__":
    unittest.main()

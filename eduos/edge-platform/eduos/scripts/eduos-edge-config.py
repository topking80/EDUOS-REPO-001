#!/usr/bin/env python3
"""EduOS edge build-time credentials and config lint (32.0.54).

The Butane sources in butane/*.bu contain NO credentials. Account passwords and
SSH keys are template markers (@@NAME@@) that are filled in at build time from
operator-supplied values kept outside git:

  * environment variables, or
  * a secrets file (KEY=VALUE lines, no shell expansion) named by
    EDUOS_EDGE_SECRETS (default: secrets/edge-credentials.env, git-ignored).
    For any KEY, KEY_FILE=/path may be given instead (hash file, or an
    authorized_keys file for *_SSH_KEYS).

  NAME ending in _PASSWORD_HASH : a crypt(3) hash, e.g. `mkpasswd -m yescrypt`
                                  or `openssl passwd -6`
  NAME ending in _SSH_KEYS      : one or more OpenSSH public keys (';'-separated
                                  in a single value, or one per line in KEY_FILE)

The build fails loudly when a value is missing, malformed, or a known
placeholder (CHANGE_ME, REPLACE..., PLACEHOLDER, EXAMPLE, "...", ...).

Usage (from edge-platform/eduos):
  eduos-edge-config.py markers                 list every marker each role needs
  eduos-edge-config.py render ROLE OUT.bu      render butane/ROLE.bu -> OUT.bu (0600)
  eduos-edge-config.py lint                    scan sources for committed creds/placeholders
  eduos-edge-config.py check [--butane PATH]   lint + render every role with throw-away
                                               credentials + `butane --strict`
"""
import base64, os, re, secrets, shutil, stat, string, struct, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MARKER = re.compile(r"@@([A-Z][A-Z0-9_]*)@@")
PLACEHOLDER_WORDS = ("CHANGE", "REPLACE", "PLACEHOLDER", "EXAMPLE", "TODO", "FIXME", "DUMMY", "YOUR_", "XXXX")
HASH_RE = re.compile(r"^\$(?:6|5)\$(?:rounds=\d{4,9}\$)?[./A-Za-z0-9]{1,16}\$[./A-Za-z0-9]{43,86}$"
                     r"|^\$y\$[./A-Za-z0-9]+\$[./A-Za-z0-9]{1,86}\$[./A-Za-z0-9]{43}$"
                     r"|^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$")
KEY_TYPES = {"ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
             "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"}
# Accounts on kiosk (student) devices must never hold administrative groups.
KIOSK_FORBIDDEN_GROUPS = {"wheel", "sudo", "adm", "root", "docker", "systemd-journal", "disk", "lp"}


class ConfigError(Exception):
    pass


# Random key/hash material can contain short words by chance, so it is only
# checked (case-sensitively) for the long markers real placeholders use.
RANDOM_SAFE_WORDS = ("CHANGE", "REPLACE", "PLACEHOLDER", "EXAMPLE")


def placeholder_word(value, words=PLACEHOLDER_WORDS, fold=True):
    hay = value.upper() if fold else value
    return next((w for w in words if w in hay), None)


def validate_hash(name, value):
    value = value.strip()
    if not value:
        raise ConfigError(f"{name} is empty")
    word = placeholder_word(value, RANDOM_SAFE_WORDS, fold=False)
    if word or "..." in value or " " in value:
        raise ConfigError(f"{name} looks like a placeholder ({word or 'contains spaces/...'}); supply a real crypt(3) hash")
    if not HASH_RE.match(value):
        raise ConfigError(f"{name} is not a sha512/sha256-crypt, yescrypt or bcrypt hash (generate one with `mkpasswd -m yescrypt` or `openssl passwd -6`)")
    return value


def validate_key(name, line):
    parts = line.strip().split(None, 2)
    if len(parts) < 2:
        raise ConfigError(f"{name}: not an OpenSSH public key: {line[:40]!r}")
    ktype, blob_b64 = parts[0], parts[1]
    comment = parts[2] if len(parts) > 2 else ""
    if ktype not in KEY_TYPES:
        raise ConfigError(f"{name}: unsupported key type {ktype!r}")
    word = placeholder_word(blob_b64, RANDOM_SAFE_WORDS, fold=False) or placeholder_word(comment)
    if word or "..." in line:
        raise ConfigError(f"{name}: key looks like a placeholder ({word or '...'})")
    try:
        blob = base64.b64decode(blob_b64, validate=True)
        (n,) = struct.unpack(">I", blob[:4])
        inner = blob[4:4 + n].decode()
    except Exception:
        raise ConfigError(f"{name}: key data is not valid base64 OpenSSH key material")
    if inner != ktype:
        raise ConfigError(f"{name}: key blob type {inner!r} does not match {ktype!r}")
    if ktype == "ssh-ed25519" and len(blob) != 51:
        raise ConfigError(f"{name}: truncated ed25519 key")
    return line.strip()


def load_secrets_file(path):
    values = {}
    if not path.exists():
        return values
    try:
        tracked = subprocess.run(["git", "ls-files", "--error-unmatch", str(path)], cwd=path.parent,
                                 capture_output=True).returncode == 0
    except FileNotFoundError:
        tracked = False
    if tracked:
        raise ConfigError(f"{path} is tracked by git; keep edge credentials outside version control")
    if path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        print(f"warning: {path} is readable by group/other; chmod 600 it", file=sys.stderr)
    for lineno, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ConfigError(f"{path}:{lineno}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def lookup(name, env, file_values):
    for source in (env, file_values):
        if source.get(name):
            return source[name]
        if source.get(name + "_FILE"):
            p = Path(source[name + "_FILE"]).expanduser()
            if not p.is_file():
                raise ConfigError(f"{name}_FILE points to a missing file: {p}")
            return p.read_text()
    return None


def resolve(name, env, file_values):
    raw = lookup(name, env, file_values)
    if raw is None:
        raise ConfigError(f"{name} is not set (environment, or {secrets_path(env)})")
    if name.endswith("_PASSWORD_HASH"):
        return [validate_hash(name, raw.strip().splitlines()[0] if raw.strip() else "")]
    if name.endswith("_SSH_KEYS"):
        keys = [k for k in re.split(r"[;\n]", raw) if k.strip() and not k.strip().startswith("#")]
        if not keys:
            raise ConfigError(f"{name} contains no keys")
        return [validate_key(name, k) for k in keys]
    raise ConfigError(f"unknown marker type {name} (expected *_PASSWORD_HASH or *_SSH_KEYS)")


def secrets_path(env):
    return Path(env.get("EDUOS_EDGE_SECRETS") or ROOT / "secrets" / "edge-credentials.env")


def role_source(role):
    path = ROOT / "butane" / f"{role}.bu"
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", role) or not path.is_file():
        raise ConfigError(f"no Butane source for role {role!r}")
    return path


def render_text(text, values):
    out = []
    for line in text.splitlines(keepends=True):
        m = MARKER.search(line)
        if not m:
            out.append(line)
            continue
        name = m.group(1)
        vals = values[name]
        list_item = re.match(r'^(\s*)- "@@%s@@"\s*$' % name, line)
        if list_item:  # expand into one YAML list item per key
            out.extend(f'{list_item.group(1)}- "{v}"\n' for v in vals)
        else:
            if len(vals) != 1:
                raise ConfigError(f"{name} used as a scalar but has {len(vals)} values")
            out.append(line.replace(m.group(0), vals[0]))
    return "".join(out)


def render(role, out_path, env=None):
    env = dict(os.environ if env is None else env)
    text = role_source(role).read_text()
    names = sorted(set(MARKER.findall(text)))
    file_values = load_secrets_file(secrets_path(env))
    values, errors = {}, []
    for name in names:
        try:
            values[name] = resolve(name, env, file_values)
        except ConfigError as e:
            errors.append(str(e))
    if errors:
        raise ConfigError(f"cannot build {role}: " + "; ".join(errors))
    rendered = render_text(text, values)
    if MARKER.search(rendered):
        raise ConfigError(f"{role}: unresolved marker after rendering")
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(rendered)
    os.chmod(out_path, 0o600)
    return names


def users_in(text):
    """Very small YAML walk: yield (name, groups-line) for passwd.users entries."""
    current = None
    for line in text.splitlines():
        m = re.match(r"^\s*- name:\s*([A-Za-z0-9_.-]+)\s*$", line)
        if m:
            current = m.group(1)
        g = re.match(r"^\s*groups:\s*\[(.*)\]\s*$", line)
        if g and current:
            yield current, {x.strip().strip("'\"") for x in g.group(1).split(",") if x.strip()}


def lint(root=ROOT):
    problems = []
    sources = sorted([*root.glob("butane/*.bu"), *root.glob("overlays/**/*.bu"), *root.glob("**/*.yaml"),
                      *root.glob("**/*.yml"), *root.glob("pi5/*")])
    for path in sources:
        if not path.is_file() or "build" in path.relative_to(root).parts:
            continue
        rel = path.relative_to(root)
        text = path.read_text(errors="replace")
        for lineno, line in enumerate(text.splitlines(), 1):
            if re.search(r"password_hash\s*:", line) and not re.search(r'password_hash:\s*"?@@[A-Z0-9_]+_PASSWORD_HASH@@"?\s*(#.*)?$', line):
                problems.append(f"{rel}:{lineno}: committed password_hash value (use a @@..._PASSWORD_HASH@@ marker)")
            if re.search(r"\b(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+AAAA", line):
                problems.append(f"{rel}:{lineno}: committed SSH public key (use a @@..._SSH_KEYS@@ marker)")
            if "ENROLL-TOKEN-PLACEHOLDER" in line or re.search(r"/etc/eduos/enrollment-token", line):
                problems.append(f"{rel}:{lineno}: enrollment token must not be shipped (generated at /run/eduos/enrollment-token)")
        for user, groups in users_in(text):
            bad = groups & KIOSK_FORBIDDEN_GROUPS
            if user == "student" and bad:
                problems.append(f"{rel}: kiosk account 'student' is in privileged group(s) {sorted(bad)}")
    return problems


def synthetic_values(names):
    """Throw-away, format-valid credentials for `check` (never usable to log in)."""
    alphabet = string.ascii_letters + string.digits + "./"
    rand = lambda n: "".join(secrets.choice(alphabet) for _ in range(n))
    env = {}
    for name in names:
        if name.endswith("_PASSWORD_HASH"):
            env[name] = f"$6$rounds=656000${rand(16)}${rand(86)}"
        else:
            blob = struct.pack(">I", 11) + b"ssh-ed25519" + struct.pack(">I", 32) + secrets.token_bytes(32)
            env[name] = f"ssh-ed25519 {base64.b64encode(blob).decode()} eduos-check-only"
    return env


def all_roles():
    return sorted(p.stem for p in (ROOT / "butane").glob("*.bu"))


def check(butane):
    problems = lint()
    for p in problems:
        print(f"lint: {p}", file=sys.stderr)
    if problems:
        return 1
    exe = shutil.which(butane) or (butane if Path(butane).is_file() else None)
    if not exe:
        print(f"check: butane not found ({butane}); install it or pass --butane PATH", file=sys.stderr)
        return 1
    with tempfile.TemporaryDirectory(prefix="eduos-edge-check-") as tmp:
        names = sorted({n for r in all_roles() for n in MARKER.findall(role_source(r).read_text())})
        env = {"PATH": os.environ.get("PATH", ""), "EDUOS_EDGE_SECRETS": str(Path(tmp, "none.env")), **synthetic_values(names)}
        base = Path(tmp, "base.ign")
        subprocess.run([exe, "--strict", "-d", str(ROOT), str(ROOT / "butane/base.bu"), "-o", str(base)], check=True)
        for role in all_roles():
            out = Path(tmp, f"{role}.bu")
            render(role, out, env)
            # merge local: ignition/base.ign is resolved inside the files-dir; use a scratch copy
            staged = Path(tmp, "files")
            if not staged.exists():
                shutil.copytree(ROOT, staged, ignore=shutil.ignore_patterns("build", "boot", "docs", "demo", "*.ign"))
                (staged / "ignition").mkdir(exist_ok=True)
                shutil.copy(base, staged / "ignition" / "base.ign")
            r = subprocess.run([exe, "--strict", "-d", str(staged), str(out)], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"check: butane --strict failed for {role}:\n{r.stderr}", file=sys.stderr)
                return 1
            if MARKER.search(r.stdout) or any(w in r.stdout for w in ("CHANGE_ME", "REPLACE", "ENROLL-TOKEN-PLACEHOLDER")):
                print(f"check: {role} Ignition still contains a marker or placeholder", file=sys.stderr)
                return 1
            print(f"check: {role} ok ({', '.join(MARKER.findall(role_source(role).read_text())) or 'no credentials'})")
        for overlay in sorted(ROOT.glob("overlays/**/*.bu")):
            r = subprocess.run([exe, "--strict", "-d", str(ROOT), str(overlay)], capture_output=True, text=True)
            if r.returncode != 0:
                print(f"check: butane --strict failed for {overlay.relative_to(ROOT)}:\n{r.stderr}", file=sys.stderr)
                return 1
            print(f"check: {overlay.relative_to(ROOT)} ok")
    return 0


def main(argv):
    try:
        if len(argv) >= 1 and argv[0] == "markers":
            for role in all_roles():
                print(f"{role}: {' '.join(sorted(set(MARKER.findall(role_source(role).read_text())))) or '-'}")
            return 0
        if len(argv) == 3 and argv[0] == "render":
            names = render(argv[1], argv[2])
            print(f"rendered {argv[1]} -> {argv[2]} ({len(names)} credential(s))")
            return 0
        if argv[:1] == ["lint"]:
            problems = lint()
            for p in problems:
                print(f"lint: {p}", file=sys.stderr)
            print(f"lint: {len(problems)} problem(s)")
            return 1 if problems else 0
        if argv[:1] == ["check"]:
            butane = argv[argv.index("--butane") + 1] if "--butane" in argv else os.environ.get("BUTANE", "butane")
            return check(butane)
    except ConfigError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    print(__doc__, file=sys.stderr)
    return 64


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

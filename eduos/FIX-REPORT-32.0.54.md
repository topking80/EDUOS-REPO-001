# EduOS 32.0.54: edge hardening follow-up

32.0.53 fixed the 24 review findings. Three edge-platform issues were outside
that scope, and two small API/build issues remained. All five are fixed here.

## 1. Placeholder password hashes and SSH keys (edge Butane/Ignition)

**Before.** `edge-platform/eduos/butane/*.bu` committed placeholder hashes such
as `$6$rounds=4096$CHANGE_ME$...` and keys such as `ssh-ed25519
AAAAC3NzaC1lZDI1NTE5AAAAI...REPLACE...`. Compiled `ignition/*.ign` files
carrying the same values were also committed and could be flashed as-is.

**Now.**
- Every credential is a marker, `@@EDUOS_<ACCOUNT>_PASSWORD_HASH@@` or
  `@@EDUOS_<ACCOUNT>_SSH_KEYS@@`. There are 10 in total (`make credentials`
  lists them per role).
- `scripts/eduos-edge-config.py render` fills the markers in from environment
  variables, `<KEY>_FILE` paths, or a KEY=VALUE secrets file outside git
  (`EDUOS_EDGE_SECRETS`, default `secrets/edge-credentials.env`, git-ignored).
- The build **fails** and names every problem when a value is:
  - missing;
  - not a crypt(3) hash (sha512/sha256-crypt, yescrypt or bcrypt; plaintext
    and MD5 are rejected);
  - not a well-formed OpenSSH public key (type and blob are checked against
    each other);
  - a known placeholder (CHANGE/REPLACE/PLACEHOLDER/EXAMPLE, `...`, and
    TODO/DUMMY/YOUR_ in key comments).
- The build also refuses a secrets file that is tracked by git, and warns when
  that file is group- or world-readable.
- The rendered `build/*.bu` and the output `ignition/*.ign` are written 0600.
  Make deletes `build/*.bu` after compiling. `ignition/*.ign` is git-ignored and
  has been removed from the repository. Every compile uses `butane --strict`.
- CI (`.github/workflows/build-eduos.yml`) runs `make check` and then builds
  with repository secrets of the same names.

## 2. Student kiosk account in `wheel`

**Before.** `butane/student.bu` put `student` in `wheel` and gave it an SSH
key. On FCOS that is full sudo for whoever sits at the kiosk.

**Now.**
- `student` (uid 1001) has `groups: []`, no SSH key, and a password hash
  supplied at build time.
- `configs/polkit/50-eduos-student-kiosk.rules` (installed to
  `/etc/polkit-1/rules.d/`) allows `student` only `login1` reboot, power-off
  and suspend, and only from its own active local session. Every other polkit
  action is denied for that user. Other users are not affected.
- No EduOS unit runs as or needs `student`. Bootstrap, health and update run
  as root, and enrollment runs as `eduos-enrollment`. Nothing the kiosk used
  is lost.
- Administration of student devices moves to a separate `eduos-admin` account
  (uid 1090). It is in `wheel`, uses SSH keys, and needs a password for sudo
  (`EDUOS_STUDENT_DEVICE_ADMIN_*`).
- The lint fails if `student` appears in wheel, sudo, adm, root, docker,
  systemd-journal, disk or lp in any Butane/YAML source.

## 3. `platform/edge-runtime-reference`: deprecated, not synced

I chose to deprecate the tree rather than port the fixes to it:
- It is an unmodified copy of the bundle uploaded in 32.0.39, kept for
  provenance (see `EDGE-RUNTIME-SECURITY-REVIEW-32.0.41.md`).
- Nothing builds from it, and nothing serves it. `public/eduos-edge-docs` is a
  separate copy.
- Porting the fixes would create a second hardened tree that duplicates
  `edge-platform/eduos` and would drift from it.
- It contained prebuilt `.ign` files with placeholder hashes and keys, a
  shipped enrollment token, and a `student` account in `wheel`. These were
  hazards that could be flashed directly.

**What changed.**
- The 72 files were removed. `DEPRECATED.md` explains the change and points to
  `edge-platform/eduos`.
- The new `Makefile` there fails every target with an error.
- The original stays available for audit in the 32.0.52 archive and in git
  (`git show baseline:platform/edge-runtime-reference/...`).
- `test/edge-platform-integration.test.js` now checks that the tree is
  tombstoned. `test/edge-credentials-32054.test.js` checks that its build is
  refused.

## 4. API fails fast on an unmigrated database

- `src/server.js` now calls `assertSchemaReady()` at startup, after the
  runtime-role check.
- It compares `schema_migrations` against the numbered migrations in `db/`.
  These match `src/migrate.js`, and a test checks that they do.
- The API exits with a clear message when:
  - the schema was never migrated (no `schema_migrations` table);
  - N migrations are missing (they are named);
  - the runtime role cannot read `schema_migrations`.
- Every message tells the operator to run `npm run db:migrate` as the owner.
- `db/runtime_grants.template.sql` now grants `SELECT ON schema_migrations` to
  the runtime role. The integration grant test no longer exempts that table.

## 5. Makefile duplicate `usb` target

The first, stale `usb:` recipe was removed. `make -n usb` no longer prints an
"overriding recipe" warning, and a test checks for it.

## Tests added

- `test/edge-credentials-32054.test.js` (9 tests) checks that:
  - no placeholder hash, key or token appears in any config file in the
    repository, and no `.ign` is shipped;
  - lint passes;
  - the Python edge-config unit tests pass;
  - `butane --strict` compiles every role and overlay with throw-away
    credentials (when `butane` is on PATH or `BUTANE` is set);
  - a build with no credentials fails;
  - the polkit rule behaves as designed (it is run under `vm`);
  - the reference tree refuses to build;
  - `usb` is not duplicated.
- `test/schema-ready-32054.test.js` (5 tests, stub database).
- `edge-platform/eduos/tests/test_edge_config.py` (10 tests) covers:
  - validating hashes and keys;
  - rendering, including key lists and `_FILE` sources;
  - the secrets file, including the git-tracked refusal;
  - lint detection.
- Integration (real PostgreSQL), 2 new tests:
  - the API refuses to start with a missing migration, then reports ready
    once the migration is restored;
  - the API refuses to start against a fresh, unmigrated database.

## Results (2026-11-10, EST)

| Suite | Result |
|-------|--------|
| `npm test` (with `BUTANE` set) | 271 / 271 pass |
| `npm run test:integration` (PostgreSQL 16.x) | 26 / 26 pass |
| edge Python tests (enrollment, enrollment token, edge config) | 30 / 30 pass |
| `make check` (lint plus `butane --strict` v0.23.0, 8 roles and 1 overlay) | pass |
| real `make ignition` with a test secrets file | 7 `.ign` files at mode 0600; `build/` cleaned |
| `make ignition` with no credentials | fails, naming the missing variables |

## Not verified

- No Fedora CoreOS machine was booted. Nothing confirmed at runtime that:
  - polkit loads the rule on FCOS;
  - the kiosk can reboot or power off;
  - `eduos-admin` sudo and SSH work.
  The rule logic was run under a polkit stub only.
- The CI workflow was not executed. Its YAML was validated, and the steps it
  runs were run locally.
- Docker Compose was not run.
- There is no GUI or autologin kiosk session in this tree. If you add one
  (e.g. a cage/GDM autologin), test its polkit and seat needs against the rule.

Operator steps: `docs/UPGRADING-32.0.54.md`.

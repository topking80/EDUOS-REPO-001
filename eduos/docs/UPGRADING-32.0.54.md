# Upgrading to 32.0.54

Read `docs/UPGRADING-32.0.53.md` first if you are coming from 32.0.52.

## API / database

1. Deploy the code, then run `npm run db:migrate` with `DATABASE_URL` set to the
   **owner** role. This reapplies the runtime grants, which now include
   `SELECT ON schema_migrations`.
2. Start the API as the runtime role, as before.
   - It now exits at startup when migrations are missing or the grants are
     stale, with a message such as `Refusing to start: ... run npm run
     db:migrate ...`.
   - If you see it, run step 1. Do not grant more access by hand.

## Edge images (edge-platform/eduos)

1. **Generate credentials.**
   - Password hashes: `mkpasswd -m yescrypt` or `openssl passwd -6`.
   - SSH keys: your admins' OpenSSH public keys.
   - Run `make credentials` to list the variables each role needs (10 in
     total).
2. **Supply them outside git.** Either:
   - export them as environment variables (or `<KEY>_FILE=/path`); or
   - put them in a file outside the repository, `chmod 600` it, and pass
     `EDUOS_EDGE_SECRETS=/path/to/file`.
   In CI, add repository secrets with the same names.
3. **Check and build.**
   - Run `make check`. It needs `butane` and no secrets.
   - Then run `make ignition` (and `make iso-<role>` as before).
   - The build stops when anything is missing or a placeholder.
4. **Replace old images.**
   - Ignition files built from 32.0.53 or earlier, and anything taken from
     `platform/edge-runtime-reference`, contain placeholder credentials.
   - Rebuild with 32.0.54 and reprovision.
   - On devices already running, change the passwords, replace
     `authorized_keys`, and remove `student` from `wheel` (`gpasswd -d student
     wheel`).
5. **Student devices.**
   - Administer them as **`eduos-admin`**, not `student`. `student` has no
     sudo and no SSH.
   - `student` can still reboot, power off and suspend from its local
     session, through `/etc/polkit-1/rules.d/50-eduos-student-kiosk.rules`.
6. **Treat `ignition/*.ign` as secrets.** They contain password hashes and are
   git-ignored and created 0600. Delete them with `make clean` after flashing,
   or keep them only in protected storage.
7. **Retire the reference tree.** `platform/edge-runtime-reference` is
   deprecated, and its Makefile refuses every target. Point any scripts that
   used it at `edge-platform/eduos`.

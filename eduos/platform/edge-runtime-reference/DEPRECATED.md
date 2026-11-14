# DEPRECATED: do not build from this directory

`platform/edge-runtime-reference/` used to hold an unmodified copy of the edge
OS bundle uploaded in 32.0.39, kept only for provenance. It was never hardened.
It shipped placeholder password hashes and SSH keys, a placeholder enrollment
token at the wrong path (`/etc/eduos/enrollment-token`), the kiosk `student`
account in `wheel`, Butane files that did not compile, and prebuilt Ignition
files that embedded all of the above.

As of 32.0.54 those files have been **removed**, because they could be flashed
as-is. The one supported edge tree is **`edge-platform/eduos/`**, which has
all the fixes from 32.0.53 and 32.0.54:
- token generated per boot at `/run/eduos/enrollment-token`
- credentials supplied at build time, with lint and `butane --strict` checks
- kiosk account with no administrative rights, plus a separate `eduos-admin`
- installable enrollment intake

The original bundle is still available for audit in the original 32.0.52
release archive and in git history (`git show baseline:platform/edge-runtime-reference/...`).
The `Makefile` here exists only to make every build attempt fail.

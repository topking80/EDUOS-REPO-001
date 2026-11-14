# EduOS school node (32.7.0)

One school's EduOS on a small local box. Attendance, bus check-ins, SafetyOS
roll call, pick-up verification, Christie (local provider) and gradebook reads
keep working when the district uplink is down. Only gate-checked aggregates
(cells under 5 suppressed) and a sealed continuity package for the partner
school leave the box. Full design: `docs/EDEN-32.7.0.md`.

## Install (compose)

1. Build or pull the EduOS image (`docker build --target app -t eduos-app:local .`
   at the repo root; set `EDUOS_IMAGE` to use a registry image).
2. `cp node.env.example node.env && chmod 600 node.env`, fill in every `<…>`.
   The enrollment token comes from the hub: Nodes → Add a school node.
3. Provision the database for ONE school (first start only):
   `docker compose run --rm migrate` then
   `docker compose run --rm -e DATABASE_URL=postgres://eduos_owner:…@db:5432/eduos migrate node src/eden/node-provision.js --school <school uuid>`
   after loading the school's data from the SIS. (`--demo-seed` and
   `--synthetic-students` are refused in production.)
4. `docker compose up -d`, then open the hub's Nodes screen: the node shows as
   online once it has enrolled.

Fedora CoreOS: `edge-platform/eduos/butane/school-node.bu` installs the same
three containers as Quadlet units (`eduos-school-db`, `eduos-school-node`,
`eduos-school-edge`). It passes `make check` (Butane `--strict`).

## Raspberry Pi 5: status

Not tested on real hardware in 32.7.0. This build host has no buildx/QEMU, so
no arm64 image was built. Nothing in the image is architecture-specific
(node:22-alpine and postgres:16-alpine are multi-arch, the npm dependencies
are pure JavaScript), and the memory caps above were chosen for a 4-8 GB board,
but treat Pi support as a plan until a pilot confirms it. Measured in the local
simulation (x86_64): each node used about 35 MB RSS when idle and its database 60-70 MB.

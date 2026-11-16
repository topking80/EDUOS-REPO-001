# EduOS Build System
# See docs/BUILD.md for full documentation

VERSION      ?= 0.2.0
ARCH         ?= x86_64
ISO          ?= boot/eduos-universal-$(VERSION).iso
DEVICE       ?=

BUTANE       ?= butane
PYTHON       ?= python3
COREOS_INSTALLER := coreos-installer
ROLES        := teacher student admin edge district state
# Operator credentials (password hashes, SSH keys) live OUTSIDE git, either as
# environment variables or in this KEY=VALUE file (see docs/BUILD.md).
EDUOS_EDGE_SECRETS ?= secrets/edge-credentials.env
export EDUOS_EDGE_SECRETS
EDGE_CONFIG  := $(PYTHON) scripts/eduos-edge-config.py

# ============================================================
# Ignition Generation
# ============================================================
# Run from edge-platform/eduos. `-d .` makes this directory the files-dir, so
# `local:` paths in butane/*.bu (scripts/..., services/...) resolve here, and
# role configs merge the compiled base (ignition/base.ign), not base.bu.
# butane/*.bu contain credential markers only; they are rendered into build/
# (0600, git-ignored) with the operator's values, and the build stops if any
# value is missing or is a known placeholder. Outputs contain password hashes:
# ignition/*.ign and build/ are git-ignored; `make clean` removes them.

ignition/base.ign: butane/base.bu
	@mkdir -p ignition
	$(BUTANE) --strict --pretty -d . $< -o $@

build/%.bu: butane/%.bu scripts/eduos-edge-config.py FORCE
	@$(EDGE_CONFIG) render $* $@

ignition/%.ign: build/%.bu ignition/base.ign
	@umask 077 && $(BUTANE) --strict --pretty -d . $< -o $@
	@echo "Generated $@"

ignition: $(ROLES:%=ignition/%.ign)

# Lint sources (no committed hashes/keys/placeholders, kiosk account not in
# wheel) and compile every role with throw-away credentials under --strict.
# Needs no secrets; this is what CI runs.
check:
	$(EDGE_CONFIG) check --butane $(BUTANE)

lint:
	$(EDGE_CONFIG) lint

# Show which credentials each role needs.
credentials:
	@$(EDGE_CONFIG) markers

clean:
	rm -rf build ignition/*.ign

FORCE:

# Backwards-compatible short targets (make teacher.ign, ...).
%.ign: ignition/%.ign ;

# ============================================================
# ISO Building (requires base Fedora CoreOS ISO + coreos-installer)
# ============================================================

iso-%: %.ign
	@mkdir -p boot
	@echo "==> Building EduOS ISO for role: $* (v$(VERSION))"
	@if ! command -v $(COREOS_INSTALLER) >/dev/null 2>&1; then \
		echo "Error: coreos-installer not found. Install it or run in COSA container."; \
		exit 1; \
	fi
	$(COREOS_INSTALLER) iso customize \
		--dest-ignition ignition/$*.ign \
		$(BASE_ISO) \
		-o boot/eduos-$*-$(VERSION).iso
	@echo "==> Created: boot/eduos-$*-$(VERSION).iso"

all-isos: teacher.ign student.ign admin.ign edge.ign district.ign state.ign
	@$(MAKE) iso-teacher iso-student iso-admin iso-edge iso-district iso-state VERSION=$(VERSION)

iso-universal: teacher.ign student.ign admin.ign edge.ign
	@mkdir -p boot
	@echo "==> Building universal EduOS ISO with multiple Ignition configs"
	$(COREOS_INSTALLER) iso customize \
		--dest-ignition ignition/teacher.ign \
		--dest-ignition ignition/student.ign \
		--dest-ignition ignition/admin.ign \
		--dest-ignition ignition/edge.ign \
		$(BASE_ISO) \
		-o boot/eduos-universal-$(VERSION).iso || true
	@echo "==> Created: boot/eduos-universal-$(VERSION).iso"

# ============================================================
# Container Images
# ============================================================

containers:
	@mkdir -p containers
	# eduos-update and eduos-bootstrap run on the host (they configure the node), so they have no image.
	podman build -f containers/Containerfile.enrollment -t quay.io/eduos/eduos-enrollment:$(VERSION) .
	podman build -f containers/Containerfile.health -t quay.io/eduos/eduos-health:$(VERSION) .
	podman save -o containers/eduos-enrollment-$(VERSION).tar quay.io/eduos/eduos-enrollment:$(VERSION)
	podman save -o containers/eduos-health-$(VERSION).tar quay.io/eduos/eduos-health:$(VERSION)
	@echo "Container images built and saved in containers/"

push-containers:
	podman push quay.io/eduos/eduos-enrollment:$(VERSION)
	podman push quay.io/eduos/eduos-health:$(VERSION)

# ============================================================
# USB Boot Drive Creation
# ============================================================

# (the usb target is defined once, under "USB + Verification Targets" below)

.PHONY: all-isos iso-universal containers push-containers ignition check lint credentials clean FORCE

# ============================================================
# USB + Verification Targets (Improved)
# ============================================================

usb:
	@if [ -z "$(DEVICE)" ]; then \
		echo "Error: DEVICE required. Example:"; \
		echo "  make usb DEVICE=/dev/sdb"; \
		echo "  make usb ISO=boot/eduos-universal-0.2.0.iso DEVICE=/dev/sdb"; \
		exit 1; \
	fi
	@./boot/make-usb.sh $(ISO) $(DEVICE)

verify-usb:
	@if [ -z "$(DEVICE)" ]; then \
		echo "Error: DEVICE required"; \
		exit 1; \
	fi
	@./boot/verify-usb.sh $(ISO) $(DEVICE)

usb-all:
	@./boot/make-usb-all.sh

flash-url:
	@if [ -z "$(URL)" ] || [ -z "$(DEVICE)" ]; then \
		echo "Error: URL and DEVICE required"; \
		echo "  make flash-url URL=https://... DEVICE=/dev/sdb"; \
		exit 1; \
	fi
	@./boot/flash-url.sh $(URL) $(DEVICE)

.PHONY: usb verify-usb usb-all flash-url

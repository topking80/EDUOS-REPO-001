# District Overlay Example (Nashville Metro Schools)

This directory contains a realistic example of a **district-specific overlay** for EduOS.

## What it includes

- District name and contact information (including ZIP code)
- Customized `update-policy.toml` (maintenance window tuned for the district)
- Customized `health.toml` with FERPA mode and district reporting endpoint
- Branded `/etc/motd`
- Example systemd unit enables

## How to use

1. Copy this directory to `overlays/my-district/`
2. Edit `district-overlay.bu` with your actual information
3. Compile it (`butane --strict -d . overlays/my-district/district-overlay.bu -o ignition/my-district.ign`)
   and merge the compiled Ignition into your role configs. Butane `merge:` takes
   Ignition JSON, and `local:` paths are relative to the files-dir (`-d .`):

```yaml
ignition:
  config:
    merge:
      - local: ignition/my-district.ign
      - local: ignition/base.ign
```

Never put password hashes, SSH keys or tokens in an overlay. They are supplied
at build time (see `docs/BUILD.md`).

## Recommended Customizations

- Replace all placeholder contact info and endpoints
- Adjust maintenance windows to match your district calendar
- Add any required compliance or filtering settings
- Include district SSL certificates or CA bundles if needed

/**
 * SIS-06: an incremental read only when the schedule asks for it, the source
 * supports it, the watermark was taken under the current connector
 * configuration, and the last full sync is recent enough. Otherwise full.
 */
export function decideSyncMode(input, kind, now = Date.now()) {
  if (!input.incremental) return { mode: "full", reason: "incremental_off" };
  if (!kind?.supportsIncremental) return { mode: "full", reason: "source_has_no_change_feed" };
  const wm = input.sync_watermark;
  if (!wm || wm.configVersion !== input.config_version) return { mode: "full", reason: wm ? "connector_changed" : "no_previous_full_sync" };
  const last = input.last_full_sync_at ? new Date(input.last_full_sync_at).getTime() : NaN;
  if (!Number.isFinite(last) || now - last >= input.full_sync_hours * 3600_000) return { mode: "full", reason: "full_sync_due" };
  return { mode: "incremental" };
}

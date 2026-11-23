// DEV-01: what a classroom device can be told to do, per kind. There is no
// screen-viewing capability for student devices (db/108 refuses one too).
import { cleanText } from "./role-app-util.js";

export const DEVICE_CAPS = Object.freeze({
  display: ["show", "blank", "input", "volume", "power"],
  student_device: ["lock", "unlock", "open_link", "focus"],
  equipment: ["power", "volume", "input", "lights"]
});
const optText = (v, max) => v == null || v === "" ? true : cleanText(v, max);
const orNull = v => typeof v === "string" && v.trim() ? v.trim() : null;

export function parseDevice(b) {
  if (!DEVICE_CAPS[b.kind] || !cleanText(b.name, 80) || !optText(b.maker, 80) || !optText(b.model, 80) || !optText(b.serial, 80)) return null;
  if (!Array.isArray(b.capabilities) || !b.capabilities.length || b.capabilities.length > 12) return null;
  const caps = [...new Set(b.capabilities)];
  if (!caps.every(c => DEVICE_CAPS[b.kind].includes(c))) return null;
  return { kind: b.kind, name: b.name.trim(), maker: orNull(b.maker), model: orNull(b.model), serial: orNull(b.serial), capabilities: caps.sort() };
}


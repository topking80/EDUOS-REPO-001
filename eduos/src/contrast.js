// Node entry for the shared contrast module (public/eduos-contrast.js).
import "../public/eduos-contrast.js";
const C = globalThis.EduOSContrast;
export const { HEX, AA_TEXT, AA_LARGE_TEXT, AA_NON_TEXT, INK, WHITE, parseHex, toHex, luminance, ratio, autoText, suggest, check } = C;

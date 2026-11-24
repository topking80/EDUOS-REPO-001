// Builds out/eduos-roku.zip (sideload or upload to the Roku Developer Dashboard).
// Real artwork goes in art/ (see art/README.md). Until it's there, plain
// placeholder images are generated so the channel still packages and runs.
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { ProgramBuilder } from "brighterscript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const art = [
  ["channel-poster_hd.png", 336, 210],
  ["channel-poster_fhd.png", 540, 405],
  ["splash_hd.png", 1280, 720],
  ["splash_fhd.png", 1920, 1080],
];

// A solid navy PNG with an amber band: clearly a placeholder, valid for packaging.
function placeholderPng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const band = y > height * 0.62 && y < height * 0.68;
    const [r, g, b] = band ? [0xfc, 0xa3, 0x11] : [0x14, 0x21, 0x3d];
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) raw.set([r, g, b], row + 1 + x * 3);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const placeholders = join(root, "out", "placeholder-art");
mkdirSync(placeholders, { recursive: true });
const missing = art.filter(([name]) => !existsSync(join(root, "art", name)));
for (const [name, w, h] of missing) writeFileSync(join(placeholders, name), placeholderPng(w, h));
if (missing.length) console.log(`Placeholder art for: ${missing.map(([n]) => n).join(", ")} (add the real files to art/).`);

const builder = new ProgramBuilder();
await builder.run({ project: join(root, "bsconfig.json"), cwd: root, watch: false });
const errors = builder.getDiagnostics().filter(d => d.severity === 1);
if (errors.length) {
  console.error(`${errors.length} error(s); no package written.`);
  process.exit(1);
}
const zip = join(root, "out", "eduos-roku.zip");
if (!existsSync(zip)) { console.error("brighterscript finished but out/eduos-roku.zip is missing."); process.exit(1); }
console.log(`Built ${zip}`);

// MEDIA-01: photos are re-encoded from pixels; metadata and lies are refused or dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { processHistoryImage } from "../src/history-image.js";
import { createClamAvScanner } from "../src/clamav-scanner.js";
import net from "node:net";

const jpegWithGps = () => sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#3a7" } })
  .jpeg().withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "Family", Artist: "Grandma" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "39/1 44/1 21/1" } } }).toBuffer();

test("a photo comes back upright, smaller and without EXIF, GPS or other metadata", async () => {
  const input = await jpegWithGps();
  assert.ok((await sharp(input).metadata()).exif, "the input carries EXIF");
  const out = await processHistoryImage(input, "image/jpeg");
  const m = await sharp(out.buffer).metadata();
  assert.equal(m.format, "jpeg"); assert.equal(m.exif, undefined); assert.equal(m.xmp, undefined); assert.equal(m.orientation, undefined);
  assert.deepEqual([out.width, out.height], [1600, 2400], "rotated by its orientation, then fit inside 2400 px");
});
test("a file that isn't the image type it claims, or isn't an image, is refused", async () => {
  const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).png().toBuffer();
  await assert.rejects(processHistoryImage(png, "image/jpeg"), /image_type_mismatch/);
  await assert.rejects(processHistoryImage(Buffer.from("<svg onload=alert(1)>"), "image/png"), /not_a_valid_image/);
  await assert.rejects(processHistoryImage(png, "image/gif"), /unsupported_media_type/);
});

test("ClamAV: clean, infected and unreachable (fails closed)", async () => {
  const srv = net.createServer(s => { let buf = Buffer.alloc(0);
    s.on("data", d => { buf = Buffer.concat([buf, d]); if (buf.subarray(-4).equals(Buffer.alloc(4))) s.end(buf.includes("EICAR") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0"); }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const scanner = createClamAvScanner({ host: "127.0.0.1", port: srv.address().port });
  assert.deepEqual(await scanner.scan(Buffer.from("hello")), { verdict: "clean" });
  assert.deepEqual(await scanner.scan(Buffer.from("X5O!P%@AP EICAR-STANDARD-ANTIVIRUS-TEST-FILE")), { verdict: "infected", signature: "Eicar-Test-Signature" });
  srv.close();
  const down = createClamAvScanner({ host: "127.0.0.1", port: 1 });
  assert.equal((await down.scan(Buffer.from("x"))).verdict, "error");
  assert.equal(createClamAvScanner({}), null, "not configured");
});

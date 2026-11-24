// MEDIA-01: make an uploaded photo safe to show (sharp / libvips).
//
// The file must really be the image type it claims; it is decoded, turned
// upright, shrunk to at most 2400 px on the long side and re-encoded from the
// pixels. Re-encoding drops everything that isn't the picture: EXIF (camera,
// time, GPS location), XMP, comments, embedded thumbnails and any trailing
// data. Very large or malformed images are refused.
import sharp from "sharp";

export const HISTORY_IMAGE_TYPES = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
export const MAX_SIDE = 2400;
const MAX_PIXELS = 50_000_000;

export async function processHistoryImage(buffer, declaredMime) {
  const want = HISTORY_IMAGE_TYPES[declaredMime];
  if (!want) throw Object.assign(new Error("unsupported_media_type"), { status: 415 });
  let meta;
  try { meta = await sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error" }).metadata(); }
  catch { throw Object.assign(new Error("not_a_valid_image"), { status: 422 }); }
  if (meta.format !== want) throw Object.assign(new Error("image_type_mismatch"), { status: 422 });
  if ((meta.pages || 1) > 1) throw Object.assign(new Error("animated_images_not_accepted"), { status: 422 });
  const img = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate()
    .resize({ width: MAX_SIDE, height: MAX_SIDE, fit: "inside", withoutEnlargement: true });
  const out = want === "jpeg" ? img.jpeg({ quality: 85, mozjpeg: true }) : want === "png" ? img.png({ compressionLevel: 9 }) : img.webp({ quality: 85 });
  const { data, info } = await out.toBuffer({ resolveWithObject: true });
  return { buffer: data, mimeType: declaredMime, width: info.width, height: info.height };
}

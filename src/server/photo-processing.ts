import "server-only";
import sharp from "sharp";
import { crc32 } from "node:zlib";

export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export class PhotoInputError extends Error {}

sharp.cache(false);
sharp.concurrency(1);

// libvips does not expose APNG frames in metadata.pages. Walk actual chunk
// boundaries (not arbitrary byte matches), validating lengths and CRCs first.
// Sharp subsequently validates/decompresses the still-image payload.
function validateStillPng(input: Buffer, unsupported: string) {
  const malformed = () => new PhotoInputError("Choose a complete, valid PNG image.");
  let offset = 8;
  while (offset + 12 <= input.length) {
    const length = input.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > input.length) throw malformed();
    const type = input.toString("latin1", offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || (offset === 8 && (type !== "IHDR" || length !== 13))) throw malformed();
    if (crc32(input.subarray(offset + 4, end - 4)) !== input.readUInt32BE(end - 4)) throw malformed();
    if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new PhotoInputError(unsupported);
    if (type === "IEND") {
      if (length !== 0 || end !== input.length) throw malformed();
      return;
    }
    offset = end;
  }
  throw malformed();
}

export async function processPhoto(input: Buffer) {
  try {
    if (input.length > MAX_PHOTO_BYTES) throw new PhotoInputError("Choose a photo under 20 MiB.");
    const unsupported = "Choose a single JPEG, PNG, or WebP image. For HEIC/HEIF, export a JPEG or use your camera’s Most Compatible setting.";
    // Reject other containers before invoking decoders (particularly SVG/PDF).
    const jpeg = input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
    const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp = input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP";
    if (input.length < 12 || (!jpeg && !png && !webp)) throw new PhotoInputError(unsupported);
    if (png) validateStillPng(input, unsupported);
    const options = { limitInputPixels: 60_000_000, failOn: "warning" as const };
    const metadata = await sharp(input, options).metadata();
    if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new PhotoInputError(unsupported);
    if (!metadata.width || !metadata.height || Math.max(metadata.width, metadata.height) > 16_000) throw new PhotoInputError("Choose a photo no larger than 60 megapixels or 16,000 pixels on either side.");
    // Sharp strips metadata by default. Rotate before resizing, convert to sRGB,
    // and flatten transparency on white; never retain EXIF/GPS/device/timestamps.
    const photo = await sharp(input, options).rotate().flatten({ background: "#ffffff" }).toColourspace("srgb")
      .resize({ width: 3200, height: 3200, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 94, chromaSubsampling: "4:4:4" }).timeout({ seconds: 8 }).toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(photo.data).resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 }).timeout({ seconds: 8 }).toBuffer();
    return { photo: photo.data, thumbnail, width: photo.info.width, height: photo.info.height };
  } catch (error) {
    if (error instanceof PhotoInputError) throw error;
    throw new PhotoInputError("This image could not be safely processed. Choose a complete JPEG, PNG, or WebP under 20 MiB and 60 megapixels; export HEIC/HEIF as JPEG first.");
  }
}

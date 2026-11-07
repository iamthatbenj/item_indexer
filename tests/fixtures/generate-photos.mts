import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";

// Synthetic fixtures only: no family records, external photos, or real metadata.
const directory = new URL("./photos/", import.meta.url);
await mkdir(directory, { recursive: true });
const receipt = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="6000" height="4000">
<rect width="6000" height="4000" fill="#eee6d0"/><rect x="900" y="500" width="4200" height="3000" fill="white"/>
<text x="1150" y="850" font-size="140" font-family="sans-serif">SYNTHETIC FAMILY BELONGING</text>
<text x="1150" y="1150" font-size="90" font-family="serif">Maker’s mark: TEST 1874 / No. 42</text>
<text x="1150" y="1400" font-size="48" font-family="monospace">Receipt: bowl, hand-painted, GBP 12.50 — 14 June 1972</text>
${Array.from({ length: 40 }, (_, i) => `<path d="M1150 ${1700 + i * 20} H4800" stroke="${i % 2 ? "#666" : "#222"}" stroke-width="${i % 4 + 1}"/>`).join("")}
<rect x="1200" y="3000" width="1000" height="200" fill="#bd342c"/><rect x="2400" y="3000" width="1000" height="200" fill="#35774e"/><rect x="3600" y="3000" width="1000" height="200" fill="#385fa3"/></svg>`);
await sharp(receipt).jpeg({ quality: 98, chromaSubsampling: "4:4:4" }).toFile(new URL("detail-6000.jpg", directory).pathname);
const small = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#2b9a4d"/><rect width="100" height="100" fill="#e62d22"/></svg>');
await sharp(small).png().toFile(new URL("small.png", directory).pathname);
await sharp(small).webp({ quality: 98 }).toFile(new URL("small.webp", directory).pathname);
await sharp(small).withMetadata({ orientation: 6 }).withExifMerge({
  IFD0: { Make: "Synthetic fixture camera", Model: "NOT A REAL DEVICE", DateTime: "2001:02:03 04:05:06" },
  IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "0/1 7/1 0/1" },
}).jpeg({ quality: 98, chromaSubsampling: "4:4:4" }).toFile(new URL("rotated-gps.jpg", directory).pathname);
await writeFile(new URL("malformed.jpg", directory), "This is not a photo, even though its filename ends in .jpg.");
await writeFile(new URL("unsupported.svg", directory), small);

// Genuine two-frame APNG: red/blue 1x1 frames, with valid chunk CRCs.
// Sharp reports this as a PNG without metadata.pages, unlike animated WebP.
function chunk(type: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, "ascii"); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
function frame(sequence: number) {
  const control = Buffer.alloc(26);
  control.writeUInt32BE(sequence); control.writeUInt32BE(1, 4); control.writeUInt32BE(1, 8);
  control.writeUInt16BE(1, 20); control.writeUInt16BE(10, 22);
  return chunk("fcTL", control);
}
const second = Buffer.alloc(4); second.writeUInt32BE(2);
const stillPng = await sharp(small).png().toBuffer();
await writeFile(new URL("static-animation-text.png", directory), Buffer.concat([
  stillPng.subarray(0, 33), chunk("tEXt", Buffer.from("Comment\0acTL fcTL fdAT are harmless text here")), stillPng.subarray(33),
]));
await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } })
  .webp({ delay: [100, 100], loop: 0 }).toFile(new URL("animated.webp", directory).pathname);
await writeFile(new URL("animated.png", directory), Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("acTL", animation),
  frame(0), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
  frame(1), chunk("fdAT", Buffer.concat([second, deflateSync(Buffer.from([0, 0, 0, 255, 255]))])), chunk("IEND", Buffer.alloc(0)),
]));

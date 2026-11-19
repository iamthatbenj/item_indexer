import "server-only";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { ZipFile } from "yazl";
import sharp from "sharp";
import { readRetainedPDFImage } from "./object-storage";
import { ARCHIVE_LIMIT, ArchiveError, type ArchiveSnapshot, type ArchiveFile } from "./archive-snapshot";

// Keep at most one bounded retained file in flight; write the ZIP to a private
// temporary file rather than buffering a collection of JPEGs in process memory.
// Caller must clean up the returned directory after upload, even on uncertainty.
export async function buildArchiveZIP(snapshot: ArchiveSnapshot, parentSignal: AbortSignal, progress: (files: number) => Promise<void>) {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([parentSignal, cancelled.signal]);
  let active: Readable | undefined;
  const directory = await mkdtemp(join(tmpdir(), "family-archive-"));
  const path = join(directory, "archive.zip");
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const digest = createHash("sha256"); let bytes = 0;
  const measure = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    bytes += chunk.length;
    if (bytes > ARCHIVE_LIMIT) return callback(new ArchiveError("Archive exceeds the 256 MiB pilot ZIP limit. No partial archive is available.", 422));
    digest.update(chunk); callback(null, chunk);
  } });
  zip.on("error", (error: Error) => output.destroy(error));
  const writing = pipeline(output, measure, createWriteStream(path, { mode: 0o600, flags: "wx" }), { signal });
  void writing.catch((error: Error) => { cancelled.abort(error); active?.destroy(error); });
  const files: ArchiveFile[] = [];
  async function append(name: string, buffer: Buffer, compress = false) {
    signal.throwIfAborted();
    const stream = Readable.from([buffer]); active = stream;
    const consumed = finished(stream, { signal, cleanup: true });
    zip.addReadStream(stream, name, { size: buffer.length, compress, mtime: new Date(snapshot.data.snapshot.captured_at), mode: 0o100600 });
    try { await consumed; }
    finally { stream.destroy(); active = undefined; }
    files.push({ path: name, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") });
    await progress(files.length);
  }
  try {
    const descriptors = new Map(snapshot.data.photos.flatMap(photo => [photo.retained_file, photo.thumbnail_file].filter((file): file is ArchiveFile => file !== null)).map(file => [file.path, file]));
    for (const file of snapshot.files) {
      signal.throwIfAborted();
      const body = await readRetainedPDFImage(file.key, signal, file.maximum);
      const sha256 = createHash("sha256").update(body).digest("hex");
      if ((file.bytes !== null && file.bytes !== body.length) || (file.sha256 !== null && file.sha256 !== sha256)) throw new ArchiveError("A retained photo does not match its saved checksum. Contact the operator; no partial archive is available.", 409);
      if (body[0] !== 0xff || body[1] !== 0xd8) throw new ArchiveError("A retained JPEG is unreadable. Contact the operator; no partial archive is available.", 409);
      // Thumbnails have no retention-time checksum. Fully decode their pixels,
      // not just their headers, before hashing and archiving the unchanged bytes.
      if (file.sha256 === null) {
        try {
          const image = sharp(body, { failOn: "warning", limitInputPixels: 480 * 480 });
          const metadata = await image.metadata();
          if (metadata.format !== "jpeg" || !metadata.width || !metadata.height || metadata.width > 480 || metadata.height > 480) throw new Error("Invalid thumbnail dimensions or format.");
          await image.raw().toBuffer();
        } catch {
          throw new ArchiveError("A retained thumbnail is unreadable. Contact the operator; no partial archive is available.", 409);
        }
        signal.throwIfAborted();
      }
      const descriptor = descriptors.get(file.path);
      if (!descriptor) throw new Error("Missing archive file relationship.");
      descriptor.bytes = body.length; descriptor.sha256 = sha256;
      await append(file.path, body);
    }
    const data = Buffer.from(JSON.stringify(snapshot.data, null, 2) + "\n");
    if (data.length > 8 * 1024 * 1024) throw new ArchiveError("Structured archive data exceeds the 8 MiB pilot limit. Contact the operator.", 422);
    await append("data.json", data, true);
    for (const name of ["FORMAT.md", "verify.py"]) await append(name, await readFile(join(process.cwd(), "assets/portable-archive", name)), true);
    const manifest = Buffer.from(JSON.stringify({ format: snapshot.data.format, version: snapshot.data.version, snapshot: snapshot.data.snapshot, files }, null, 2) + "\n");
    // Manifest is deliberately not self-checksummed; it lists every OTHER entry.
    zip.addBuffer(manifest, "manifest.json", { compress: true, mtime: new Date(snapshot.data.snapshot.captured_at), mode: 0o100600 });
    zip.end();
    await writing;
    return { path, directory, bytes, sha256: digest.digest("hex"), fileCount: files.length };
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error("Archive generation failed."));
    await writing.catch(() => {});
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

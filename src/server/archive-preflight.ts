import "server-only";
import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { openPromise, type Entry, type ZipFile } from "yauzl";
import { visit } from "jsonc-parser";
import sharp from "sharp";
import { ARCHIVE_VERSION, validateArchiveRelationships, type ArchiveData } from "./archive-snapshot";
import type { ArchivePreview } from "@/archive-preview";

const MiB = 1024 * 1024;
const FORMAT = "family-belongings";
const hex = /^[0-9a-f]{64}$/;
const attachment = /^attachments\/[0-9]{6}\/(retained|thumbnail)\.jpg$/;
const caps = new Map([["manifest.json", MiB / 2], ["data.json", 8 * MiB], ["FORMAT.md", 64 * 1024], ["verify.py", 64 * 1024]]);
const maxEntry = (name: string) => caps.get(name) ?? (attachment.test(name) ? name.endsWith("/thumbnail.jpg") ? MiB / 2 : 20 * MiB : 0);
export class RejectedArchive extends Error {}
function check(condition: unknown, message = "The archive structure or record fields are invalid."): asserts condition { if (!condition) throw new RejectedArchive(message); }
type Fields = Record<string, unknown>;
function exact(value: unknown, fields: string): Fields {
  check(value && typeof value === "object" && !Array.isArray(value));
  const names = fields.split(" "), row = value as Fields;
  check(Object.keys(row).length === names.length && names.every(key => Object.hasOwn(row, key)));
  return row;
}
const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown, max: number, required = false) => typeof v === "string" && v.length <= max && (!required || !!v.trim()) && !v.includes("\0");
const checksum = (v: unknown) => typeof v === "string" && hex.test(v);

function json(bytes: Buffer): unknown {
  try {
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const keys: (Set<string> | null)[] = [];
    let tokens = 0;
    const count = () => check(++tokens <= 400_000, "Archive JSON exceeds the structural work limit.");
    const push = (set: Set<string> | null) => { count(); check(keys.length < 16, "Archive JSON is nested too deeply."); keys.push(set); };
    visit(raw, {
      onObjectBegin: () => push(new Set()), onArrayBegin: () => push(null),
      onObjectEnd: () => { keys.pop(); }, onArrayEnd: () => { keys.pop(); },
      onObjectProperty: name => { count(); const set = keys.at(-1); check(set && !set.has(name), "Archive JSON contains duplicate keys."); set.add(name); },
      onLiteralValue: count,
      onError: () => { throw new RejectedArchive("Archive JSON is malformed."); },
    }, { disallowComments: true, allowTrailingComma: false });
    return JSON.parse(raw);
  } catch (error) { if (error instanceof RejectedArchive) throw error; throw new RejectedArchive("Archive JSON is malformed."); }
}
const schema = {
  contributors: "id email",
  items: "id name description status version created_by created_at last_edited_by updated_at current_keeper_id current_keeper_version",
  people: "id name note version created_by created_at last_edited_by updated_at",
  stories: "id item_id storyteller_id storyteller_version text version recorded_by recorded_at last_edited_by updated_at",
  photos: "id item_id width height photo_bytes sha256 created_at created_by removed_at removed_by retained_file thumbnail_file",
  item_revisions: "id item_id version name description status edited_by edited_at current_keeper_id current_keeper_version",
  person_revisions: "id person_id version name note edited_by edited_at",
  story_revisions: "id story_id version text storyteller_id storyteller_version recorded_by recorded_at edited_by edited_at",
} as const;
function snapshot(input: unknown) {
  const s = exact(input, "id captured_at source_collection_id generated_by");
  check(id(s.id) && id(s.source_collection_id) && id(s.generated_by) && integer(s.captured_at));
  return s;
}
function version(input: unknown) {
  const o = input as Fields | null;
  check(o?.format === FORMAT && o.version === ARCHIVE_VERSION, "Unsupported archive format or version. Choose a Family Belongings format 1.0 archive.");
}
function fields(name: string, row: Fields) {
  for (const [key, v] of Object.entries(row)) {
    if (v === null && (["current_keeper_id", "current_keeper_version", "removed_by", "removed_at"].includes(key) || name === "items" && ["last_edited_by", "updated_at"].includes(key))) continue;
    if (key === "id" || key.endsWith("_id") || key.endsWith("_by")) check(id(v));
    else if (key.endsWith("_at")) check(integer(v));
    else if (key.endsWith("version")) check(integer(v, 1, 10001));
    else if (key === "email") check(text(v, 254, true) && /^[^\s@]+@[^\s@]+$/.test(String(v)));
    else if (key === "name") check(text(v, 200, name.startsWith("person") || name === "people"));
    else if (key === "description") check(text(v, 1200));
    else if (key === "note") check(text(v, 400));
    else if (key === "text") check(text(v, 10000, true));
    else if (key === "status") check(v === (row.name && row.description ? "complete" : "draft"));
    else if (key === "sha256") check(checksum(v));
    else if (key === "photo_bytes") check(integer(v, 1, 20 * MiB));
    else if (key === "width" || key === "height") check(integer(v, 1, 3200));
  }
}

function graph(input: unknown, expectedSnapshot: Fields, files: Map<string, Fields>) {
  version(input);
  const data = exact(input, `format version snapshot collection ${Object.keys(schema).join(" ")}`);
  const stored = snapshot(data.snapshot);
  check(Object.keys(stored).every(key => stored[key] === expectedSnapshot[key]), "Archive snapshot metadata disagrees.");
  const collection = exact(data.collection, "id name created_at");
  check(collection.id === stored.source_collection_id && text(collection.name, 120, true) && integer(collection.created_at));
  let records = 0;
  for (const [group, keys] of Object.entries(schema)) {
    const rows = data[group];
    check(Array.isArray(rows));
    if (group !== "contributors") records += rows.length;
    check(records <= 10000 && rows.length <= ({ contributors: 200, items: 200, people: 2000, stories: 1000 }[group] ?? 10000), "Archive record limits exceeded.");
    for (const row of rows) fields(group, exact(row, keys));
  }
  // Exact shape and scalar types have been checked before sharing the export graph rules.
  const typed = data as unknown as ArchiveData;
  try { validateArchiveRelationships(typed); } catch { throw new RejectedArchive("Archive record relationships or edit history are invalid."); }
  const images = new Map<string, { width?: number; height?: number }>();
  let active = 0, mainBytes = 0;
  for (const p of typed.photos) {
    if (p.removed_at !== null) { check(p.retained_file === null && p.thumbnail_file === null, "A removed photo cannot have a retained file."); continue; }
    active++;
    mainBytes += Number(p.photo_bytes);
    for (const [kind, value] of [["retained", p.retained_file], ["thumbnail", p.thumbnail_file]] as const) {
      const f = exact(value, "path bytes sha256");
      const path = f.path;
      check(typeof path === "string" && attachment.test(path) && path.endsWith(`/${kind}.jpg`));
      const saved = files.get(path);
      check(saved && saved.bytes === f.bytes && saved.sha256 === f.sha256 && !images.has(path), "Archive attachment relationships do not match the manifest.");
      if (kind === "retained") check(p.photo_bytes === f.bytes && p.sha256 === f.sha256, "Retained photo metadata disagrees with the manifest.");
      images.set(path, kind === "retained" ? { width: Number(p.width), height: Number(p.height) } : {});
    }
  }
  check(active <= 500 && mainBytes <= 240 * MiB, "Archive photo limits exceeded.");
  check(files.size === images.size + 3 && ["data.json", "FORMAT.md", "verify.py"].every(name => files.has(name)), "The archive contains missing or unrelated files.");
  const preview: ArchivePreview = { version: ARCHIVE_VERSION, collection: String(collection.name), items: typed.items.length, people: typed.people.length, stories: typed.stories.length, photos: active, removedPhotos: typed.photos.length - active, revisions: typed.item_revisions.length + typed.person_revisions.length + typed.story_revisions.length, files: images.size };
  return { images, preview };
}

async function member(zip: ZipFile, entry: Entry, signal: AbortSignal, hash?: unknown) {
  signal.throwIfAborted();
  const stream = await zip.openReadStreamPromise(entry);
  const stop = () => stream.destroy(new Error("Validation stopped"));
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    const output = Buffer.allocUnsafe(entry.uncompressedSize);
    const digest = createHash("sha256");
    let bytes = 0;
    let crc = 0;
    for await (const chunk of stream) {
      const next = bytes + chunk.length;
      check(next <= output.length, "An archive file exceeds its declared size.");
      chunk.copy(output, bytes); bytes = next;
      if (hash !== undefined) digest.update(chunk);
      crc = crc32(chunk, crc);
      signal.throwIfAborted();
    }
    check(bytes === output.length && crc === entry.crc32 && (hash === undefined || digest.digest("hex") === hash), "An archive file is incomplete or its checksum does not match.");
    return output;
  } finally { signal.removeEventListener("abort", stop); stream.destroy(); }
}

export async function validateStagedArchive(path: string, signal: AbortSignal): Promise<ArchivePreview> {
  let zip: ZipFile | undefined;
  try {
    zip = await openPromise(path, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
    check(zip.entryCount >= 4 && zip.entryCount <= 1004, "Archive file count is outside supported limits.");
    const entries = new Map<string, Entry>();
    let expanded = 0, compressed = 0;
    const ranges: { start: number; end: number }[] = [];
    for await (const e of zip.eachEntry()) {
      signal.throwIfAborted();
      check(!entries.has(e.fileName) && maxEntry(e.fileName) > 0, "Unsafe, duplicate or unsupported archive path.");
      const mode = (e.externalFileAttributes >>> 16) & 0o170000;
      check((mode === 0 || mode === 0o100000) && !(e.generalPurposeBitFlag & 1) && [0, 8].includes(e.compressionMethod), "Unsupported archive entry type.");
      check(integer(e.uncompressedSize, 1, maxEntry(e.fileName)) && integer(e.compressedSize, 1, 256 * MiB), "Archive file size limit exceeded.");
      expanded += e.uncompressedSize; compressed += e.compressedSize;
      check(expanded <= 272 * MiB && compressed <= 256 * MiB, "Archive unpacking limits exceeded.");
      const local = await zip.readLocalFileHeaderPromise(e);
      check(local.fileName.equals(Buffer.from(e.fileName)) && local.generalPurposeBitFlag === e.generalPurposeBitFlag && local.compressionMethod === e.compressionMethod, "Archive local and directory headers disagree.");
      ranges.push({ start: e.relativeOffsetOfLocalHeader, end: local.fileDataStart + e.compressedSize });
      entries.set(e.fileName, e);
    }
    ranges.sort((a, b) => a.start - b.start);
    check(ranges.every((range, i) => range.end <= (ranges[i + 1]?.start ?? zip!.fileSize)), "Archive entry data overlaps or is incomplete.");
    const m = entries.get("manifest.json");
    check(m, "Required archive manifest is missing.");
    const value = json(await member(zip, m, signal)); version(value);
    const manifest = exact(value, "format version snapshot files");
    const source = snapshot(manifest.snapshot);
    check(Array.isArray(manifest.files) && manifest.files.length === entries.size - 1, "The archive has missing or extra files.");
    const files = new Map<string, Fields>();
    for (const value of manifest.files) {
      const row = exact(value, "path bytes sha256"); const name = row.path;
      check(typeof name === "string" && name !== "manifest.json" && !files.has(name) && entries.get(name)?.uncompressedSize === row.bytes && checksum(row.sha256), "The archive manifest has missing, duplicate or invalid files.");
      files.set(name, row);
    }
    const d = entries.get("data.json"); check(d && files.has("data.json"));
    const { preview, images } = graph(json(await member(zip, d, signal, files.get("data.json")!.sha256)), source, files);
    for (const [name, file] of files) {
      if (name === "data.json") continue;
      const bytes = await member(zip, entries.get(name)!, signal, file.sha256);
      const image = images.get(name);
      if (!image) continue; // Never execute or render embedded documentation/scripts.
      const bound = image.width === undefined ? 480 : 3200;
      try {
        const input = sharp(bytes, { failOn: "warning", limitInputPixels: bound ** 2, sequentialRead: true });
        const meta = await input.metadata();
        check(meta.format === "jpeg" && meta.width && meta.height && meta.width <= bound && meta.height <= bound && (image.width === undefined || image.width === meta.width && image.height === meta.height));
        signal.throwIfAborted();
        await input.timeout({ seconds: 2 }).raw().toBuffer();
      } catch { signal.throwIfAborted(); throw new RejectedArchive("An attached photo is not a complete, supported JPEG or its dimensions are incorrect."); }
    }
    signal.throwIfAborted();
    return preview;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof RejectedArchive) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && !code.startsWith("Z_")) throw error;
    throw new RejectedArchive("The ZIP is malformed, incomplete, or uses an unsupported entry format.");
  } finally { zip?.close(); }
}

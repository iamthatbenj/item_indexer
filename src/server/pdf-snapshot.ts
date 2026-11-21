import "server-only";
import type { Transaction } from "@libsql/client";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { PDFExportError, type PDFFormat } from "./pdf-export-types";
import { readInventoryThumbnail, readRetainedPDFImage } from "./object-storage";

export type CatalogueStory = { id: string; text: string; storyteller: string; storytellerName: string; storytellerId: string; storytellerVersion: number; recorder: string; editor: string; recordedAt: number; updatedAt: number; version: number };
export type PDFSnapshotItem = { id: string; name: string; description: string; thumbnailKey: string; keeper?: string; photos?: { key: string; bytes: number; sha256: string }[]; stories?: CatalogueStory[] };
export type PDFSnapshot = { collectionName: string; capturedAt: number; items: PDFSnapshotItem[] };
export type PreparedPDFItem = PDFSnapshotItem & { thumbnail: Buffer; images: Buffer[] };
const label = (name: unknown, note: unknown) => [String(name ?? "").replace(/\s+/gu, " ").trim(), String(note ?? "").replace(/\s+/gu, " ").trim()].filter(Boolean).join(" — ");

export async function capturePDFSnapshot(tx: Transaction, format: PDFFormat, collectionId: string, collectionName: string, capturedAt: number): Promise<PDFSnapshot> {
  const rows = (await tx.execute({ sql: `SELECT i.id,i.name,i.description,i.current_keeper_id,k.name AS keeper_name,k.note AS keeper_note,
    (SELECT p.thumbnail_key FROM item_photos p WHERE p.item_id=i.id AND p.removed_at IS NULL ORDER BY p.created_at,p.id LIMIT 1) AS thumbnail_key
    FROM items i LEFT JOIN people k ON k.id=i.current_keeper_id AND k.collection_id=i.collection_id
    WHERE i.collection_id=? ORDER BY i.created_at,i.id LIMIT 201`, args: [collectionId] })).rows;
  if (rows.length > 200) throw new PDFExportError("The pilot PDF supports up to 200 current items. No partial PDF was created. Contact the operator for larger-collection support.", 422);
  if (rows.some(row => !row.thumbnail_key)) throw new PDFExportError("A saved item lacks its required retained photo. Repair that record before generating a complete PDF.", 409);
  const photosByItem = new Map<string, { key: string; bytes: number; sha256: string }[]>();
  const storiesByItem = new Map<string, CatalogueStory[]>();
  if (format === "catalogue") {
    // Bulk reads keep the atomic snapshot short on hosted libSQL: avoid two
    // network round-trips per item while holding the collection snapshot.
    const photos = (await tx.execute({ sql: `SELECT p.item_id,p.photo_key,p.photo_bytes,p.sha256 FROM item_photos p JOIN items i ON i.id=p.item_id
      WHERE i.collection_id=? AND p.removed_at IS NULL ORDER BY i.created_at,i.id,p.created_at,p.id LIMIT 201`, args: [collectionId] })).rows;
    if (photos.length > 200) throw new PDFExportError("The pilot catalogue supports up to 200 retained photos. No photos were silently omitted. Contact the operator for larger-catalogue support.", 422);
    for (const photo of photos) {
      const id = String(photo.item_id); const group = photosByItem.get(id) ?? [];
      group.push({ key: String(photo.photo_key), bytes: Number(photo.photo_bytes), sha256: String(photo.sha256) }); photosByItem.set(id, group);
    }
    const stories = (await tx.execute({ sql: `SELECT s.*,p.name AS storyteller_name,p.note AS storyteller_note,COALESCE(r.historical_email,r.email) AS recorder,COALESCE(e.historical_email,e.email) AS editor
      FROM stories s JOIN items i ON i.id=s.item_id LEFT JOIN people p ON p.id=s.storyteller_id AND p.collection_id=i.collection_id
      JOIN accounts r ON r.id=s.recorded_by JOIN accounts e ON e.id=s.last_edited_by
      WHERE i.collection_id=? ORDER BY i.created_at,i.id,s.recorded_at,s.id LIMIT 1001`, args: [collectionId] })).rows;
    if (stories.length > 1000) throw new PDFExportError("The pilot catalogue supports up to 1000 independent stories. No partial catalogue was created.", 422);
    if (stories.some(story => !story.storyteller_name)) throw new PDFExportError("Saved storyteller attribution is unavailable. Repair the record before generating a catalogue.", 409);
    for (const story of stories) {
      const id = String(story.item_id); const group = storiesByItem.get(id) ?? [];
      group.push({ id: String(story.id), text: String(story.text), storyteller: label(story.storyteller_name, story.storyteller_note), storytellerName: String(story.storyteller_name).replace(/\s+/gu, " ").trim(), storytellerId: String(story.storyteller_id), storytellerVersion: Number(story.storyteller_version), recorder: String(story.recorder), editor: String(story.editor), recordedAt: Number(story.recorded_at), updatedAt: Number(story.updated_at), version: Number(story.version) });
      storiesByItem.set(id, group);
    }
  }
  const items = rows.map(row => {
    const item: PDFSnapshotItem = { id: String(row.id), name: String(row.name), description: String(row.description), thumbnailKey: String(row.thumbnail_key) };
    if (format === "catalogue") {
      if (row.current_keeper_id && !row.keeper_name) throw new PDFExportError("A current keeper reference is unavailable. Repair the record before generating a catalogue.", 409);
      item.keeper = row.keeper_name ? label(row.keeper_name, row.keeper_note) : "";
      item.photos = photosByItem.get(item.id) ?? [];
      item.stories = storiesByItem.get(item.id) ?? [];
    }
    return item;
  });
  return { collectionName, capturedAt, items };
}

export async function preparePDFItem(item: PDFSnapshotItem, format: PDFFormat, signal: AbortSignal): Promise<PreparedPDFItem> {
  const images: Buffer[] = [];
  const keys = format === "inventory" ? [item.thumbnailKey] : item.photos!.map(photo => photo.key);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    signal.throwIfAborted();
    const bytes = format === "inventory" ? await readInventoryThumbnail(key, signal) : await readRetainedPDFImage(key, signal);
    signal.throwIfAborted();
    if (format === "catalogue") {
      const expected = item.photos![index];
      if (bytes.length !== expected.bytes || createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
        throw new Error("A retained photo does not match its saved checksum. No complete PDF was generated. Contact the operator.");
      }
    }
    const edge = format === "inventory" ? 160 : 1400;
    images.push(await sharp(bytes, { limitInputPixels: format === "inventory" ? 480 * 480 : 3200 * 3200, failOn: "warning" })
      .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true }).jpeg({ quality: format === "inventory" ? 82 : 85 }).toBuffer());
    signal.throwIfAborted();
  }
  return { ...item, thumbnail: images[0], images };
}

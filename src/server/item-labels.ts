import "server-only";
import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { database } from "./database";
import { ITEM_LABEL_LIMIT, itemLabelKinds, type ItemLabelChoices, type ItemLabelInput, type ItemLabelKind } from "@/shared/item-labels";

export class ItemLabelError extends Error {}

export async function listItemLabels(accountId: string, collectionId: string): Promise<ItemLabelChoices> {
  const labels: ItemLabelChoices = { category: [], location: [] };
  const result = await database().execute({
    sql: `SELECT * FROM (SELECT 'category' AS kind, l.id, l.name FROM item_category_labels l JOIN memberships m USING(collection_id) WHERE l.collection_id=? AND m.account_id=? AND l.merged_into_id IS NULL
          UNION ALL SELECT 'location', l.id, l.name FROM item_location_labels l JOIN memberships m USING(collection_id) WHERE l.collection_id=? AND m.account_id=? AND l.merged_into_id IS NULL)
          ORDER BY name COLLATE NOCASE, id`,
    args: [collectionId, accountId, collectionId, accountId],
  });
  for (const row of result.rows) labels[row.kind as ItemLabelKind].push({ id: String(row.id), name: String(row.name) });
  return labels;
}

// Called inside an authorized, version-checked item edit. Creation and assignment
// share the same transaction, so failed edits cannot leave behind new labels.
export async function resolveItemLabels(tx: Transaction, collectionId: string, input: ItemLabelInput, current: Record<ItemLabelKind, string | null>) {
  const result = { ...current };
  for (const kind of itemLabelKinds) {
    const choice = input[kind];
    if (!choice) continue;
    const table = `item_${kind}_labels`;
    const name = choice.name?.trim().normalize("NFC");
    if (name && (name.length > ITEM_LABEL_LIMIT || /[\x00-\x1f\x7f]/u.test(name))) throw new ItemLabelError(`Use a ${kind} label of at most ${ITEM_LABEL_LIMIT} characters without control characters.`);
    if (name && choice.id) throw new ItemLabelError(`Choose an existing ${kind} or enter a new one, not both.`);
    if (name) {
      const key = name.toLowerCase().normalize("NFC");
      await tx.execute({ sql: `INSERT INTO ${table}(id,collection_id,name,name_key) VALUES(?,?,?,?) ON CONFLICT(collection_id,name_key) DO NOTHING`, args: [randomUUID(), collectionId, name, key] });
      const saved = await tx.execute({ sql: `SELECT id FROM ${table} WHERE collection_id=? AND name_key=? AND merged_into_id IS NULL`, args: [collectionId, key] });
      if (!saved.rows.length) throw new ItemLabelError(`That ${kind} was merged. Refresh label choices and select an active label.`);
      result[kind] = String(saved.rows[0].id);
    } else if (choice.id) {
      const found = await tx.execute({ sql: `SELECT id FROM ${table} WHERE id=? AND collection_id=? AND merged_into_id IS NULL`, args: [choice.id, collectionId] });
      if (!found.rows.length) throw new ItemLabelError(`Choose a ${kind} from this family collection.`);
      result[kind] = choice.id;
    } else result[kind] = null;
  }
  return result;
}

import "server-only";
import { createHash } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { database, writeTransaction } from "./database";
import { ITEM_LABEL_LIMIT, type ItemLabelKind } from "@/shared/item-labels";

export class LabelManagementError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export type LabelOperation = { kind: ItemLabelKind; source: string } & ({ action: "rename"; name: string } | { action: "merge"; target: string });

async function inspect(tx: Transaction, account: string, collection: string, operation: LabelOperation) {
  const { kind, source } = operation;
  const table = `item_${kind}_labels`;
  const column = `${kind}_id`;
  const member = await tx.execute({ sql: "SELECT 1 FROM memberships WHERE collection_id=? AND account_id=?", args: [collection, account] });
  const unavailable = () => new LabelManagementError("This label or family collection is unavailable.", 404);
  if (!member.rows.length) throw unavailable();
  const find = async (id: string) => (await tx.execute({ sql: `SELECT name,name_key,merged_into_id FROM ${table} WHERE collection_id=? AND id=?`, args: [collection, id] })).rows[0];
  const row = await find(source);
  if (!row) throw unavailable();
  let destination: string;
  let nameKey = "";
  let done = false;
  if (operation.action === "merge") {
    if (source === operation.target) throw new LabelManagementError("Choose two different labels of the same kind.");
    const target = await find(operation.target);
    if (!target) throw unavailable();
    if (target.merged_into_id || row.merged_into_id && row.merged_into_id !== operation.target) throw new LabelManagementError("A label has already been merged. Reload the active labels before continuing.", 409);
    done = row.merged_into_id === operation.target;
    destination = String(target.name);
  } else {
    if (row.merged_into_id) throw new LabelManagementError("This label has been merged and cannot be renamed.", 409);
    destination = operation.name.trim().normalize("NFC");
    if (!destination || destination.length > ITEM_LABEL_LIMIT || /[\x00-\x1f\x7f]/u.test(destination)) throw new LabelManagementError(`Use a label of 1–${ITEM_LABEL_LIMIT} characters without control characters.`);
    nameKey = destination.toLowerCase().normalize("NFC");
    const existing = await tx.execute({ sql: `SELECT 1 FROM ${table} WHERE collection_id=? AND name_key=? AND id<>?`, args: [collection, nameKey, source] });
    if (existing.rows.length) throw new LabelManagementError("That name is already used or reserved by a merged label. Choose another name or merge active labels.", 409);
    done = row.name === destination;
  }
  const items = (await tx.execute({ sql: `SELECT id FROM items WHERE collection_id=? AND ${column}=? ORDER BY id`, args: [collection, source] })).rows;
  const token = createHash("sha256").update(JSON.stringify([account, collection, kind, source, operation.action, operation.action === "merge" ? operation.target : null, row.name, destination, items.map(item => item.id)])).digest("hex");
  return { token, count: items.length, source: String(row.name), destination, done, nameKey };
}

export async function previewLabelOperation(account: string, collection: string, operation: LabelOperation) {
  const tx = await database().transaction("read");
  try { const { token, count, source, destination, done } = await inspect(tx, account, collection, operation); return { token, count, source, destination, done }; }
  finally { tx.close(); }
}

export async function applyLabelOperation(account: string, collection: string, operation: LabelOperation, token: string) {
  return writeTransaction(async tx => {
    const plan = await inspect(tx, account, collection, operation);
    if (plan.done) return { changed: false };
    if (token !== plan.token) throw new LabelManagementError("The labels or affected items changed. Review the updated scope before confirming.", 409);
    const table = `item_${operation.kind}_labels`;
    const column = `${operation.kind}_id`;
    if (operation.action === "rename") {
      await tx.execute({ sql: `UPDATE ${table} SET name=?, name_key=? WHERE collection_id=? AND id=?`, args: [plan.destination, plan.nameKey, collection, operation.source] });
    } else {
      const affected = [collection, operation.source];
      // Carry forward each current item exactly as it exists in this transaction;
      // preserve the prior item version and its original editor before moving it.
      await tx.execute({ sql: `INSERT INTO item_revisions (id,item_id,version,name,description,status,edited_by,edited_at,current_keeper_id,current_keeper_version,category_id,location_id)
        SELECT lower(hex(randomblob(16))),id,version,name,description,status,COALESCE(last_edited_by,created_by),COALESCE(updated_at,created_at),current_keeper_id,current_keeper_version,category_id,location_id
        FROM items WHERE collection_id=? AND ${column}=?`, args: affected });
      await tx.execute({ sql: `UPDATE items SET ${column}=?,version=version+1,last_edited_by=?,updated_at=? WHERE collection_id=? AND ${column}=?`, args: [operation.target, account, Date.now(), ...affected] });
      // Retired names remain reserved. Point all retired aliases straight to the
      // active destination, keeping each historical item's original label ID.
      await tx.execute({ sql: `UPDATE ${table} SET merged_into_id=? WHERE collection_id=? AND (id=? OR merged_into_id=?)`, args: [operation.target, collection, operation.source, operation.source] });
    }
    return { changed: true };
  });
}

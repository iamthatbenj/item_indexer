// Browser-local input only: not a saved record, an archive, or a backup.
import { ITEM_NAME_LIMIT, ITEM_DESCRIPTION_LIMIT } from "@/shared/item-details";
import { ITEM_LABEL_LIMIT, itemLabelKinds, type ItemLabelInput } from "@/shared/item-labels";
import { STORY_TEXT_LIMIT } from "@/shared/stories";

export type ItemTextInput = { kind: "item"; name: string; description: string; currentKeeper: string; labels?: ItemLabelInput; version: number };
export type StoryTextInput = { kind: "story"; storyId: string; text: string; version: number };
export type NewStoryTextInput = { kind: "new-story"; text: string; storyteller: string; operation: string };
export type TextInput = ItemTextInput | StoryTextInput | NewStoryTextInput;
export type TextDraft = {
  id: string;
  revision: string;
  accountId: string;
  collectionId: string;
  itemId: string;
  updatedAt: number;
  input: TextInput;
};

const DATABASE = "family-belongings-pending-text";
const STORE = "drafts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bounded = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit;
const reference = (value: unknown) => value === "" || typeof value === "string" && uuid.test(value);
function valid(value: unknown): value is TextDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as TextDraft;
  if (![draft.id, draft.revision, draft.accountId, draft.collectionId, draft.itemId].every(id => typeof id === "string" && uuid.test(id)) || !Number.isSafeInteger(draft.updatedAt) || draft.updatedAt < 0 || !draft.input || typeof draft.input !== "object") return false;
  const input = draft.input;
  if (input.kind === "new-story") return bounded(input.text, STORY_TEXT_LIMIT) && reference(input.storyteller) && typeof input.operation === "string" && uuid.test(input.operation);
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version >= Number.MAX_SAFE_INTEGER) return false;
  if (input.kind === "item") return bounded(input.name, ITEM_NAME_LIMIT) && bounded(input.description, ITEM_DESCRIPTION_LIMIT) && reference(input.currentKeeper) && (input.labels === undefined || !!input.labels && itemLabelKinds.every(kind => {
    const choice = input.labels?.[kind];
    return choice === undefined || !!choice && (choice.id === undefined || reference(choice.id)) && (choice.name === undefined || bounded(choice.name, ITEM_LABEL_LIMIT));
  }));
  return input.kind === "story" && typeof input.storyId === "string" && uuid.test(input.storyId) && bounded(input.text, STORY_TEXT_LIMIT);
}

async function transaction<T>(mode: IDBTransactionMode, assertCurrent: () => void, work: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  assertCurrent();
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: ["accountId", "collectionId", "id"] });
      store.createIndex("scope", ["accountId", "collectionId"]);
      store.createIndex("account", "accountId");
    };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error("Close other tabs and retry local text storage.")); };
  });
  try {
    assertCurrent();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Local text storage failed."));
      try { work(tx.objectStore(STORE), result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

export function textDrafts(accountId: string, collectionId: string | null, assertCurrent: () => void) {
  return transaction<TextDraft[]>("readonly", assertCurrent, (store, result) => {
    const request = collectionId ? store.index("scope").getAll([accountId, collectionId]) : store.index("account").getAll(accountId);
    request.onsuccess = () => {
      // Stored content is input, never authorization or a navigation destination.
      try {
        assertCurrent();
        if (!request.result.every(valid)) throw new Error("Some local text drafts could not be read. Keep separate copies before clearing browser storage.");
        result((request.result as TextDraft[]).filter(draft => draft.accountId === accountId && (!collectionId || draft.collectionId === collectionId)).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)));
      } catch { store.transaction.abort(); }
    };
  });
}

export function retainTextDraft(draft: TextDraft, assertCurrent: () => void) {
  if (!valid(draft)) return Promise.reject(new Error("Local text draft is invalid. Copy your input before leaving this page."));
  return transaction<void>("readwrite", assertCurrent, (store, result) => {
    const request = store.index("scope").getAll([draft.accountId, draft.collectionId]);
    request.onsuccess = () => {
      try {
        assertCurrent();
        const others = (request.result as TextDraft[]).filter(row => row.id !== draft.id);
        // No silent eviction. This is a local allowance, not a service quota.
        if (others.length >= 25 || new Blob([JSON.stringify([...others, draft])]).size > 1024 * 1024) throw new Error("Local text draft limit reached.");
        store.put(draft);
        result(undefined);
      } catch { store.transaction.abort(); }
    };
  });
}

// Clear only the exact copy acknowledged/discarded. Another tab may have changed
// the same draft since it was read; that newer local work must remain intact.
export function discardTextDraft(draft: TextDraft, assertCurrent: () => void) {
  return transaction<boolean>("readwrite", assertCurrent, (store, result) => {
    const request = store.get([draft.accountId, draft.collectionId, draft.id]);
    request.onsuccess = () => {
      try {
        assertCurrent();
        const current = request.result as TextDraft | undefined;
        if (current && current.revision !== draft.revision) { result(false); return; }
        if (current) store.delete([draft.accountId, draft.collectionId, draft.id]);
        result(true);
      } catch { store.transaction.abort(); }
    };
  });
}

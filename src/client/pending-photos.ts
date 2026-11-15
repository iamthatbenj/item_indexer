// Browser-local staging, not a server record or a backup. Never store signed URLs.
export type PendingPhoto = {
  id: string;
  accountId: string;
  collectionId: string;
  itemId: string | null;
  itemName: string;
  file: File;
  createdAt: number;
};
const DATABASE = "family-belongings-pending-photos";
const STORE = "photos";

async function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void) => void, assertCurrent: () => void = () => {}): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE, { keyPath: ["accountId", "collectionId", "id"] });
      store.createIndex("scope", ["accountId", "collectionId"]);
    };
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error("Close other tabs and retry local photo storage.")); };
  });
  try {
    // Opening IndexedDB can finish after the initiating account check expired.
    assertCurrent();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let value: T;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Local photo storage failed."));
      try { work(tx.objectStore(STORE), result => { value = result; }); }
      catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}

export function pendingPhotos(accountId: string, collectionId: string) {
  return transaction<PendingPhoto[]>("readonly", (store, result) => {
    const request = store.index("scope").getAll([accountId, collectionId]);
    request.onsuccess = () => result((request.result as PendingPhoto[]).sort((a, b) => a.createdAt - b.createdAt));
  });
}

export function retainPhoto(photo: PendingPhoto, assertCurrent: () => void = () => {}) {
  return transaction<void>("readwrite", (store, result) => {
    const request = store.index("scope").getAll([photo.accountId, photo.collectionId]);
    request.onsuccess = () => {
      try { assertCurrent(); } catch { store.transaction.abort(); return; }
      const others = (request.result as PendingPhoto[]).filter(row => row.id !== photo.id);
      if (others.length >= 10 || others.reduce((bytes, row) => bytes + row.file.size, photo.file.size) > 80 * 1024 * 1024) {
        // Abort rather than evict another pending photo silently.
        store.transaction.abort();
        return;
      }
      store.put(photo);
      result(undefined);
    };
  }, assertCurrent);
}

export function discardPhoto(photo: PendingPhoto, assertCurrent: () => void = () => {}) {
  return transaction<void>("readwrite", (store, result) => {
    store.delete([photo.accountId, photo.collectionId, photo.id]);
    result(undefined);
  }, assertCurrent);
}

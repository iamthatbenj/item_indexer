import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID, createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { familyJourney, dbUrl, outbox, post } from "./support/family";
import { testStorage } from "./support/storage";

const db = createClient({ url: dbUrl, timeout: 5000 });
const { signIn, createCollection: createNativeCollection, invite, accept } = familyJourney(db);
const fixtures = resolve("tests/fixtures/photos");
let storage: ReturnType<typeof testStorage>;
test.setTimeout(90_000);
test.beforeAll(() => { storage = testStorage(); });
test.beforeEach(async () => {
  await db.batch(["story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
});
test.afterEach(async ({ page }) => {
  // Drain browser image requests before the next fixture replaces their rows.
  // Native local libSQL otherwise reports SQLITE_BUSY while the server reads.
  await expect.poll(() => page.locator("img").evaluateAll((images: HTMLImageElement[]) => images.every(image => image.complete))).toBe(true);
});
test.afterAll(() => { db.close(); storage.client.destroy(); });
const capture = (page: Page) => page.getByRole("region", { name: /Capture a belonging|Add another photo/ });
const pending = (page: Page) => page.getByRole("region", { name: "Pending photos on this device", exact: true });
async function captureReady(page: Page) {
  // Native forms and navigation can expose SSR before the capture client runs.
  await expect(page.getByLabel("Choose from your photo library", { exact: true })).toBeEnabled({ timeout: 30_000 });
}
async function createCollection(page: Page, name = "Family one") {
  const path = await createNativeCollection(page, name);
  await captureReady(page);
  return path;
}
async function openCapture(page: Page, path: string) { await page.goto(path); await captureReady(page); }
async function reloadCapture(page: Page) { await page.reload(); await captureReady(page); }
async function family(page: Page) { await signIn(page, "founder@example.com", true); return createCollection(page); }
async function select(page: Page, file = "small.png") {
  const input = page.getByLabel("Choose from your photo library", { exact: true });
  await expect(input).toBeEnabled({ timeout: 30_000 });
  await input.setInputFiles(`${fixtures}/${file}`);
  await expect(capture(page).getByRole("status")).toContainText("Pending on this device");
  await expect(capture(page).getByRole("button", { name: /^(Save photo draft|Add photo|Retry save)$/ })).toBeEnabled();
}
async function save(page: Page) { await capture(page).getByRole("button", { name: /^(Save photo draft|Add photo|Retry save)$/ }).click(); }
async function resume(page: Page, file = "small.png") {
  await pending(page).getByRole("button", { name: `Resume pending photo ${file}`, exact: true }).click();
  await expect(capture(page).getByRole("status")).toContainText("Pending photo loaded");
}
async function rows(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("family-belongings-pending-photos", 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try { return await new Promise<{ id: string; accountId: string; collectionId: string; itemId: string | null; name: string; bytes: number }[]>((resolve, reject) => {
      const r = db.transaction("photos").objectStore("photos").getAll();
      r.onsuccess = () => resolve(r.result.map(row => ({ id: row.id, accountId: row.accountId, collectionId: row.collectionId, itemId: row.itemId, name: row.file.name, bytes: row.file.size })));
      r.onerror = () => reject(r.error);
    }); } finally { db.close(); }
  });
}
async function keys(prefix: string) { return (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix }))).Contents?.map(object => object.Key!).sort() ?? []; }
async function verifiedFiles(id: string) {
  const photo = (await db.execute({ sql: "SELECT * FROM item_photos WHERE id=?", args: [id] })).rows[0];
  expect(photo).toBeTruthy();
  const bytes = Buffer.from(await (await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: String(photo.photo_key) }))).Body!.transformToByteArray());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(photo.sha256);
  const prefix = String(photo.photo_key).substring(0, String(photo.photo_key).lastIndexOf("/"));
  return keys(prefix);
}

test("interruption before intent creation retains the file across reload and explicitly retries the same operation", async ({ page }) => {
  const collection = await family(page); await select(page);
  const local = (await rows(page))[0];
  expect(local).toMatchObject({ collectionId: collection.split("/").pop(), itemId: null, name: "small.png", bytes: (await readFile(`${fixtures}/small.png`)).length });
  await page.route("**/photo-uploads", route => route.abort("failed"), { times: 1 });
  await save(page); await expect(capture(page).getByRole("alert")).toContainText("save was interrupted");
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
  await page.route("**/auth/account", route => route.abort("failed"));
  await reloadCapture(page);
  await expect(capture(page).getByRole("alert")).toContainText("Reconnect");
  await expect(page.locator(".photo-preview, .pending-photos button")).toHaveCount(0);
  await page.unroute("**/auth/account");
  await page.getByRole("button", { name: "Check account and pending photos", exact: true }).click();
  await expect(capture(page).getByRole("status")).toContainText("No upload was started");
  expect((await db.execute("SELECT * FROM photo_uploads")).rows).toHaveLength(0);
  await resume(page); await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect((await db.execute("SELECT id FROM items")).rows.map(row => row.id)).toEqual([local.id]);
  expect(await rows(page)).toHaveLength(0);
  expect(await verifiedFiles(local.id)).toHaveLength(2);
});

test("an interrupted PUT resumes after expired authorization by renewing the original intent, never a new ID", async ({ page }) => {
  const collection = await family(page); await select(page);
  const local = (await rows(page))[0];
  await page.route(`${storage.endpoint}/**`, async route => { if (route.request().method() === "PUT") await route.abort("failed"); else await route.continue(); });
  await save(page); await expect(capture(page).getByRole("alert")).toContainText("save was interrupted");
  expect((await db.execute("SELECT id FROM photo_uploads")).rows.map(row => row.id)).toEqual([local.id]);
  await db.execute("UPDATE photo_uploads SET expires_at=0");
  await page.unroute(`${storage.endpoint}/**`);
  await reloadCapture(page); await resume(page); await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect((await db.execute("SELECT id FROM photo_uploads")).rows.map(row => row.id)).toEqual([local.id]);
  expect((await db.execute("SELECT id FROM item_photos")).rows.map(row => row.id)).toEqual([local.id]);
  expect(await verifiedFiles(local.id)).toHaveLength(2);
  expect(await keys(`staging/${collection.split("/").pop()}/${local.id}`)).toHaveLength(0);
});

test("reload after a lost finish acknowledgement reconciles saved state without re-uploading or duplicating files", async ({ page }) => {
  await family(page); await select(page); const local = (await rows(page))[0];
  await page.route("**/photo-uploads/*/finish", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await save(page); await expect(capture(page).getByRole("alert")).toContainText("save was interrupted");
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
  const files = await verifiedFiles(local.id);
  await reloadCapture(page);
  await expect(page.getByRole("link", { name: /Untitled belonging — Draft item/ })).toBeVisible();
  await expect(pending(page)).toContainText("save not confirmed");
  // If retry unnecessarily uploads again it will fail this request and never navigate.
  await page.route(`${storage.endpoint}/**`, route => route.abort("failed"));
  await resume(page); await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
  expect((await db.execute("SELECT * FROM item_photos")).rows).toHaveLength(1);
  expect(await verifiedFiles(local.id)).toEqual(files);
  expect(await rows(page)).toHaveLength(0);
});

test("pending additional views retain their original item and collection when resumed from the collection page", async ({ page }) => {
  const collection = await family(page); await select(page); await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  const itemPath = new URL(page.url()).pathname;
  await select(page, "small.webp"); const local = (await rows(page))[0];
  expect(local.itemId).toBe(itemPath.split("/").pop());
  await page.route("**/photo-uploads/*/finish", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await save(page); await expect(capture(page).getByRole("alert")).toContainText("save was interrupted");
  const other = await createCollection(page, "Other collection");
  // The native form can show its SSR page before the pending client hydrates.
  await expect(page.getByLabel("Choose from your photo library", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(pending(page)).toContainText("No retained pending");
  await openCapture(page, collection);
  await expect(page.getByLabel("Choose from your photo library", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(pending(page)).toContainText("Another photo of Untitled belonging");
  await resume(page, "small.webp"); await save(page);
  await expect(page).toHaveURL(itemPath);
  await expect(page.locator(".item-view")).toHaveCount(2);
  expect((await db.execute("SELECT id FROM items")).rows).toHaveLength(1);
  expect((await db.execute({ sql: "SELECT id FROM items WHERE collection_id=?", args: [other.split("/").pop()!] })).rows).toHaveLength(0);
  expect((await db.execute("SELECT item_id FROM item_photos")).rows.every(row => row.item_id === local.itemId)).toBe(true);
  expect(await rows(page)).toHaveLength(0);
});

test("different identities cannot see or submit another contributor's pending photos, including a stale tab", async ({ page, context }) => {
  const collection = await family(page); await select(page);
  const local = (await rows(page))[0];
  const second = await context.newPage();
  expect((await post(second.request, "/auth/sign-out", {})).status()).toBe(303);
  await signIn(second, "outsider@example.com", true);
  const other = await createCollection(second, "Other identity collection");
  await expect(pending(second)).toContainText("No retained pending");
  await expect(second.locator("body")).not.toContainText("small.png");
  // Simulate account replacement between freshness check and the pinned begin.
  expect((await post(second.request, other + "/photo-uploads", { accountId: local.accountId, id: local.id, size: String(local.bytes) })).status()).toBe(409);
  await page.bringToFront();
  // Next development focus revalidation can redirect the inaccessible old
  // collection to sign-in; either way no previous identity's local UI remains.
  await expect(page.locator("body")).not.toContainText("small.png");
  await expect(page.locator(".photo-preview, .selected-photo, .pending-photos button")).toHaveCount(0);
  expect((await db.execute("SELECT * FROM photo_uploads")).rows).toHaveLength(0);
  expect((await post(page.request, "/auth/sign-out", {})).status()).toBe(303);
  await signIn(page, "founder@example.com"); await openCapture(page, collection);
  await resume(page); await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect((await db.execute("SELECT created_by FROM items")).rows[0].created_by).toBe(local.accountId);
});

async function mountedCapture(page: Page) {
  // Let initial hydration finish, then suppress only development HMR messages:
  // a server-driven reload would mask the stale mounted-client privacy race.
  let freezeHmr = false;
  await page.routeWebSocket(/\/_next\/hmr/, socket => {
    const server = socket.connectToServer();
    server.onMessage(message => { if (!freezeHmr) socket.send(message); });
  });
  await post(page.request, "/auth/sign-out", {});
  const collection = await family(page); await select(page);
  freezeHmr = true;
  return collection;
}

for (const action of ["resume", "reconnect", "select", "discard", "save"] as const) {
  test(`a delayed ${action} account response cannot undo a cross-account invalidation`, async ({ page, context }) => {
    const collection = await mountedCapture(page);
    const before = await rows(page);
    if (action === "reconnect") {
      await page.route("**/auth/account", route => route.abort("failed"), { times: 1 });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(capture(page).getByRole("alert")).toContainText("Reconnect");
    }
    let captured!: () => void; let release!: () => void;
    const capturedResponse = new Promise<void>(resolve => { captured = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/auth/account", async route => {
      const response = await route.fetch();
      expect(await response.json()).toEqual({ id: before[0].accountId });
      captured(); await released;
      await route.fulfill({ response });
    }, { times: 1 });
    let uploads = 0;
    page.on("request", request => { if (request.method() === "POST" && request.url().includes("/photo-uploads")) uploads++; });
    if (action === "resume") await pending(page).getByRole("button", { name: "Resume pending photo small.png", exact: true }).click();
    if (action === "reconnect") await page.getByRole("button", { name: "Check account and pending photos", exact: true }).click();
    if (action === "select") await page.getByLabel("Choose from your photo library", { exact: true }).setInputFiles(`${fixtures}/small.webp`);
    if (action === "discard") await pending(page).getByRole("button", { name: "Discard pending photo small.png", exact: true }).click();
    if (action === "save") await save(page);
    await capturedResponse;
    try {
      const second = await context.newPage();
      expect((await post(second.request, "/auth/sign-out", {})).status()).toBe(303);
      await signIn(second, "outsider@example.com", true);
      await createCollection(second, "Other identity collection");
      await expect(pending(second)).toContainText("No retained pending");
      // Keep the stale page mounted: do not let a focus-triggered server redirect
      // mask the local privacy race. The new tab sends a real identity broadcast.
      await expect(capture(page).getByRole("alert")).toContainText("signed-in account changed");
    } finally { release(); }
    await expect(page.getByLabel("Choose from your photo library", { exact: true })).toBeEnabled();
    await expect(capture(page)).toBeVisible();
    await expect(page.locator(".photo-preview, .selected-photo, .pending-photos button")).toHaveCount(0);
    await expect(capture(page)).not.toContainText(/small\.(png|webp)/);
    expect(await rows(page)).toEqual(before);
    expect(uploads).toBe(0);
    expect((await db.execute("SELECT * FROM photo_uploads")).rows).toHaveLength(0);
    expect(new URL(page.url()).pathname).toBe(collection);
  });
}

for (const action of ["reconnect", "discard"] as const) {
  test(`a delayed local ${action} cannot expose or remove old pending photos after an account switch`, async ({ page, context }) => {
    const collection = await mountedCapture(page);
    const before = await rows(page);
    if (action === "reconnect") {
      await page.route("**/auth/account", route => route.abort("failed"), { times: 1 });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(capture(page).getByRole("alert")).toContainText("Reconnect");
    }
    // Delay the real IndexedDB connection at the browser seam, after identity
    // succeeds but before the store is read or a delete can be issued.
    await page.evaluate(() => {
      const open = IDBFactory.prototype.open;
      let held = false;
      IDBFactory.prototype.open = function (...args: Parameters<typeof open>) {
        const request = open.apply(this, args);
        request.addEventListener("success", event => {
          if (held) return;
          held = true; event.stopImmediatePropagation();
          Object.defineProperty(window, "photoStoragePaused", { configurable: true, value: true });
          Object.defineProperty(window, "releasePhotoStorage", { configurable: true, value: () => {
            IDBFactory.prototype.open = open;
            request.onsuccess?.call(request, event);
          } });
        });
        return request;
      };
    });
    if (action === "reconnect") await page.getByRole("button", { name: "Check account and pending photos", exact: true }).click();
    else await pending(page).getByRole("button", { name: "Discard pending photo small.png", exact: true }).click();
    await page.waitForFunction(() => Reflect.get(window, "photoStoragePaused") === true);
    try {
      const second = await context.newPage();
      expect((await post(second.request, "/auth/sign-out", {})).status()).toBe(303);
      await signIn(second, "outsider@example.com", true);
      await createCollection(second, "Other identity collection");
      await expect(pending(second)).toContainText("No retained pending");
      await expect(capture(page).getByRole("alert")).toContainText("signed-in account changed");
    } finally { await page.evaluate(() => Reflect.get(window, "releasePhotoStorage")()); }
    await expect(page.getByLabel("Choose from your photo library", { exact: true })).toBeEnabled();
    await expect(capture(page)).toBeVisible();
    await expect(page.locator(".photo-preview, .selected-photo, .pending-photos button")).toHaveCount(0);
    expect(await rows(page)).toEqual(before);
    expect((await db.execute("SELECT * FROM photo_uploads")).rows).toHaveLength(0);
    expect(new URL(page.url()).pathname).toBe(collection);
  });
}

test("expired sessions hide local previews and require authentication before resuming the same operation", async ({ page }) => {
  const collection = await family(page); await select(page); const local = (await rows(page))[0];
  await db.execute("UPDATE sessions SET expires_at=0");
  await save(page);
  await expect(capture(page).getByRole("alert")).toContainText("original contributor");
  await expect(page.locator(".selected-photo")).toHaveCount(0);
  expect((await db.execute("SELECT * FROM photo_uploads")).rows).toHaveLength(0);
  await signIn(page, "founder@example.com"); await openCapture(page, collection); await resume(page); await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect((await db.execute("SELECT id FROM items")).rows[0].id).toBe(local.id);
});

test("removed membership and capacity rejection retain pending work without switching its target; discard affects only the local copy", async ({ page, browser }) => {
  const collection = await family(page); const invitation = await invite(page, collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await select(relative); const local = (await rows(relative))[0];
  // Saturate the real server allowance, rather than fabricating a client error.
  for (let i = 0; i < 20; i++) expect((await post(relative.request, collection + "/photo-uploads", { id: randomUUID(), size: "1" })).status()).toBe(200);
  await save(relative); await expect(capture(relative).getByRole("alert")).toContainText("limit reached");
  expect(await rows(relative)).toHaveLength(1);
  expect((await post(page.request, `${collection}/members/${local.accountId}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  await save(relative); await expect(capture(relative).getByRole("alert")).toContainText("collection is unavailable");
  expect(await rows(relative)).toHaveLength(1);
  await pending(relative).getByRole("button", { name: "Discard pending photo small.png", exact: true }).click();
  await expect(capture(relative).getByRole("status")).toContainText("discarded from this device only");
  expect(await rows(relative)).toHaveLength(0);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
  await context.close();
});

test("unsupported content and processing failures remain pending, never mislabeled as saved", async ({ page }) => {
  await family(page); await select(page, "malformed.jpg");
  await save(page); await expect(capture(page).getByRole("alert")).toContainText("JPEG");
  await reloadCapture(page); await expect(pending(page)).toContainText("malformed.jpg");
  await pending(page).getByRole("button", { name: "Discard pending photo malformed.jpg", exact: true }).click();
  await expect(pending(page)).toContainText("No retained pending");
  await select(page);
  await db.execute("CREATE TRIGGER fail_pending_publish BEFORE INSERT ON item_photos BEGIN SELECT RAISE(ABORT, 'private processing diagnostic'); END");
  try {
    await save(page); await expect(capture(page).getByRole("alert")).toContainText("not confirmed saved");
    await expect(page.locator("body")).not.toContainText("private processing diagnostic");
    expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
  } finally { await db.execute("DROP TRIGGER fail_pending_publish"); }
  await reloadCapture(page); await resume(page); await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
});

test("local storage failure blocks new server work and preserves the original for explicit retry", async ({ page }) => {
  await family(page);
  await expect(page.getByLabel("Choose from your photo library", { exact: true })).toBeEnabled();
  await expect(pending(page)).toContainText("No retained pending");
  // Exercise real browser unavailable-storage behavior at the platform seam.
  const originalStorage = await page.evaluateHandle(() => window.indexedDB);
  await page.evaluate(() => Object.defineProperty(window, "indexedDB", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } }));
  const input = page.getByLabel("Choose from your photo library", { exact: true });
  await input.setInputFiles(`${fixtures}/small.png`);
  await expect(capture(page).getByRole("alert")).toContainText("could not retain");
  await save(page); await expect(capture(page).getByRole("alert")).toContainText("No new upload was started");
  expect((await db.execute("SELECT * FROM photo_uploads")).rows).toHaveLength(0);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
  await page.evaluate(storage => Object.defineProperty(window, "indexedDB", { configurable: true, value: storage }), originalStorage);
  await originalStorage.dispose();
  await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
});

test("local cleanup failure reports confirmed success and retries without duplicating the saved photo", async ({ page }) => {
  await family(page); await select(page); const local = (await rows(page))[0];
  await page.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    Object.defineProperty(window, "restorePhotoDelete", { configurable: true, value: () => { IDBObjectStore.prototype.delete = remove; } });
    IDBObjectStore.prototype.delete = function () { throw new DOMException("denied", "QuotaExceededError"); };
  });
  await save(page);
  await expect(capture(page).getByRole("status")).toContainText("Server confirmed this photo saved");
  expect((await db.execute("SELECT id FROM items")).rows.map(row => row.id)).toEqual([local.id]);
  expect(await rows(page)).toHaveLength(1);
  await page.evaluate(() => (window as unknown as { restorePhotoDelete: () => void }).restorePhotoDelete());
  await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect(await rows(page)).toHaveLength(0);
  expect((await db.execute("SELECT * FROM item_photos")).rows).toHaveLength(1);
  expect(await verifiedFiles(local.id)).toHaveLength(2);
});

test("local capacity rejects a new pending file without evicting earlier work or starting server uploads", async ({ page }) => {
  await family(page);
  for (let i = 0; i < 10; i++) await select(page);
  const before = await rows(page); expect(before).toHaveLength(10);
  await page.getByLabel("Choose from your photo library", { exact: true }).setInputFiles(`${fixtures}/small.webp`);
  await expect(capture(page).getByRole("alert")).toContainText("could not retain");
  expect(await rows(page)).toEqual(before);
  await save(page); await expect(capture(page).getByRole("alert")).toContainText("No new upload was started");
  expect((await db.execute("SELECT * FROM photo_uploads")).rows).toHaveLength(0);
  await pending(page).getByRole("button", { name: "Discard pending photo small.png", exact: true }).first().click();
  await expect(pending(page).getByRole("button", { name: "Resume pending photo small.png", exact: true })).toHaveCount(9);
  await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect(await rows(page)).toHaveLength(9);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
});

test("expired intent renewal cannot displace a live lease or change uploader, collection, item or byte count", async ({ page }) => {
  const collection = await family(page); await select(page); const local = (await rows(page))[0];
  const endpoint = collection + "/photo-uploads";
  const values = { accountId: local.accountId, id: local.id, size: String(local.bytes) };
  expect((await post(page.request, endpoint, values)).status()).toBe(200);
  await db.execute({ sql: "UPDATE photo_uploads SET state='processing', expires_at=0, lease_until=? WHERE id=?", args: [Date.now() + 120_000, local.id] });
  expect((await post(page.request, endpoint, values)).status()).toBe(409);
  await db.execute("UPDATE photo_uploads SET lease_until=0");
  expect((await post(page.request, endpoint, { ...values, size: String(local.bytes + 1) })).status()).toBe(404);
  const other = await createCollection(page, "Other collection");
  expect((await post(page.request, other + "/photo-uploads", values)).status()).toBe(404);
  expect((await post(page.request, endpoint, { ...values, accountId: randomUUID() })).status()).toBe(409);
  await openCapture(page, collection); await resume(page); await save(page);
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  const item = new URL(page.url()).pathname;
  expect((await post(page.request, item + "/photo-uploads", values)).status()).toBe(404);
  const savedFiles = await verifiedFiles(local.id);
  await db.execute("UPDATE photo_uploads SET expires_at=0");
  expect((await post(page.request, endpoint, values)).status()).toBe(200);
  expect(await verifiedFiles(local.id)).toEqual(savedFiles);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
});

test("concurrent tabs retry one pending intent without duplicate records, and mobile controls do not overflow", async ({ page, context }) => {
  const collection = await family(page);
  const name = "W".repeat(180) + ".png";
  await expect(page.getByLabel("Choose from your photo library", { exact: true })).toBeEnabled();
  await page.getByLabel("Choose from your photo library", { exact: true }).setInputFiles({ name, mimeType: "image/png", buffer: await readFile(`${fixtures}/small.png`) });
  await expect(capture(page).getByRole("status")).toContainText("Pending on this device");
  const local = (await rows(page))[0];
  const second = await context.newPage(); await openCapture(second, collection); await second.setViewportSize({ width: 375, height: 812 });
  const control = pending(second).getByRole("button", { name: `Resume pending photo ${name}`, exact: true });
  await control.focus(); await second.keyboard.press("Enter");
  await expect(capture(second).getByRole("status")).toContainText("Pending photo loaded");
  expect(await second.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expect(second.getByText("Browser storage is not a backup", { exact: false })).toBeVisible();
  await Promise.all([save(page), save(second)]);
  await expect.poll(async () => (await db.execute("SELECT state FROM photo_uploads")).rows[0]?.state).toBe("saved");
  expect((await db.execute("SELECT id FROM items")).rows.map(row => row.id)).toEqual([local.id]);
  expect((await db.execute("SELECT id FROM item_photos")).rows.map(row => row.id)).toEqual([local.id]);
  expect(await verifiedFiles(local.id)).toHaveLength(2);
  await openCapture(second, collection); await expect(pending(second)).toContainText("No retained pending");
});

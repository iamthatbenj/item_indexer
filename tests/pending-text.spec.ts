import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { familyJourney, dbUrl, outbox, post } from "./support/family";
import type { TextDraft } from "../src/client/pending-text";

const db = createClient({ url: dbUrl, timeout: 5000 });
const { signIn, createCollection, invite, accept, codeFor } = familyJourney(db);
test.setTimeout(120_000);
test.beforeEach(async ({ request }) => {
  await db.batch(["story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  for (const path of ["/auth/account", "/pending-text", "/collections/prewarm/items/prewarm", "/collections/prewarm/items/prewarm/stories/new", "/collections/prewarm/items/prewarm/stories/prewarm"]) await request.get(path);
  await post(request, "/auth/sign-out", {});
  for (const path of ["/collections/prewarm/items/prewarm/details", "/collections/prewarm/items/prewarm/stories", "/collections/prewarm/items/prewarm/stories/prewarm/details"]) expect((await post(request, path, {})).status()).toBe(401);
});
test.afterEach(async ({ page }) => { await expect.poll(() => page.locator("img").evaluateAll((images: HTMLImageElement[]) => images.every(image => image.complete))).toBe(true); });
test.afterAll(() => db.close());

async function photo(request: APIRequestContext, path: string) {
  const bytes = await readFile("tests/fixtures/photos/small.png"); const id = randomUUID();
  const start = await post(request, path + "/photo-uploads", { id, size: String(bytes.length) });
  expect(start.status()).toBe(200);
  expect((await request.put((await start.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  expect((await post(request, `${path}/photo-uploads/${id}/finish`, {})).status()).toBe(200);
  return id;
}
async function family(page: Page) {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page); const id = await photo(page.request, collection);
  const path = `${collection}/items/${id}`; const storyteller = randomUUID(); const storyId = randomUUID();
  expect((await post(page.request, collection + "/people/records", { id: storyteller, name: "Sam", note: "Aunt" })).status()).toBe(200);
  expect((await post(page.request, path + "/stories", { id: storyId, storyteller, text: "Original memory." })).status()).toBe(200);
  return { collection, id, path, storyteller, storyId, story: `${path}/stories/${storyId}` };
}
async function rows(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("family-belongings-pending-text", 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<TextDraft[]>((resolve, reject) => { const request = db.transaction("drafts").objectStore("drafts").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  });
}
const pending = (page: Page) => page.getByRole("region", { name: "Pending text on this device", exact: true });
async function itemEditor(page: Page, path: string) { await page.goto(path); await expect(page.getByLabel("Name", { exact: true })).toBeEnabled({ timeout: 30_000 }); }
async function storyEditor(page: Page, path: string) { await page.goto(path); await expect(page.getByLabel("Story", { exact: true })).toBeEnabled({ timeout: 30_000 }); }
async function retained(page: Page, text: string) {
  await expect.poll(async () => (await rows(page)).filter(row => row.input.kind === "item" ? row.input.name === text : row.input.text === text).length).toBeGreaterThan(0);
}
async function resume(page: Page) { await pending(page).getByRole("button", { name: "Resume pending text", exact: true }).first().click(); }
async function compare(page: Page, kind: "item" | "story", version: number) {
  await page.getByRole("button", { name: `Compare with latest saved ${kind}`, exact: true }).click();
  await expect(page.getByRole("region", { name: `Latest saved ${kind}`, exact: true })).toContainText(`version ${version}`);
  await page.getByRole("button", { name: `Revise against version ${version}`, exact: true }).click();
}
const itemRow = async (id: string) => (await db.execute({ sql: "SELECT * FROM items WHERE id=?", args: [id] })).rows[0];
const storyRow = async (id: string) => (await db.execute({ sql: "SELECT * FROM stories WHERE id=?", args: [id] })).rows[0];

// All artifacts are read at browser/storage/database seams. No internal module
// or authorization mock substitutes for current membership and version checks.
test("item text and keeper resume after reload only through explicit comparison, then clear matching local work", async ({ page }) => {
  const item = await family(page); await itemEditor(page, item.path);
  await page.getByLabel("Name", { exact: true }).fill("My local bowl");
  await page.getByLabel("Short description", { exact: true }).fill("An unfinished recollection of its appearance.");
  await page.getByLabel("Current keeper (optional)", { exact: true }).selectOption(item.storyteller);
  await expect.poll(async () => (await rows(page))[0]?.input).toMatchObject({ kind: "item", name: "My local bowl", currentKeeper: item.storyteller, version: 1 });
  expect(await itemRow(item.id)).toMatchObject({ name: "", version: 1 });
  await page.reload(); await expect(pending(page)).toContainText("save not confirmed");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await resume(page); await expect(page.getByLabel("Name", { exact: true })).toHaveValue("My local bowl");
  await expect(page.getByRole("button", { name: "Save item details", exact: true })).toBeDisabled();
  await compare(page, "item", 1);
  await page.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(page).toHaveURL(item.path + "?saved=1");
  expect(await itemRow(item.id)).toMatchObject({ name: "My local bowl", current_keeper_id: item.storyteller, version: 2 });
  expect(await rows(page)).toHaveLength(0);
  expect((await db.execute("SELECT version FROM item_revisions")).rows.map(row => row.version)).toEqual([1]);
});

test("story navigation recovery preserves its original version and survives repeated intervening edits", async ({ page, context }) => {
  const item = await family(page); await storyEditor(page, item.story);
  await page.getByLabel("Story", { exact: true }).fill("Local story before navigation."); await retained(page, "Local story before navigation.");
  await page.goto("/");
  expect((await post(page.request, item.story + "/details", { version: "1", text: "Another member's saved elaboration." })).status()).toBe(200);
  await storyEditor(page, item.story); await resume(page);
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue("Local story before navigation.");
  await compare(page, "story", 2);
  const second = await context.newPage();
  expect((await post(second.request, item.story + "/details", { version: "2", text: "An intervening edit after comparison." })).status()).toBe(200);
  await page.getByRole("button", { name: "Save story changes", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("saved story changed");
  await page.reload(); await expect(pending(page).getByRole("button", { name: "Resume pending text", exact: true }).first()).toBeVisible();
  await resume(page); await compare(page, "story", 3);
  await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(page).toHaveURL(item.story + "?saved=1");
  expect(await storyRow(item.storyId)).toMatchObject({ text: "Local story before navigation.", version: 4, storyteller_id: item.storyteller });
  expect((await db.execute("SELECT version FROM story_revisions ORDER BY version")).rows.map(row => row.version)).toEqual([1, 2, 3]);
});

test("a conflicting item draft survives reload without being silently rebased", async ({ page }) => {
  const item = await family(page); await itemEditor(page, item.path);
  await page.getByLabel("Name", { exact: true }).fill("Attempted local name"); await retained(page, "Attempted local name");
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Intervening saved name", description: "Saved description" })).status()).toBe(200);
  await page.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("saved version changed");
  await page.reload(); await resume(page);
  await expect(page.locator('input[name="version"]')).toHaveValue("1");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Attempted local name");
  await page.getByRole("button", { name: "Compare with latest saved item", exact: true }).click();
  await expect(page.getByRole("region", { name: "Latest saved item", exact: true })).toContainText("Intervening saved name");
  await expect(page.getByRole("button", { name: "Save item details", exact: true })).toBeDisabled();
  expect(await itemRow(item.id)).toMatchObject({ name: "Intervening saved name", version: 2 });
});

test("new story text, storyteller and request survive a lost success response without duplicate stories", async ({ page }) => {
  const item = await family(page); await storyEditor(page, item.path + "/stories/new");
  await page.getByLabel("Storyteller", { exact: true }).selectOption(item.storyteller);
  await page.getByLabel("Story", { exact: true }).fill("A newly recorded local memory."); await retained(page, "A newly recorded local memory.");
  const draft = (await rows(page))[0]; expect(draft.input.kind).toBe("new-story");
  if (draft.input.kind !== "new-story") throw new Error("Expected a new story draft");
  const operation = draft.input.operation;
  await page.route("**/stories", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await page.getByRole("button", { name: "Record story", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("interrupted");
  expect(await storyRow(operation)).toMatchObject({ text: "A newly recorded local memory.", version: 1 });
  await page.reload(); await resume(page);
  await expect(page.getByLabel("Storyteller", { exact: true })).toHaveValue(item.storyteller);
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue("A newly recorded local memory.");
  await page.getByRole("button", { name: "Record story", exact: true }).click(); await expect(page).toHaveURL(item.path + "?storySaved=1#story-" + operation);
  expect((await db.execute("SELECT id FROM stories")).rows).toHaveLength(2);
  expect((await db.execute("SELECT * FROM story_revisions")).rows).toHaveLength(0);
  expect(await rows(page)).toHaveLength(0);
});

test("temporary connection failure retains text and requires an explicit fresh account check before recovery", async ({ page }) => {
  const item = await family(page); await storyEditor(page, item.story);
  await page.route("**/auth/account", route => route.abort("failed"));
  await page.getByLabel("Story", { exact: true }).fill("Text entered during a temporary failed connection."); await retained(page, "Text entered during a temporary failed connection.");
  await page.getByRole("button", { name: "Save story changes", exact: true }).click();
  await expect(pending(page).getByRole("alert")).toContainText("Reconnect");
  await expect(page.getByLabel("Story", { exact: true })).toHaveCount(0);
  expect(await storyRow(item.storyId)).toMatchObject({ text: "Original memory.", version: 1 });
  await page.unroute("**/auth/account");
  await pending(page).getByRole("button", { name: "Check account and pending text", exact: true }).click();
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue("Text entered during a temporary failed connection.");
  await page.reload(); await resume(page); await compare(page, "story", 1);
  await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(page).toHaveURL(item.story + "?saved=1");
});

test("a deleted story cannot be recreated by a stale editor, while its local input remains inspectable and discardable", async ({ page }) => {
  const item = await family(page); await storyEditor(page, item.story);
  await page.getByLabel("Story", { exact: true }).fill("My pending story changes after deletion."); await retained(page, "My pending story changes after deletion.");
  // Removal is not a shipped member action yet. Simulate an absent target at
  // the persistence seam, not a fake successful DELETE permission check.
  await db.execute({ sql: "DELETE FROM stories WHERE id=?", args: [item.storyId] });
  await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("story is unavailable");
  expect(await storyRow(item.storyId)).toBeUndefined();
  await page.goto("/pending-text"); await page.getByRole("button", { name: "Inspect pending copy", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Selected local pending text", exact: true })).toContainText("My pending story changes after deletion.");
  expect((await page.request.get(item.story)).status()).toBe(404);
  await page.getByRole("button", { name: "Discard pending copy", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "All pending text on this device", exact: true })).toContainText("No retained pending text");
  expect(await rows(page)).toHaveLength(0); expect(await storyRow(item.storyId)).toBeUndefined();
});

test("session expiry and revoked membership retain local input without restoring collection access", async ({ page, browser }) => {
  const item = await family(page); const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await storyEditor(relative, item.story); await relative.getByLabel("Story", { exact: true }).fill("A relative's pending recollection."); await retained(relative, "A relative's pending recollection.");
  const accountId = (await rows(relative))[0].accountId;
  await db.execute({ sql: "UPDATE sessions SET expires_at=0 WHERE account_id=?", args: [accountId] });
  await relative.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(pending(relative).getByRole("alert")).toContainText("sign in again");
  expect(await storyRow(item.storyId)).toMatchObject({ version: 1 });
  await signIn(relative, "relative@example.com"); await storyEditor(relative, item.story); await resume(relative); await compare(relative, "story", 1);
  expect((await post(page.request, `${item.collection}/members/${accountId}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  await relative.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(relative.getByRole("main").getByRole("alert")).toContainText("unavailable");
  await relative.goto("/pending-text"); await relative.getByRole("button", { name: "Inspect pending copy", exact: true }).first().click();
  await expect(relative.getByRole("region", { name: "Selected local pending text", exact: true })).toContainText("A relative's pending recollection.");
  expect((await post(relative.request, item.story + "/details", { version: "1", text: "Cannot restore access" })).status()).toBe(404);
  expect((await db.execute({ sql: "SELECT * FROM memberships WHERE account_id=?", args: [accountId] })).rows).toHaveLength(0);
  await context.close();
});

test("pending item labels can be copied after membership is revoked", async ({ page, browser }) => {
  const item = await family(page);
  const invitation = await invite(page, item.collection, "label-relative@example.com");
  const context = await browser.newContext();
  try {
    const relative = await context.newPage();
    await signIn(relative, "label-relative@example.com"); await accept(relative, invitation);
    await itemEditor(relative, item.path);
    await relative.getByLabel("New category label", { exact: true }).fill("Family serving pieces");
    await expect.poll(async () => (await rows(relative)).map(row => row.input)).toContainEqual(expect.objectContaining({
      kind: "item", labels: expect.objectContaining({ category: { name: "Family serving pieces" } }),
    }));
    const accountId = (await rows(relative))[0].accountId;
    expect((await post(page.request, `${item.collection}/members/${accountId}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
    expect((await relative.request.get(item.path + "/details")).status()).toBe(404);
    await relative.goto("/pending-text");
    await relative.getByRole("button", { name: "Inspect pending copy", exact: true }).click();
    const inspected = relative.getByRole("region", { name: "Selected local pending text", exact: true });
    await expect(inspected).toContainText("Family serving pieces");
    expect(await itemRow(item.id)).toMatchObject({ version: 1, category_id: null, location_id: null });
  } finally { await context.close(); }
});

test("unavailable local storage warns before navigation but does not falsely claim local retention or server success", async ({ page }) => {
  const item = await family(page); await itemEditor(page, item.path);
  const original = await page.evaluateHandle(() => window.indexedDB);
  await page.evaluate(() => Object.defineProperty(window, "indexedDB", { configurable: true, get() { throw new DOMException("denied", "SecurityError"); } }));
  await page.getByLabel("Name", { exact: true }).fill("Keep this text open"); await expect(pending(page)).toContainText("could not retain");
  await page.route("**/items/*/details", route => route.abort("failed"), { times: 1 });
  await page.getByRole("button", { name: "Save item details", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("interrupted");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Keep this text open"); expect(await itemRow(item.id)).toMatchObject({ version: 1 });
  await page.evaluate(storage => Object.defineProperty(window, "indexedDB", { configurable: true, value: storage }), original); await original.dispose();
  await page.getByRole("button", { name: "Save item details", exact: true }).click(); await expect(page).toHaveURL(item.path + "?saved=1");
  expect(await rows(page)).toHaveLength(0);
});

test("successful cleanup removes only the matching editor's draft and leaves another tab's pending work", async ({ page, context }) => {
  const item = await family(page); await itemEditor(page, item.path);
  await page.getByLabel("Name", { exact: true }).fill("First tab input"); await retained(page, "First tab input");
  const second = await context.newPage(); await itemEditor(second, item.path);
  await second.getByLabel("Name", { exact: true }).fill("Other tab input"); await retained(second, "Other tab input");
  expect(await rows(page)).toHaveLength(2);
  await page.getByRole("button", { name: "Save item details", exact: true }).click(); await expect(page).toHaveURL(item.path + "?saved=1");
  const remaining = await rows(page); expect(remaining).toHaveLength(1); expect(remaining[0].input).toMatchObject({ kind: "item", name: "Other tab input", version: 1 });
  expect(await itemRow(item.id)).toMatchObject({ name: "First tab input", version: 2 });
  await second.getByRole("button", { name: "Save item details", exact: true }).click(); await expect(second.getByRole("main").getByRole("alert")).toContainText("saved version changed");
  expect((await rows(page))[0].input).toMatchObject({ name: "Other tab input", version: 1 });
});

for (const phase of ["identity", "local storage"] as const) {
  test(`account isolation rejects delayed ${phase} results during text recovery`, async ({ page, context }) => {
    let frozen = false;
    await page.routeWebSocket(/\/_next\/hmr/, socket => {
      const server = socket.connectToServer(); server.onMessage(message => { if (!frozen) socket.send(message); });
    });
    const item = await family(page); await storyEditor(page, item.story);
    await page.getByLabel("Story", { exact: true }).fill("Private original contributor input."); await retained(page, "Private original contributor input.");
    await page.reload(); await expect(pending(page).getByRole("button", { name: "Resume pending text", exact: true })).toBeVisible();
    frozen = true;
    const before = await rows(page);
    let release!: () => void;
    let captured!: () => void;
    const held = new Promise<void>(resolve => { captured = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    if (phase === "identity") {
      await page.route("**/auth/account", async route => {
        const response = await route.fetch(); captured(); await released; await route.fulfill({ response });
      }, { times: 1 });
    } else {
      await page.evaluate(() => {
        const open = IDBFactory.prototype.open;
        const callbacks: (() => void)[] = [];
        IDBFactory.prototype.open = function (...args: Parameters<typeof open>) {
          const request = open.apply(this, args);
          request.addEventListener("success", event => {
            event.stopImmediatePropagation();
            callbacks.push(() => request.onsuccess?.call(request, event));
            Object.defineProperty(window, "textStoragePaused", { configurable: true, value: true });
          });
          return request;
        };
        Object.defineProperty(window, "releaseTextStorage", { configurable: true, value: () => {
          IDBFactory.prototype.open = open; for (const callback of callbacks) callback();
        } });
      });
    }
    await pending(page).getByRole("button", { name: "Resume pending text", exact: true }).click();
    if (phase === "identity") await held;
    else await page.waitForFunction(() => Reflect.get(window, "textStoragePaused") === true);
    try {
      const second = await context.newPage(); expect((await post(second.request, "/auth/sign-out", {})).status()).toBe(303);
      await signIn(second, "outsider@example.com", true);
      await second.goto("/pending-text"); await expect(second.getByRole("region", { name: "All pending text on this device", exact: true })).toContainText("No retained pending text");
      await expect(pending(page).getByRole("alert")).toContainText("account changed");
      expect((await post(second.request, item.path + "/details", { accountId: before[0].accountId, version: "1", name: "Wrong identity", description: "" })).status()).toBe(409);
      expect((await post(second.request, item.story + "/details", { accountId: before[0].accountId, version: "1", text: "Wrong identity" })).status()).toBe(409);
      expect((await post(second.request, item.path + "/stories", { accountId: before[0].accountId, id: randomUUID(), storyteller: item.storyteller, text: "Wrong identity" })).status()).toBe(409);
    } finally {
      release();
      if (phase === "local storage") await page.evaluate(() => Reflect.get(window, "releaseTextStorage")());
    }
    await expect(pending(page).getByRole("button", { name: "Check account and pending text", exact: true })).toBeEnabled();
    await expect(page.getByLabel("Story", { exact: true })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("Private original contributor input.");
    expect(await rows(page)).toEqual(before);
    expect(await storyRow(item.storyId)).toMatchObject({ text: "Original memory.", version: 1 });
  });
}

for (const change of ["expiry", "account switch"] as const) {
  test(`a session ${change} after successful verification hides old local input when the pinned save fails`, async ({ page }) => {
    let frozen = false;
    await page.routeWebSocket(/\/_next\/hmr/, socket => { const server = socket.connectToServer(); server.onMessage(message => { if (!frozen) socket.send(message); }); });
    const item = await family(page);
    if (change === "account switch") await invite(page, item.collection, "relative@example.com");
    await itemEditor(page, item.path);
    await page.getByLabel("Name", { exact: true }).fill("Private text before the session changed"); await retained(page, "Private text before the session changed");
    frozen = true;
    await page.route("**/items/*/details", async route => {
      // Real authentication changes after prepare's fresh account check, but
      // before the pinned POST reaches the application. No cross-tab broadcast
      // or focus event may mask the response-handling boundary under test.
      if (change === "expiry") await db.execute("UPDATE sessions SET expires_at=0");
      else {
        expect((await post(page.request, "/auth/sign-out", {})).status()).toBe(303);
        expect((await post(page.request, "/auth/request", { email: "relative@example.com" })).status()).toBe(303);
        expect((await post(page.request, "/auth/verify", { email: "relative@example.com", code: await codeFor("relative@example.com") })).status()).toBe(303);
      }
      const cookies = await page.context().cookies();
      const response = await route.fetch({ headers: { ...route.request().headers(), cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ") } });
      expect(response.status()).toBe(change === "expiry" ? 401 : 409);
      await route.fulfill({ response });
    }, { times: 1 });
    await page.getByRole("button", { name: "Save item details", exact: true }).click();
    await expect(pending(page).getByRole("button", { name: "Check account and pending text", exact: true })).toBeEnabled();
    await expect(page.getByLabel("Name", { exact: true })).toHaveCount(0);
    expect((await rows(page))[0].input).toMatchObject({ kind: "item", name: "Private text before the session changed" });
    expect(await itemRow(item.id)).toMatchObject({ version: 1, name: "" });
  });
}

test("local text keeps its fixed collection, item and entry kind without clearing unrelated pending input", async ({ page }) => {
  const item = await family(page); await itemEditor(page, item.path);
  await page.getByLabel("Name", { exact: true }).fill("Collection A pending item"); await retained(page, "Collection A pending item");
  const other = await createCollection(page, "Second collection"); const otherId = await photo(page.request, other); const otherPath = `${other}/items/${otherId}`;
  await itemEditor(page, otherPath); await expect(pending(page)).toContainText("No retained pending text");
  await page.getByLabel("Name", { exact: true }).fill("Collection B pending item"); await retained(page, "Collection B pending item");
  expect((await post(page.request, `${other}/items/${item.id}/details`, { version: "1", name: "Wrong target", description: "" })).status()).toBe(404);
  expect((await post(page.request, otherPath + "/details", { version: "1", name: "Wrong keeper", description: "", currentKeeper: item.storyteller })).status()).toBe(400);
  await storyEditor(page, item.path + "/stories/new"); await expect(pending(page)).toContainText("No retained pending text");
  await page.getByLabel("Story", { exact: true }).fill("Separate new story input"); await retained(page, "Separate new story input");
  await itemEditor(page, item.path); await expect(pending(page).getByRole("button", { name: "Resume pending text", exact: true })).toHaveCount(1);
  await resume(page); await compare(page, "item", 1);
  await page.getByRole("button", { name: "Save item details", exact: true }).click(); await expect(page).toHaveURL(item.path + "?saved=1");
  const remaining = await rows(page); expect(remaining).toHaveLength(2);
  expect(remaining.some(row => row.collectionId === other.split("/").pop() && row.input.kind === "item" && row.input.name === "Collection B pending item")).toBe(true);
  expect(remaining.some(row => row.itemId === item.id && row.input.kind === "new-story" && row.input.text === "Separate new story input")).toBe(true);
  expect(await itemRow(otherId)).toMatchObject({ name: "", version: 1 });
});

test("long local recollections remain escaped, mobile-width and keyboard recoverable", async ({ page }) => {
  const item = await family(page); await page.setViewportSize({ width: 375, height: 812 }); await storyEditor(page, item.story);
  const text = '<script>window.pendingTextInjected=true</script>' + "W".repeat(2000);
  await page.getByLabel("Story", { exact: true }).fill(text); await retained(page, text);
  await page.goto("/pending-text");
  const inspect = page.getByRole("button", { name: "Inspect pending copy", exact: true }); await inspect.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Selected local pending text", exact: true })).toContainText(text);
  expect(await page.evaluate(() => Reflect.get(window, "pendingTextInjected"))).toBeUndefined();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole("link", { name: "Open original editor", exact: true }).click();
  const restore = pending(page).getByRole("button", { name: "Resume pending text", exact: true }); await restore.focus(); await page.keyboard.press("Enter");
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue(text);
  await compare(page, "story", 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(page).toHaveURL(item.story + "?saved=1");
  expect(await storyRow(item.storyId)).toMatchObject({ text, version: 2 }); expect(await rows(page)).toHaveLength(0);
});

for (const kind of ["item", "story", "new-story"] as const) {
  test(`the ${kind} form cannot edit or submit old fields while a different local copy is still being restored`, async ({ page }) => {
    const item = await family(page);
    const path = kind === "item" ? item.path : kind === "story" ? item.story : item.path + "/stories/new";
    const fieldName = kind === "item" ? "Name" : "Story";
    const buttonName = kind === "item" ? "Save item details" : kind === "story" ? "Save story changes" : "Record story";
    if (kind === "item") await itemEditor(page, path); else await storyEditor(page, path);
    if (kind === "new-story") await page.getByLabel("Storyteller", { exact: true }).selectOption(item.storyteller);
    await page.getByLabel(fieldName, { exact: true }).fill("Restore this pending input, not the old fields."); await retained(page, "Restore this pending input, not the old fields.");
    await page.reload(); await expect(pending(page).getByRole("button", { name: "Resume pending text", exact: true })).toBeVisible();
    await page.evaluate(() => {
      const open = IDBFactory.prototype.open; const callbacks: (() => void)[] = [];
      IDBFactory.prototype.open = function (...args: Parameters<typeof open>) {
        const request = open.apply(this, args);
        request.addEventListener("success", event => {
          event.stopImmediatePropagation(); callbacks.push(() => request.onsuccess?.call(request, event));
          Object.defineProperty(window, "restoringTextPaused", { configurable: true, value: true });
        });
        return request;
      };
      Object.defineProperty(window, "finishRestoringText", { configurable: true, value: () => { IDBFactory.prototype.open = open; for (const callback of callbacks) callback(); } });
    });
    let writes = 0;
    page.on("request", request => { if (request.method() === "POST" && (request.url().endsWith("/details") || request.url().endsWith("/stories"))) writes++; });
    try {
      await resume(page); await page.waitForFunction(() => Reflect.get(window, "restoringTextPaused") === true);
      await expect(page.getByLabel(fieldName, { exact: true })).toBeVisible();
      await expect(page.getByLabel(fieldName, { exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: buttonName, exact: true })).toBeDisabled();
      // Native submission is a browser seam, not an internal handler call.
      await page.getByLabel(fieldName, { exact: true }).evaluate((field: HTMLInputElement | HTMLTextAreaElement) => field.form?.requestSubmit());
    } finally { await page.evaluate(() => Reflect.get(window, "finishRestoringText")()); }
    await expect(page.getByLabel(fieldName, { exact: true })).toHaveValue("Restore this pending input, not the old fields.");
    await expect(page.getByLabel(fieldName, { exact: true })).toBeEnabled();
    expect(writes).toBe(0);
    expect(await itemRow(item.id)).toMatchObject({ name: "", version: 1 });
    expect(await storyRow(item.storyId)).toMatchObject({ text: "Original memory.", version: 1 });
  });
}

for (const kind of ["item", "story", "new-story"] as const) {
  test(`discarding a resumed ${kind} working copy detaches its original from a different subsequent save`, async ({ page }) => {
    const item = await family(page);
    const path = kind === "item" ? item.path : kind === "story" ? item.story : item.path + "/stories/new";
    const fieldName = kind === "item" ? "Name" : "Story";
    const buttonName = kind === "item" ? "Save item details" : kind === "story" ? "Save story changes" : "Record story";
    if (kind === "item") await itemEditor(page, path); else await storyEditor(page, path);
    if (kind === "new-story") await page.getByLabel("Storyteller", { exact: true }).selectOption(item.storyteller);
    await page.getByLabel(fieldName, { exact: true }).fill("Original pending contribution"); await retained(page, "Original pending contribution");
    const original = (await rows(page))[0];
    await page.reload(); await resume(page);
    await expect(page.getByLabel(fieldName, { exact: true })).toHaveValue("Original pending contribution");
    await page.getByLabel(fieldName, { exact: true }).fill("Working copy to discard"); await retained(page, "Working copy to discard");
    await expect(pending(page).getByRole("listitem")).toHaveCount(2);
    // The working copy is first after its latest input is retained. Resetting
    // the form proves we discarded that active copy, not its retained source.
    await pending(page).getByRole("listitem").first().getByRole("button", { name: "Discard pending text", exact: true }).click();
    await expect(page.getByLabel(fieldName, { exact: true })).toHaveValue(kind === "story" ? "Original memory." : "");
    expect(await rows(page)).toEqual([original]);
    if (kind === "new-story") await page.getByLabel("Storyteller", { exact: true }).selectOption(item.storyteller);
    await page.getByLabel(fieldName, { exact: true }).fill("Different subsequent contribution"); await retained(page, "Different subsequent contribution");
    const replacement = (await rows(page)).find(row => row.id !== original.id)!;
    await page.getByRole("button", { name: buttonName, exact: true }).click();
    if (replacement.input.kind === "new-story") {
      await expect(page).toHaveURL(item.path + "?storySaved=1#story-" + replacement.input.operation);
      expect(await storyRow(replacement.input.operation)).toMatchObject({ text: "Different subsequent contribution", version: 1 });
      if (original.input.kind !== "new-story") throw new Error("Expected a retained new story");
      expect(await storyRow(original.input.operation)).toBeUndefined();
    } else if (kind === "item") {
      await expect(page).toHaveURL(item.path + "?saved=1");
      expect(await itemRow(item.id)).toMatchObject({ name: "Different subsequent contribution", version: 2 });
    } else {
      await expect(page).toHaveURL(item.story + "?saved=1");
      expect(await storyRow(item.storyId)).toMatchObject({ text: "Different subsequent contribution", version: 2 });
    }
    expect(await rows(page)).toEqual([original]);
  });
}

test("queued local writes do not claim the latest input is retained before its own storage commit", async ({ page }) => {
  const item = await family(page); await storyEditor(page, item.story);
  await page.getByLabel("Story", { exact: true }).fill("Earlier retained input."); await retained(page, "Earlier retained input.");
  await page.evaluate(() => {
    const open = IDBFactory.prototype.open;
    const callbacks: (() => void)[] = [];
    let count = 0;
    IDBFactory.prototype.open = function (...args: Parameters<typeof open>) {
      const request = open.apply(this, args);
      request.addEventListener("success", event => {
        event.stopImmediatePropagation(); callbacks.push(() => request.onsuccess?.call(request, event));
        Object.defineProperty(window, "textWriteOpenCount", { configurable: true, value: ++count });
      });
      return request;
    };
    Object.defineProperty(window, "releaseNextTextWrite", { configurable: true, value: () => callbacks.shift()?.() });
    Object.defineProperty(window, "releaseAllTextWrites", { configurable: true, value: () => { IDBFactory.prototype.open = open; for (const callback of callbacks.splice(0)) callback(); } });
  });
  try {
    await page.getByLabel("Story", { exact: true }).fill("An intermediate pending input.");
    await page.waitForFunction(() => Reflect.get(window, "textWriteOpenCount") === 1);
    await page.getByLabel("Story", { exact: true }).fill("The latest pending input.");
    await expect(pending(page)).toContainText("Retaining the latest input");
    await page.evaluate(() => Reflect.get(window, "releaseNextTextWrite")());
    await page.waitForFunction(() => Reflect.get(window, "textWriteOpenCount") === 2);
    await expect(pending(page)).toContainText("Retaining the latest input");
    await page.evaluate(() => Reflect.get(window, "releaseNextTextWrite")());
    await expect(pending(page)).toContainText("Pending text retained on this device");
  } finally { await page.evaluate(() => Reflect.get(window, "releaseAllTextWrites")()); }
  await retained(page, "The latest pending input.");
  expect(await storyRow(item.storyId)).toMatchObject({ text: "Original memory.", version: 1 });
});

test("a failed cleanup reports confirmed server success and retains text for deliberate no-op reconciliation", async ({ page }) => {
  const item = await family(page); await storyEditor(page, item.story);
  await page.getByLabel("Story", { exact: true }).fill("Server saved this recollection."); await retained(page, "Server saved this recollection.");
  await page.evaluate(() => {
    const remove = IDBObjectStore.prototype.delete;
    Object.defineProperty(window, "restoreTextDelete", { configurable: true, value: () => { IDBObjectStore.prototype.delete = remove; } });
    IDBObjectStore.prototype.delete = function () { throw new DOMException("denied", "QuotaExceededError"); };
  });
  await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(pending(page)).toContainText("Server confirmed the save");
  expect(await storyRow(item.storyId)).toMatchObject({ text: "Server saved this recollection.", version: 2 }); expect(await rows(page)).toHaveLength(1);
  await page.evaluate(() => Reflect.get(window, "restoreTextDelete")());
  await page.reload(); await resume(page); await compare(page, "story", 2);
  await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(page).toHaveURL(item.story + "?saved=1");
  expect(await rows(page)).toHaveLength(0);
  expect((await db.execute("SELECT * FROM story_revisions")).rows).toHaveLength(1);
});

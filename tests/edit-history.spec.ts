import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { familyJourney, dbUrl, outbox, post } from "./support/family";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept } = familyJourney(db);
test.setTimeout(180_000);
test.beforeEach(async ({ request }) => {
  await db.batch(["story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  // Compile lazy routes before opening any editors (Fast Refresh can replace them).
  for (const path of ["/collections/prewarm/items/prewarm/details", "/collections/prewarm/items/prewarm/stories/prewarm/details", "/collections/prewarm/items/prewarm/photo-uploads", "/collections/prewarm/items/prewarm/photo-uploads/prewarm/finish"]) expect((await post(request, path, {})).status()).toBe(401);
  for (const path of ["/collections/prewarm/items/prewarm/history", "/collections/prewarm/items/prewarm/stories/prewarm/history"]) expect((await request.get(path, { maxRedirects: 0 })).status()).toBe(307);
  expect((await post(request, "/collections/prewarm/members/prewarm", {})).status()).toBe(303);
});
test.afterAll(() => db.close());
async function photo(request: APIRequestContext, collection: string) {
  const bytes = await readFile("tests/fixtures/photos/small.png"); const id = randomUUID();
  const begin = await post(request, collection + "/photo-uploads", { id, size: String(bytes.length) });
  expect(begin.status()).toBe(200);
  expect((await request.put((await begin.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  expect((await post(request, `${collection}/photo-uploads/${id}/finish`, {})).status()).toBe(200);
  return id;
}
async function family(page: Page) {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page); const id = await photo(page.request, collection); const path = `${collection}/items/${id}`;
  const storyteller = randomUUID();
  expect((await post(page.request, collection + "/people/records", { id: storyteller, name: "Sam", note: "Aunt" })).status()).toBe(200);
  const storyId = randomUUID();
  expect((await post(page.request, path + "/stories", { id: storyId, storyteller, text: "First recollection." })).status()).toBe(200);
  return { collection, id, path, storyteller, storyId, story: `${path}/stories/${storyId}` };
}
const itemEdit = (request: APIRequestContext, path: string, version: number, name: string, description = "A family bowl.", currentKeeper = "") => post(request, path + "/details", { version: String(version), name, description, currentKeeper });
const storyEdit = (request: APIRequestContext, path: string, version: number, text: string) => post(request, path + "/details", { version: String(version), text });
const itemRow = async () => (await db.execute("SELECT * FROM items")).rows[0];
const storyRow = async () => (await db.execute("SELECT * FROM stories")).rows[0];
const itemRevisions = async () => (await db.execute("SELECT * FROM item_revisions ORDER BY version")).rows;
const storyRevisions = async () => (await db.execute("SELECT * FROM story_revisions ORDER BY version")).rows;
async function recover(page: Page, path: string, version: number, kind: "item" | "story") {
  await page.goto(`${path}/history`);
  const popup = page.waitForEvent("popup");
  await page.getByRole("link", { name: `Review recovery of ${kind} version ${version} in a new tab`, exact: true }).click();
  const editor = await popup;
  await expect(editor.getByRole("button", { name: kind === "item" ? "Save item details" : "Save story changes", exact: true })).toBeEnabled();
  return editor;
}
async function save(page: Page, kind: "item" | "story") {
  // A popup may still emit its initial load; wait for confirmed-save navigation,
  // not whichever load event happens first.
  await Promise.all([page.waitForURL("**?saved=1"), page.getByRole("button", { name: kind === "item" ? "Save item details" : "Save story changes", exact: true }).click()]);
}

test("item history includes the initial draft and recovers details/keeper as a new edit without rewriting later versions", async ({ page }) => {
  const item = await family(page);
  expect((await itemEdit(page.request, item.path, 1, "Earlier name", "Earlier description", item.storyteller)).status()).toBe(200);
  expect((await itemEdit(page.request, item.path, 2, "Newest name")).status()).toBe(200);
  const before = await itemRevisions();
  const editor = await recover(page, item.path, 2, "item");
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("Earlier name");
  await expect(editor.getByLabel("Current keeper (optional)", { exact: true })).toHaveValue(item.storyteller);
  expect((await itemRow()).version).toBe(3); // opening/inspection has no write side effect
  await save(editor, "item");
  expect(await itemRow()).toMatchObject({ name: "Earlier name", description: "Earlier description", current_keeper_id: item.storyteller, version: 4, status: "complete" });
  expect((await itemRevisions()).slice(0, 2)).toEqual(before);
  expect((await itemRevisions())[2]).toMatchObject({ version: 3, name: "Newest name" });
  expect((await itemEdit(page.request, item.path, 4, "After recovery")).status()).toBe(200);
  await page.goto(item.path + "/history");
  expect(await page.getByRole("article").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label")))).toEqual([1, 2, 3, 4, 5].map(v => `Item version ${v}`));
  await expect(page.getByRole("article", { name: "Item version 1", exact: true })).toContainText("State: draft");
  const draft = await recover(page, item.path, 1, "item"); await save(draft, "item");
  expect(await itemRow()).toMatchObject({ name: "", description: "", current_keeper_id: null, version: 6, status: "draft" });
  expect((await draft.request.get(item.path + "/photo")).ok()).toBe(true);
});

test("members recover story text retaining historical storyteller labels and departed recorder/editor credit", async ({ page, browser }) => {
  const item = await family(page); const original = await storyRow();
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  expect((await storyEdit(relative.request, item.story, 1, "Relative's recollection elaborated.")).status()).toBe(200);
  expect((await storyEdit(page.request, item.story, 2, "Latest text.")).status()).toBe(200);
  expect((await post(page.request, `${item.collection}/people/${item.storyteller}/details`, { version: "1", name: "Samuel", note: "Renamed person" })).status()).toBe(200);
  const member = String((await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id);
  // The original recorder departs; another member can still recover and read credit.
  expect((await post(page.request, `${item.collection}/members/${member}`, { action: "promote" })).status()).toBe(303);
  expect((await post(relative.request, `${item.collection}/members/${original.recorded_by}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  const before = await storyRevisions();
  const editor = await recover(relative, item.story, 1, "story");
  await expect(editor.getByRole("article", { name: "Story version 1", exact: true })).toContainText("Storyteller: Sam — Aunt");
  await expect(editor.getByRole("article", { name: "Story version 1", exact: true })).toContainText("Originally recorded by founder@example.com");
  await expect(editor.getByRole("article", { name: "Story version 2", exact: true })).toContainText("Edited by relative@example.com");
  await save(editor, "story");
  expect(await storyRow()).toMatchObject({ version: 4, text: "First recollection.", storyteller_id: item.storyteller, storyteller_version: 1, recorded_by: original.recorded_by, recorded_at: original.recorded_at, last_edited_by: member });
  expect((await storyRevisions()).slice(0, 2)).toEqual(before);
  expect((await storyEdit(relative.request, item.story, 4, "Edited after recovery.")).status()).toBe(200);
  await relative.goto(item.story + "/history"); await expect(relative.getByRole("article")).toHaveCount(5);
  await context.close();
});

test("historical keeper labels remain stable while recovery validates a new assignment against current people", async ({ page }) => {
  const item = await family(page);
  expect((await itemEdit(page.request, item.path, 1, "With keeper", "Earlier description", item.storyteller)).status()).toBe(200);
  expect((await itemEdit(page.request, item.path, 2, "Without keeper")).status()).toBe(200);
  expect((await post(page.request, `${item.collection}/people/${item.storyteller}/details`, { version: "1", name: "Samuel", note: "New identifying note" })).status()).toBe(200);
  const editor = await recover(page, item.path, 2, "item");
  await expect(editor.getByRole("article", { name: "Item version 2", exact: true })).toContainText("Current keeper: Sam — Aunt");
  await expect(editor.getByLabel("Current keeper (optional)", { exact: true })).toContainText("Samuel — New identifying note");
  await save(editor, "item"); expect(await itemRow()).toMatchObject({ current_keeper_id: item.storyteller, current_keeper_version: 2 });
});

test("stale item and story recovery keeps attempted fields and requires explicit repeated reconciliation", async ({ page }) => {
  const item = await family(page);
  expect((await itemEdit(page.request, item.path, 1, "Recover this name")).status()).toBe(200);
  expect((await itemEdit(page.request, item.path, 2, "Second name")).status()).toBe(200);
  expect((await storyEdit(page.request, item.story, 1, "Second story.")).status()).toBe(200);
  for (const kind of ["item", "story"] as const) {
    const path = kind === "item" ? item.path : item.story; const baseVersion = kind === "item" ? 3 : 2;
    const editor = await recover(page, path, kind === "item" ? 2 : 1, kind);
    const field = editor.getByLabel(kind === "item" ? "Name" : "Story", { exact: true }); const attempted = await field.inputValue();
    const update = (version: number, text: string) => kind === "item" ? itemEdit(page.request, path, version, text) : storyEdit(page.request, path, version, text);
    for (const version of [baseVersion, baseVersion + 1]) {
      expect((await update(version, `Intervening ${version}`)).status()).toBe(200);
      await editor.getByRole("button", { name: kind === "item" ? "Save item details" : "Save story changes", exact: true }).click();
      await expect(field).toHaveValue(attempted);
      await editor.getByRole("button", { name: `Compare with latest saved ${kind}`, exact: true }).click();
      await expect(editor.getByRole("region", { name: `Latest saved ${kind}`, exact: true })).toContainText(`Intervening ${version}`);
      await editor.getByRole("button", { name: `Revise against version ${version + 1}`, exact: true }).click();
    }
    await save(editor, kind);
    expect(Number((kind === "item" ? await itemRow() : await storyRow()).version)).toBe(baseVersion + 3);
  }
});

test("history and recovery pages reject foreign collections/items/stories, signed-out access, and invalid version selectors", async ({ page, browser, request }) => {
  const item = await family(page);
  expect((await itemEdit(page.request, item.path, 1, "Private item name")).status()).toBe(200);
  expect((await storyEdit(page.request, item.story, 1, "Private story text")).status()).toBe(200);
  const other = await createCollection(page, "Another collection"); const otherItem = await photo(page.request, other);
  const context = await browser.newContext(); const outsider = await context.newPage(); await signIn(outsider, "outsider@example.com", true);
  for (const path of [item.path, item.story]) {
    for (const suffix of ["/history", "/history?recover=1"]) {
      expect((await request.get(path + suffix, { maxRedirects: 0 })).status()).toBe(307);
      const denied = await outsider.request.get(path + suffix); expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain("Private story text");
      const allowed = await page.request.get(path + suffix); expect(allowed.status()).toBe(200); expect(allowed.headers()["cache-control"]).toContain("no-store");
    }
    for (const selector of ["0", "-1", "1e0", "01", "2", "999", "9007199254740992", "1&recover=1"]) expect((await page.request.get(`${path}/history?recover=${selector}`)).status()).toBe(404);
  }
  for (const path of [`${other}/items/${item.id}`, `${other}/items/${otherItem}/stories/${item.storyId}`, item.path + "/stories/" + randomUUID()]) {
    expect((await page.request.get(path + "/history")).status()).toBe(404); expect((await page.request.get(path + "/history?recover=1")).status()).toBe(404);
  }
  await context.close();
});

test("access removal after opening recovery blocks final saves without losing input or changing history", async ({ page, browser }) => {
  const item = await family(page);
  expect((await itemEdit(page.request, item.path, 1, "Latest item")).status()).toBe(200);
  expect((await storyEdit(page.request, item.story, 1, "Latest story.")).status()).toBe(200);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const editors = [await recover(relative, item.path, 1, "item"), await recover(relative, item.story, 1, "story")];
  const member = String((await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id);
  const before = [await itemRow(), await storyRow(), await itemRevisions(), await storyRevisions()];
  expect((await post(page.request, `${item.collection}/members/${member}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  for (const [index, kind] of (["item", "story"] as const).entries()) {
    const editor = editors[index]; const field = editor.getByLabel(kind === "item" ? "Name" : "Story", { exact: true }); const text = await field.inputValue();
    await editor.getByRole("button", { name: kind === "item" ? "Save item details" : "Save story changes", exact: true }).click();
    await expect(editor.getByRole("main").getByRole("alert")).toContainText("unavailable"); await expect(field).toHaveValue(text);
    expect((await editor.request.get((kind === "item" ? item.path : item.story) + "/history")).status()).toBe(404);
  }
  expect([await itemRow(), await storyRow(), await itemRevisions(), await storyRevisions()]).toEqual(before);
  await context.close();
});

test("history does not resurrect inaccessible photo-less parents and recovery enforces current keeper scope", async ({ page }) => {
  const item = await family(page);
  expect((await itemEdit(page.request, item.path, 1, "Latest item")).status()).toBe(200);
  expect((await storyEdit(page.request, item.story, 1, "Latest story.")).status()).toBe(200);
  const before = [await itemRow(), await storyRow(), await itemRevisions(), await storyRevisions()];
  const other = await createCollection(page, "Other"); const foreign = randomUUID();
  expect((await post(page.request, other + "/people/records", { id: foreign, name: "Foreign keeper", note: "" })).status()).toBe(200);
  expect((await itemEdit(page.request, item.path, 2, "", "", foreign)).status()).toBe(400);
  // No record deletion exists yet. Simulate the existing inaccessible-parent
  // invariant, not a fictitious future deletion schema or restoration API.
  await db.execute({ sql: "UPDATE item_photos SET removed_at=1, removed_by=created_by WHERE item_id=?", args: [item.id] });
  for (const path of [item.path, item.story]) for (const suffix of ["/history", "/history?recover=1"]) expect((await page.request.get(path + suffix)).status()).toBe(404);
  expect((await itemEdit(page.request, item.path, 2, "", "")).status()).toBe(409);
  expect((await storyEdit(page.request, item.story, 2, "First recollection.")).status()).toBe(404);
  expect([await itemRow(), await storyRow(), await itemRevisions(), await storyRevisions()]).toEqual(before);
});

test("recovery errors retain text, uncertain success requires comparison, and unchanged content creates no duplicate history", async ({ page }) => {
  const item = await family(page); expect((await storyEdit(page.request, item.story, 1, "Latest story.")).status()).toBe(200);
  const editor = await recover(page, item.story, 1, "story");
  await db.execute("CREATE TRIGGER fail_history_recovery BEFORE UPDATE ON stories BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END");
  try {
    await editor.getByRole("button", { name: "Save story changes", exact: true }).click();
    await expect(editor.getByRole("main").getByRole("alert")).toContainText("Save was not confirmed");
    await expect(editor.getByLabel("Story", { exact: true })).toHaveValue("First recollection.");
    expect((await storyRow()).version).toBe(2); expect(await storyRevisions()).toHaveLength(1);
  } finally { await db.execute("DROP TRIGGER fail_history_recovery"); }
  await editor.route("**/details", async route => { await route.fetch(); await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }); }, { times: 1 });
  await editor.getByRole("button", { name: "Save story changes", exact: true }).click();
  await expect(editor.getByRole("main").getByRole("alert")).toContainText("Save was not confirmed");
  expect((await storyRow()).version).toBe(3);
  await editor.getByRole("button", { name: "Save story changes", exact: true }).click();
  await editor.getByRole("button", { name: "Compare with latest saved story", exact: true }).click();
  await editor.getByRole("button", { name: "Revise against version 3", exact: true }).click();
  await save(editor, "story"); expect((await storyRow()).version).toBe(3); expect(await storyRevisions()).toHaveLength(2);
  const again = await recover(page, item.story, 1, "story"); await save(again, "story"); expect((await storyRow()).version).toBe(3); expect(await storyRevisions()).toHaveLength(2);
});

test("history is escaped and mobile/keyboard usable, and history links preserve the original unsaved editor", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const item = await family(page); const text = '<script>window.historyExecuted=true</script>\n' + "W".repeat(4000);
  expect((await storyEdit(page.request, item.story, 1, text)).status()).toBe(200);
  expect((await storyEdit(page.request, item.story, 2, "Latest text.")).status()).toBe(200);
  await page.goto(item.story); await expect(page.getByLabel("Story", { exact: true })).toBeEnabled();
  await page.getByLabel("Story", { exact: true }).fill("Unsaved original editor text.");
  const popup = page.waitForEvent("popup"); await page.getByRole("link", { name: "Inspect story edit history in a new tab", exact: true }).click(); const history = await popup;
  // New tabs inherit the context viewport, not page.setViewportSize on the opener.
  await history.setViewportSize({ width: 375, height: 812 });
  await expect(history.getByRole("article", { name: "Story version 2", exact: true })).toContainText(text);
  expect(await history.evaluate(() => "historyExecuted" in window)).toBe(false);
  expect(await history.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const recovery = history.waitForEvent("popup"); await history.getByRole("link", { name: "Review recovery of story version 2 in a new tab", exact: true }).focus(); await history.keyboard.press("Enter"); const editor = await recovery;
  await editor.setViewportSize({ width: 375, height: 812 });
  await expect(editor.getByLabel("Story", { exact: true })).toHaveValue(text);
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue("Unsaved original editor text.");
  await save(editor, "story"); expect((await storyRow()).text).toBe(text);
});

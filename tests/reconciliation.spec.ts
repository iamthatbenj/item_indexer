import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { familyJourney, dbUrl, outbox, origin, post, operatorEnv } from "./support/family";
import { removeStoryRevisionsSchema } from "./support/legacy-database";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept } = familyJourney(db);
test.setTimeout(180_000);
test.beforeEach(async ({ request }) => {
  await db.batch(["story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  for (const path of ["/collections/prewarm/items/prewarm/details", "/collections/prewarm/items/prewarm/stories/prewarm/details", "/collections/prewarm/items/prewarm/photo-uploads", "/collections/prewarm/items/prewarm/photo-uploads/prewarm/finish", "/collections/prewarm/items/prewarm/photos/prewarm"]) expect((await post(request, path, {})).status()).toBe(401);
  expect((await post(request, "/collections/prewarm/members/prewarm", {})).status()).toBe(303);
});
test.afterAll(() => db.close());
async function photo(request: APIRequestContext, path: string) {
  const bytes = await readFile("tests/fixtures/photos/small.png"); const id = randomUUID();
  const begin = await post(request, path + "/photo-uploads", { id, size: String(bytes.length) });
  expect(begin.status()).toBe(200);
  expect((await request.put((await begin.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  expect((await post(request, `${path}/photo-uploads/${id}/finish`, {})).status()).toBe(200);
  return id;
}
async function family(page: Page) {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page); const id = await photo(page.request, collection); const path = `${collection}/items/${id}`;
  const storyteller = randomUUID();
  expect((await post(page.request, collection + "/people/records", { id: storyteller, name: "Sam", note: "Aunt on Dad’s side" })).status()).toBe(200);
  const storyId = randomUUID(); const text = "I remember this bowl at Sunday lunch.";
  expect((await post(page.request, path + "/stories", { id: storyId, storyteller, text })).status()).toBe(200);
  return { collection, id, path, storyteller, storyId, story: `${path}/stories/${storyId}` };
}
const storyRow = async (id: string) => (await db.execute({ sql: "SELECT id, item_id, text, version, storyteller_id, storyteller_version, recorded_by, recorded_at, last_edited_by, updated_at, creation_hash FROM stories WHERE id=?", args: [id] })).rows[0];
const storyHistory = async (id: string) => (await db.execute({ sql: "SELECT * FROM story_revisions WHERE story_id=? ORDER BY version", args: [id] })).rows;
const itemRow = async (id: string) => (await db.execute({ sql: "SELECT * FROM items WHERE id=?", args: [id] })).rows[0];
const storyEdit = (request: APIRequestContext, path: string, version: string, text: string, extra: Record<string, string> = {}) => post(request, path + "/details", { version, text, ...extra });
const itemEdit = (request: APIRequestContext, path: string, version: string, name: string, description = "A family bowl.", currentKeeper = "") => post(request, path + "/details", { version, name, description, currentKeeper });
async function openStory(page: Page, path: string) {
  await page.goto(path); await expect(page.getByLabel("Story", { exact: true })).toBeEnabled({ timeout: 30_000 });
}
async function saveStory(page: Page, text: string) {
  await page.getByLabel("Story", { exact: true }).fill(text);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Save story changes", exact: true }).click()]);
  await expect(page.getByRole("status")).toHaveText("Story changes saved.");
}
async function compare(page: Page, kind: "item" | "story", version: number) {
  await page.getByRole("button", { name: `Compare with latest saved ${kind}`, exact: true }).click();
  await expect(page.getByRole("region", { name: `Latest saved ${kind}`, exact: true })).toContainText(`version ${version}`);
}

test("members edit another member’s story while retaining original storyteller, recorder and each prior editor", async ({ page, browser }) => {
  const item = await family(page); const original = await storyRow(item.storyId); const beforeItem = await itemRow(item.id);
  const sibling = randomUUID(); expect((await post(page.request, item.path + "/stories", { id: sibling, storyteller: item.storyteller, text: "A different recollection." })).status()).toBe(200);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await openStory(relative, item.story); await expect(relative.locator(".story-attribution").first()).toContainText("Sam — Aunt on Dad’s side");
  await saveStory(relative, "  A member elaborated on the original memory.  ");
  const member = String((await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id);
  expect(await storyRow(item.storyId)).toMatchObject({ text: "A member elaborated on the original memory.", version: 2, recorded_by: original.recorded_by, recorded_at: original.recorded_at, storyteller_id: original.storyteller_id, storyteller_version: 1, last_edited_by: member });
  expect((await storyHistory(item.storyId))[0]).toMatchObject({ story_id: item.storyId, version: 1, text: original.text, storyteller_id: original.storyteller_id, storyteller_version: 1, recorded_by: original.recorded_by, recorded_at: original.recorded_at, edited_by: original.last_edited_by, edited_at: original.updated_at });
  expect((await post(page.request, `${item.collection}/people/${item.storyteller}/details`, { version: "1", name: "Samuel", note: "Aunt" })).status()).toBe(200);
  expect((await storyEdit(page.request, item.story, "2", "Founder made a correction.", { storyteller: randomUUID(), storyteller_version: "900", recorded_by: "forged", recorded_at: "0", last_edited_by: "forged" })).status()).toBe(200);
  const history = await storyHistory(item.storyId); expect(history.map(row => row.version)).toEqual([1, 2]);
  expect(history[1]).toMatchObject({ edited_by: member, storyteller_id: item.storyteller, storyteller_version: 1, recorded_by: original.recorded_by });
  expect(history[0].id).not.toBe(history[1].id);
  expect(await storyRow(item.storyId)).toMatchObject({ storyteller_id: item.storyteller, storyteller_version: 1, recorded_by: original.recorded_by, recorded_at: original.recorded_at, last_edited_by: original.recorded_by, version: 3 });
  expect(await itemRow(item.id)).toEqual(beforeItem); expect((await storyRow(sibling)).text).toBe("A different recollection.");
  await relative.goto(item.path); await expect(relative.getByRole("article").filter({ hasText: "Founder made a correction." })).toContainText("Last edited by founder@example.com");
  await context.close();
});

test("two item editors compare text and keeper, deliberately rebase, survive refresh and reconcile another intervening edit", async ({ page, browser }) => {
  const item = await family(page); await photo(page.request, item.path);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await relative.goto(item.path); await expect(relative.getByLabel("Name", { exact: true })).toBeEnabled();
  await relative.getByLabel("Name", { exact: true }).fill("My attempted name"); await relative.getByLabel("Short description", { exact: true }).fill("My attempted description.");
  expect((await itemEdit(page.request, item.path, "1", "Their newer name", "Their newer description.", item.storyteller)).status()).toBe(200);
  await relative.getByRole("button", { name: "Save item details", exact: true }).click(); await expect(relative.getByRole("button", { name: "Save item details", exact: true })).toBeDisabled();
  await compare(relative, "item", 2);
  const latest = relative.getByRole("region", { name: "Latest saved item", exact: true });
  await expect(latest).toContainText("Their newer name"); await expect(latest).toContainText("Their newer description."); await expect(latest).toContainText("Sam — Aunt on Dad’s side");
  await expect(relative.getByRole("region", { name: "Your current draft", exact: true })).toContainText("My attempted name");
  await relative.getByRole("button", { name: "Close comparison", exact: true }).click();
  await expect(relative.getByLabel("Name", { exact: true })).toHaveValue("My attempted name"); await expect(relative.locator('input[name="version"]')).toHaveValue("1");
  await compare(relative, "item", 2); await relative.getByRole("button", { name: "Revise against version 2", exact: true }).click();
  await expect(relative.getByLabel("Name", { exact: true })).toBeFocused(); await expect(relative.getByLabel("Name", { exact: true })).toHaveValue("My attempted name");
  expect((await itemEdit(page.request, item.path, "2", "Another intervening name", "Newest description.", item.storyteller)).status()).toBe(200);
  await relative.getByRole("button", { name: "Remove photo 2", exact: true }).click(); await expect(relative.locator(".item-view")).toHaveCount(1);
  await expect(relative.locator('input[name="version"]')).toHaveValue("2"); // refreshed props must not silently rebase
  await relative.getByRole("button", { name: "Save item details", exact: true }).click(); await compare(relative, "item", 3);
  await expect(relative.getByRole("region", { name: "Latest saved item", exact: true })).toContainText("Another intervening name");
  await relative.getByRole("button", { name: "Revise against version 3", exact: true }).click();
  await relative.getByLabel("Name", { exact: true }).fill("Deliberately reconciled name"); await relative.getByLabel("Short description", { exact: true }).fill("Both contributions reviewed.");
  await relative.getByLabel("Current keeper (optional)", { exact: true }).selectOption(item.storyteller);
  await Promise.all([relative.waitForEvent("load"), relative.getByRole("button", { name: "Save item details", exact: true }).click()]);
  expect(await itemRow(item.id)).toMatchObject({ name: "Deliberately reconciled name", description: "Both contributions reviewed.", current_keeper_id: item.storyteller, version: 4 });
  expect((await db.execute("SELECT version, name FROM item_revisions ORDER BY version")).rows.map(row => row.name)).toEqual(["", "Their newer name", "Another intervening name"]);
  await context.close();
});

test("two story editors reconcile repeated conflicts without discarding attempted text or previous persisted versions", async ({ page, browser }) => {
  const item = await family(page); const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await openStory(relative, item.story); await relative.getByLabel("Story", { exact: true }).fill("My attempted story.");
  await openStory(page, item.story); await saveStory(page, "The other member saved first.");
  await relative.getByRole("button", { name: "Save story changes", exact: true }).click(); await compare(relative, "story", 2);
  await expect(relative.getByRole("region", { name: "Latest saved story", exact: true })).toContainText("The other member saved first.");
  await expect(relative.getByRole("region", { name: "Your current draft", exact: true })).toContainText("My attempted story.");
  await relative.getByRole("button", { name: "Revise against version 2", exact: true }).click();
  await expect(relative.getByLabel("Story", { exact: true })).toBeFocused();
  await saveStory(page, "A third version arrived during review.");
  await relative.getByLabel("Story", { exact: true }).fill("My revision after reading the comparison.");
  await relative.getByRole("button", { name: "Save story changes", exact: true }).click(); await compare(relative, "story", 3);
  await expect(relative.getByLabel("Story", { exact: true })).toHaveValue("My revision after reading the comparison.");
  await relative.getByRole("button", { name: "Revise against version 3", exact: true }).click(); await saveStory(relative, "Deliberately reconciled recollection.");
  expect(await storyRow(item.storyId)).toMatchObject({ text: "Deliberately reconciled recollection.", version: 4, storyteller_id: item.storyteller });
  expect((await storyHistory(item.storyId)).map(row => row.text)).toEqual(["I remember this bowl at Sunday lunch.", "The other member saved first.", "A third version arrived during review."]);
  await context.close();
});

test("competing story writes serialize; no-ops create no history and stale equal text still conflicts", async ({ page, browser }) => {
  const item = await family(page); const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const results = await Promise.all([storyEdit(page.request, item.story, "1", "Founder edit."), storyEdit(relative.request, item.story, "1", "Relative edit.")]);
  expect(results.map(result => result.status()).sort()).toEqual([200, 409]);
  const saved = await storyRow(item.storyId); expect(saved.version).toBe(2); expect(await storyHistory(item.storyId)).toHaveLength(1);
  const winnerEmail = results[0].status() === 200 ? "founder@example.com" : "relative@example.com";
  expect(saved.last_edited_by).toBe((await db.execute({ sql: "SELECT id FROM accounts WHERE email=?", args: [winnerEmail] })).rows[0].id);
  expect((await storyEdit(page.request, item.story, "1", String(saved.text))).status()).toBe(409);
  expect((await storyEdit(page.request, item.story, "2", String(saved.text))).status()).toBe(200);
  expect(await storyRow(item.storyId)).toEqual(saved); expect(await storyHistory(item.storyId)).toHaveLength(1);
  await context.close();
});

test("comparison reads and story edits enforce collection, item, story and active-photo scope", async ({ page, browser, request }) => {
  const item = await family(page); const other = await createCollection(page, "Other family"); const otherItem = await photo(page.request, other);
  for (const path of [`${other}/items/${item.id}/stories/${item.storyId}`, `${other}/items/${otherItem}/stories/${item.storyId}`, item.path + "/stories/" + randomUUID()]) {
    expect((await page.request.get(path)).status()).toBe(404); expect((await page.request.get(path + "/details")).status()).toBe(404);
    expect((await storyEdit(page.request, path, "1", "Injected.")).status()).toBe(404);
  }
  const context = await browser.newContext(); const outsider = await context.newPage(); await signIn(outsider, "outsider@example.com", true);
  for (const path of [item.path + "/details", item.story + "/details"]) {
    const denied = await outsider.request.get(path); expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain("Sunday lunch");
    expect((await request.get(path)).status()).toBe(401);
    const allowed = await page.request.get(path); expect(allowed.status()).toBe(200); expect(allowed.headers()["cache-control"]).toContain("no-store");
  }
  expect((await outsider.request.get(item.story)).status()).toBe(404); expect((await request.get(item.story, { maxRedirects: 0 })).status()).toBe(307);
  expect((await storyEdit(outsider.request, item.story, "1", "Unauthorized.")).status()).toBe(404); expect((await storyEdit(request, item.story, "1", "Anonymous.")).status()).toBe(401);
  await db.execute({ sql: "UPDATE item_photos SET removed_at=1, removed_by=created_by WHERE item_id=?", args: [item.id] });
  expect((await storyEdit(page.request, item.story, "1", "Photo-less edit.")).status()).toBe(404);
  expect((await page.request.get(item.story + "/details")).status()).toBe(404); expect((await page.request.get(item.path + "/details")).status()).toBe(404);
  expect(await storyHistory(item.storyId)).toHaveLength(0);
  await context.close();
});

test("removing access after review blocks the final item/story save but preserves drafts, histories and credit", async ({ page, browser }) => {
  const item = await family(page); const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); const itemTab = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await openStory(relative, item.story); await itemTab.goto(item.path); await expect(itemTab.getByLabel("Name", { exact: true })).toBeEnabled();
  await relative.getByLabel("Story", { exact: true }).fill("Keep my story after access removal."); await itemTab.getByLabel("Name", { exact: true }).fill("Keep my item after access removal.");
  expect((await storyEdit(page.request, item.story, "1", "Another story version.")).status()).toBe(200); expect((await itemEdit(page.request, item.path, "1", "Another item version")).status()).toBe(200);
  await relative.getByRole("button", { name: "Save story changes", exact: true }).click(); await itemTab.getByRole("button", { name: "Save item details", exact: true }).click();
  await compare(relative, "story", 2); await compare(itemTab, "item", 2);
  await relative.getByRole("button", { name: "Revise against version 2", exact: true }).click(); await itemTab.getByRole("button", { name: "Revise against version 2", exact: true }).click();
  const before = await storyRow(item.storyId); const history = await storyHistory(item.storyId); const beforeItem = await itemRow(item.id);
  const member = String((await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id);
  expect((await post(page.request, `${item.collection}/members/${member}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  await relative.getByRole("button", { name: "Save story changes", exact: true }).click(); await itemTab.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(relative.getByRole("main").getByRole("alert")).toContainText("unavailable"); await expect(itemTab.getByRole("main").getByRole("alert")).toContainText("unavailable");
  await expect(relative.getByLabel("Story", { exact: true })).toHaveValue("Keep my story after access removal."); await expect(itemTab.getByLabel("Name", { exact: true })).toHaveValue("Keep my item after access removal.");
  expect((await relative.request.get(item.story + "/details")).status()).toBe(404); expect((await relative.request.get(item.path + "/details")).status()).toBe(404);
  expect(await storyRow(item.storyId)).toEqual(before); expect(await storyHistory(item.storyId)).toEqual(history); expect(await itemRow(item.id)).toEqual(beforeItem);
  await context.close();
});

test("failed or malformed comparisons and closing review never advance versions or replace input", async ({ page }) => {
  const item = await family(page); await openStory(page, item.story); await page.getByLabel("Story", { exact: true }).fill("My preserved draft.");
  expect((await storyEdit(page.request, item.story, "1", "Saved competitor.")).status()).toBe(200);
  await page.getByRole("button", { name: "Save story changes", exact: true }).click();
  for (const body of ["{}", JSON.stringify({ current: { version: 2, fields: [] } })]) {
    await page.route("**/details", async route => { if (route.request().method() === "GET") { await route.fetch(); await route.fulfill({ status: 200, contentType: "application/json", body }); } else await route.continue(); }, { times: 1 });
    await page.getByRole("button", { name: "Compare with latest saved story", exact: true }).click();
    await expect(page.getByRole("region", { name: "Compare story edits", exact: true }).getByRole("alert")).toContainText("could not be loaded");
    await expect(page.getByLabel("Story", { exact: true })).toHaveValue("My preserved draft."); await expect(page.getByRole("button", { name: "Save story changes", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Revise against version/ })).toHaveCount(0);
  }
  await compare(page, "story", 2); await page.getByRole("button", { name: "Close comparison", exact: true }).click();
  await expect(page.getByRole("region", { name: "Edit this recollection", exact: true })).toContainText("editing version 1");
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue("My preserved draft.");
  await compare(page, "story", 2); await page.getByRole("button", { name: "Revise against version 2", exact: true }).click();
  await saveStory(page, "My preserved draft."); expect((await storyRow(item.storyId)).version).toBe(3);
});

test("revision and current-story failures roll back together and permit a deliberate retry", async ({ page }) => {
  const item = await family(page); const original = await storyRow(item.storyId);
  for (const operation of ["INSERT ON story_revisions", "UPDATE ON stories"]) {
    await db.execute(`CREATE TRIGGER fail_story_edit BEFORE ${operation} BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END`);
    try {
      const failed = await storyEdit(page.request, item.story, "1", "Attempted edit."); expect(failed.status()).toBe(503); expect(await failed.text()).not.toContain("private diagnostic");
      expect(await storyRow(item.storyId)).toEqual(original); expect(await storyHistory(item.storyId)).toHaveLength(0);
    } finally { await db.execute("DROP TRIGGER fail_story_edit"); }
  }
  await openStory(page, item.story); await page.getByLabel("Story", { exact: true }).fill("Preserve browser input.");
  await db.execute("CREATE TRIGGER fail_story_edit BEFORE UPDATE ON stories BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END");
  try {
    await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("Save was not confirmed");
    await expect(page.getByLabel("Story", { exact: true })).toHaveValue("Preserve browser input.");
  } finally { await db.execute("DROP TRIGGER fail_story_edit"); }
  await saveStory(page, "Preserve browser input."); expect(await storyHistory(item.storyId)).toHaveLength(1);
});

test("a lost edit acknowledgement requires review without duplicate history, and a create retry never rewinds edited text", async ({ page }) => {
  const item = await family(page); await openStory(page, item.story);
  await page.route("**/details", async route => { await route.fetch(); await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }); }, { times: 1 });
  await page.getByLabel("Story", { exact: true }).fill("Committed but acknowledgement lost."); await page.getByRole("button", { name: "Save story changes", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Save was not confirmed"); expect((await storyRow(item.storyId)).version).toBe(2);
  await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await compare(page, "story", 2);
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue("Committed but acknowledgement lost.");
  await page.getByRole("button", { name: "Revise against version 2", exact: true }).click(); await saveStory(page, "Committed but acknowledgement lost.");
  expect(await storyHistory(item.storyId)).toHaveLength(1); expect((await storyRow(item.storyId)).version).toBe(2);
  expect((await post(page.request, item.path + "/stories", { id: item.storyId, storyteller: item.storyteller, text: "I remember this bowl at Sunday lunch." })).status()).toBe(200);
  expect((await storyRow(item.storyId)).text).toBe("Committed but acknowledgement lost.");
});

test("story edit forms enforce bounds, unique fields, origin and valid versions while supporting full-length Unicode", async ({ page }) => {
  const item = await family(page); const url = item.story + "/details";
  expect((await page.request.post(url, { form: { version: "1", text: "Bad origin" }, headers: { Origin: "https://foreign.invalid" } })).status()).toBe(403);
  expect((await page.request.post(url, { form: { version: "1", text: "Missing origin" } })).status()).toBe(403);
  expect((await page.request.post(url, { data: { version: "1", text: "Wrong encoding" }, headers: { Origin: origin } })).status()).toBe(415);
  expect((await storyEdit(page.request, item.story, "1", "x".repeat(100_000))).status()).toBe(413);
  for (const version of ["0", "-1", "1.0", "1e0", "NaN", "9007199254740991"]) expect((await storyEdit(page.request, item.story, version, "Bad version")).status()).toBe(400);
  for (const text of [" \n\t ", "null\0text", "x".repeat(10_001)]) expect((await storyEdit(page.request, item.story, "1", text)).status()).toBe(400);
  for (const body of ["version=1", "text=memory", "version=1&version=1&text=memory", "version=1&text=memory&text=another"]) expect((await page.request.post(url, { data: body, headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(400);
  expect(await storyHistory(item.storyId)).toHaveLength(0);
  expect((await storyEdit(page.request, item.story, "1", "界".repeat(10_000))).status()).toBe(200); expect(String((await storyRow(item.storyId)).text)).toHaveLength(10_000);
});

test("populated version-seven upgrade retains story attribution, files and sessions and rejects migration failure without recording it", async ({ page }) => {
  const item = await family(page);
  const tables = ["stories", "items", "item_photos", "people", "sessions", "memberships", "accounts"];
  const before = await Promise.all(tables.map(async table => (await db.execute(`SELECT * FROM ${table}`)).rows));
  await removeStoryRevisionsSchema(db); await db.execute("CREATE TABLE story_revisions (marker TEXT)");
  try {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv })).toThrow();
    expect((await db.execute("SELECT name FROM schema_migrations")).rows).toHaveLength(7);
    expect(await Promise.all(tables.map(async table => (await db.execute(`SELECT * FROM ${table}`)).rows))).toEqual(before);
  } finally { await db.execute("DROP TABLE story_revisions"); }
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect(await Promise.all(tables.map(async table => (await db.execute(`SELECT * FROM ${table}`)).rows))).toEqual(before);
  expect(await storyHistory(item.storyId)).toHaveLength(0);
  expect((await storyEdit(page.request, item.story, "1", "First edit after upgrade.")).status()).toBe(200);
  const history = await storyHistory(item.storyId); expect(history[0]).toMatchObject({ text: "I remember this bowl at Sunday lunch.", storyteller_id: item.storyteller, recorded_by: before[0][0].recorded_by, edited_by: before[0][0].last_edited_by });
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect(await storyHistory(item.storyId)).toEqual(history); expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0); expect((await db.execute("SELECT name FROM schema_migrations")).rows).toHaveLength(8);
  const retained = await page.request.get(item.path + "/photo"); expect(retained.ok()).toBe(true); expect(retained.headers()["content-type"]).toBe("image/jpeg");
});

test("long story comparisons are escaped, mobile-width and keyboard usable without losing focus or text", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const item = await family(page); await openStory(page, item.story);
  const attempted = '<script>window.reconciliationExecuted=true</script>\n' + "W".repeat(2000);
  await page.getByLabel("Story", { exact: true }).fill(attempted);
  expect((await storyEdit(page.request, item.story, "1", "N".repeat(4000))).status()).toBe(200);
  await page.getByRole("button", { name: "Save story changes", exact: true }).click(); await compare(page, "story", 2);
  await expect(page.getByRole("region", { name: "Your current draft", exact: true })).toContainText("<script>");
  expect(await page.evaluate(() => "reconciliationExecuted" in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.getByRole("button", { name: "Revise against version 2", exact: true }).focus(); await page.keyboard.press("Enter");
  await expect(page.getByLabel("Story", { exact: true })).toBeFocused(); await expect(page.getByLabel("Story", { exact: true })).toHaveValue(attempted);
  await saveStory(page, attempted); expect((await storyRow(item.storyId)).text).toBe(attempted);
});

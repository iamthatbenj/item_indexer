import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { familyJourney, dbUrl, outbox, origin, post, operatorEnv } from "./support/family";
import { removeStoriesSchema } from "./support/legacy-database";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept } = familyJourney(db);
test.setTimeout(150_000);
test.beforeEach(async ({ request }) => {
  await db.batch(["stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  expect((await post(request, "/collections/prewarm/items/prewarm/stories", {})).status()).toBe(401);
  expect((await post(request, "/collections/prewarm/members/prewarm", {})).status()).toBe(303);
});
test.afterAll(() => db.close());
async function family(page: Page) {
  await signIn(page, "founder@example.com", true);
  return draft(page.request, await createCollection(page));
}
async function draft(request: APIRequestContext, collection: string) {
  const bytes = await readFile("tests/fixtures/photos/small.png"); const id = randomUUID();
  const begin = await post(request, collection + "/photo-uploads", { id, size: String(bytes.length) });
  expect(begin.status()).toBe(200);
  expect((await request.put((await begin.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  expect((await post(request, `${collection}/photo-uploads/${id}/finish`, {})).status()).toBe(200);
  return { id, collection, path: `${collection}/items/${id}` };
}
async function person(request: APIRequestContext, collection: string, name = "Sam", note = "Aunt on Dad’s side") {
  const id = randomUUID();
  expect((await post(request, collection + "/people/records", { id, name, note })).status()).toBe(200);
  return id;
}
const record = (request: APIRequestContext, path: string, storyteller: string, text = "I remember this bowl at Sunday lunch.", id = randomUUID(), extra: Record<string, string> = {}) => post(request, path + "/stories", { id, storyteller, text, ...extra });
const rows = async () => (await db.execute("SELECT id, item_id, storyteller_id, storyteller_version, text, version, recorded_by, recorded_at, last_edited_by, updated_at FROM stories ORDER BY recorded_at, id")).rows;
async function openForm(page: Page, path: string) {
  await page.goto(path + "/stories/new");
  await expect(page.getByLabel("Storyteller", { exact: true })).toBeEnabled({ timeout: 30_000 });
}
async function submit(page: Page, storyteller: string, text: string) {
  await page.getByLabel("Storyteller", { exact: true }).selectOption(storyteller);
  await page.getByLabel("Story", { exact: true }).fill(text);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Record story", exact: true }).click()]);
  await expect(page.getByRole("status")).toContainText("Story recorded.");
}

test("an ordinary member records a non-member storyteller separately from the recording identity, with durable initial attribution", async ({ page, browser }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const accounts = (await db.execute("SELECT id, email FROM accounts ORDER BY id")).rows;
  const originalItem = (await db.execute("SELECT * FROM items")).rows;
  await openForm(relative, item.path); await submit(relative, storyteller, "  Gran gave it to Sam.\nWe used it every Sunday.  ");
  const story = relative.getByRole("article");
  await expect(story).toContainText("Recollection from Sam — Aunt on Dad’s side");
  await expect(story).toContainText("Recorded by relative@example.com");
  await expect(story.locator(".story-text")).toHaveText("Gran gave it to Sam.\nWe used it every Sunday.");
  const saved = (await rows())[0];
  expect(saved).toMatchObject({ item_id: item.id, storyteller_id: storyteller, storyteller_version: 1, version: 1, recorded_by: accounts.find(account => account.email === "relative@example.com")!.id });
  expect(saved.last_edited_by).toBe(saved.recorded_by); expect(saved.updated_at).toBe(saved.recorded_at);
  expect((await db.execute("SELECT * FROM items")).rows).toEqual(originalItem);
  expect((await db.execute("SELECT id, email FROM accounts ORDER BY id")).rows).toEqual(accounts);
  await page.goto(item.path); await expect(page.getByRole("article")).toContainText("Gran gave it to Sam.");
  await context.close();
});

test("contradictory same-name recollections coexist without verification or editorial priority; stories remain optional", async ({ page }) => {
  const item = await family(page);
  const first = await person(page.request, item.collection); const second = await person(page.request, item.collection, "Sam", "Cousin in Bristol");
  await page.goto(item.path);
  await expect(page.getByText("No stories recorded yet. Stories are optional for item completion.")).toBeVisible();
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Bowl", description: "Blue ceramic bowl." })).status()).toBe(200);
  await openForm(page, item.path); await submit(page, first, "It was a wedding present in 1950.");
  await openForm(page, item.path); await submit(page, second, "It was bought on holiday in 1975, not a wedding present.");
  await expect(page.getByRole("article")).toHaveCount(2);
  await expect(page.getByRole("article").filter({ hasText: "Aunt on Dad’s side" })).toContainText("1950");
  await expect(page.getByRole("article").filter({ hasText: "Cousin in Bristol" })).toContainText("1975");
  await expect(page.getByText("Separate recollections may disagree; none is automatically the verified account.")).toBeVisible();
  expect((await db.execute("SELECT status, version FROM items")).rows[0]).toMatchObject({ status: "complete", version: 2 });
  expect(await rows()).toHaveLength(2);
});

test("optional prompts are guidance only and refreshing people preserves selected attribution and free text", async ({ page }) => {
  const item = await family(page); const first = await person(page.request, item.collection);
  // Compile the separate form before testing preserved input in the dev server.
  expect((await page.request.get(item.path + "/stories/new")).status()).toBe(200);
  await page.goto(item.path);
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel("Name", { exact: true }).fill("Unsaved item name stays here");
  const opened = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Record a story in a new tab" }).click();
  const separate = await opened;
  await expect(separate.getByLabel("Story", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Unsaved item name stays here");
  await separate.close();
  await openForm(page, item.path);
  await page.getByText("Optional ideas for your story", { exact: true }).click();
  for (const prompt of ["Origins:", "Earlier keepers:", "Memories:", "Sentimental meaning:"]) await expect(page.locator("details li").filter({ hasText: prompt })).toBeVisible();
  await page.getByLabel("Storyteller", { exact: true }).selectOption(first);
  await page.getByLabel("Story", { exact: true }).fill("Just one natural recollection, no questionnaire.");
  const newPerson = await person(page.request, item.collection, "Pat", "Not an app member");
  await page.getByRole("button", { name: "Refresh storyteller choices" }).click();
  await expect(page.getByRole("status")).toContainText("unchanged");
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue("Just one natural recollection, no questionnaire.");
  await expect(page.getByLabel("Storyteller", { exact: true })).toHaveValue(first);
  await expect(page.locator(`option[value="${newPerson}"]`)).toHaveCount(1);
  await submit(page, newPerson, "Just one natural recollection, no questionnaire.");
  expect((await rows())[0].text).toBe("Just one natural recollection, no questionnaire.");
});

test("renaming storytellers preserves stable identity and the identifying version at recording", async ({ page }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection);
  expect((await record(page.request, item.path, storyteller)).status()).toBe(200);
  const original = await rows();
  expect((await post(page.request, `${item.collection}/people/${storyteller}/details`, { version: "1", name: "Samuel", note: "Updated identifying note" })).status()).toBe(200);
  await page.goto(item.path); await expect(page.getByRole("article")).toContainText("Samuel — Updated identifying note");
  expect(await rows()).toEqual(original);
  expect((await db.execute("SELECT name, note, version FROM person_revisions")).rows[0]).toMatchObject({ name: "Sam", note: "Aunt on Dad’s side", version: 1 });
});

test("story reads and writes reject unrelated collections, reference substitution and anonymous visitors", async ({ page, browser, request }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection);
  expect((await record(page.request, item.path, storyteller, "Private recollection unique to this family.")).status()).toBe(200);
  const other = await createCollection(page, "Other family"); const foreignPerson = await person(page.request, other, "Other relative");
  expect((await record(page.request, item.path, foreignPerson)).status()).toBe(400); // actor belongs to both
  expect((await record(page.request, `${other}/items/${item.id}`, storyteller)).status()).toBe(404);
  const context = await browser.newContext(); const outsider = await context.newPage();
  await signIn(outsider, "outsider@example.com", true);
  for (const path of [item.path, item.path + "/stories/new"]) {
    const denied = await outsider.request.get(path); expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain("Private recollection unique");
    expect((await request.get(path, { maxRedirects: 0 })).status()).toBe(307);
  }
  expect((await record(outsider.request, item.path, storyteller)).status()).toBe(404);
  expect((await record(request, item.path, storyteller)).status()).toBe(401);
  expect((await record(page.request, item.path, randomUUID())).status()).toBe(400);
  expect(await rows()).toHaveLength(1);
  await db.execute("UPDATE item_photos SET removed_at=1, removed_by=created_by"); // Inject an invalid photo-less item; public removal prevents this.
  expect((await record(page.request, item.path, storyteller)).status()).toBe(404);
  expect((await page.request.get(item.path + "/stories/new")).status()).toBe(404);
  expect(await rows()).toHaveLength(1);
  await context.close();
});

test("membership removal denies a stale story form but retains earlier stories, storyteller and recorder identity", async ({ page, browser }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  expect((await record(relative.request, item.path, storyteller)).status()).toBe(200);
  const original = await rows(); const recorder = String(original[0].recorded_by);
  await openForm(relative, item.path);
  await relative.getByLabel("Storyteller", { exact: true }).selectOption(storyteller); await relative.getByLabel("Story", { exact: true }).fill("Keep my unsaved recollection.");
  expect((await post(page.request, `${item.collection}/members/${recorder}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  await relative.getByRole("button", { name: "Record story", exact: true }).click();
  await expect(relative.getByRole("main").getByRole("alert")).toContainText("unavailable");
  await expect(relative.getByLabel("Story", { exact: true })).toHaveValue("Keep my unsaved recollection.");
  await expect(relative.getByLabel("Storyteller", { exact: true })).toHaveValue(storyteller);
  expect((await relative.request.get(item.path)).status()).toBe(404);
  expect(await rows()).toEqual(original);
  await page.goto(item.path); await expect(page.getByRole("article")).toContainText("Recorded by relative@example.com");
  expect((await db.execute({ sql: "SELECT id FROM accounts WHERE id=?", args: [recorder] })).rows).toHaveLength(1);
  await context.close();
});

test("concurrent retries deduplicate one operation, not identical recollections, and cannot rewrite or steal attribution", async ({ page, browser }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection); const id = randomUUID();
  const results = await Promise.all([record(page.request, item.path, storyteller, "A shared memory.", id), record(page.request, item.path, storyteller, "A shared memory.", id)]);
  expect(results.map(result => result.status())).toEqual([200, 200]);
  const original = await rows(); expect(original).toHaveLength(1);
  const otherItem = await draft(page.request, item.collection);
  expect((await record(page.request, otherItem.path, storyteller, "A shared memory.", id)).status()).toBe(404);
  expect((await record(page.request, item.path, storyteller, "Changed attempted text.", id)).status()).toBe(409);
  const another = await person(page.request, item.collection, "Pat");
  expect((await record(page.request, item.path, another, "A shared memory.", id)).status()).toBe(409);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  expect((await record(relative.request, item.path, storyteller, "A shared memory.", id)).status()).toBe(404);
  expect(await rows()).toEqual(original);
  expect((await record(page.request, item.path, storyteller, "A shared memory.")).status()).toBe(200);
  expect(await rows()).toHaveLength(2);
  expect((await page.request.patch(item.path + "/stories", { data: "overwrite" })).status()).toBe(405);
  await context.close();
});

test("failed database publication preserves browser input and retries without partial stories or leaked diagnostics", async ({ page }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection);
  await openForm(page, item.path);
  await page.getByLabel("Storyteller", { exact: true }).selectOption(storyteller); await page.getByLabel("Story", { exact: true }).fill("Retry this memory.");
  await db.execute("CREATE TRIGGER fail_story AFTER INSERT ON stories BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END");
  try {
    const response = page.waitForResponse(response => response.url().endsWith("/stories") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Record story", exact: true }).click();
    const failed = await response; expect(failed.status()).toBe(503); expect(await failed.text()).not.toContain("private diagnostic");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Save was not confirmed");
    await expect(page.getByLabel("Story", { exact: true })).toHaveValue("Retry this memory.");
    expect(await rows()).toHaveLength(0);
  } finally { await db.execute("DROP TRIGGER fail_story"); }
  await submit(page, storyteller, "Retry this memory."); expect(await rows()).toHaveLength(1);
});

test("lost acknowledgement retries the saved story; changed attempted text conflicts without losing input", async ({ page }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection);
  await openForm(page, item.path);
  await page.route("**/stories", async route => { await route.fetch(); await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Simulated lost acknowledgement" }) }); }, { times: 1 });
  await page.getByLabel("Storyteller", { exact: true }).selectOption(storyteller); await page.getByLabel("Story", { exact: true }).fill("Original memory.");
  await page.getByRole("button", { name: "Record story", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("lost acknowledgement");
  expect(await rows()).toHaveLength(1);
  await submit(page, storyteller, "Original memory."); expect(await rows()).toHaveLength(1);
  await openForm(page, item.path);
  await page.route("**/stories", async route => { await route.fetch(); await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }); }, { times: 1 });
  await page.getByLabel("Storyteller", { exact: true }).selectOption(storyteller); await page.getByLabel("Story", { exact: true }).fill("Second memory.");
  await page.getByRole("button", { name: "Record story", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Save was not confirmed");
  await page.getByLabel("Story", { exact: true }).fill("Changed but not saved.");
  await page.getByRole("button", { name: "Record story", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("already saved a different story");
  await expect(page.getByLabel("Story", { exact: true })).toHaveValue("Changed but not saved.");
  await expect(page.getByRole("button", { name: "Record story", exact: true })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Open saved stories in a new tab" })).toHaveAttribute("target", "_blank");
  expect((await rows()).map(row => row.text)).toEqual(expect.arrayContaining(["Original memory.", "Second memory."]));
});

test("bounded forms enforce origin, encoding, unique fields, required text and real references; forged identities have no authority", async ({ page }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection); const path = item.path + "/stories";
  const valid = { id: randomUUID(), storyteller, text: "A memory." };
  expect((await page.request.post(path, { form: valid, headers: { Origin: "https://foreign.invalid" } })).status()).toBe(403);
  expect((await page.request.post(path, { form: valid })).status()).toBe(403);
  expect((await page.request.post(path, { data: valid, headers: { Origin: origin } })).status()).toBe(415);
  expect((await record(page.request, item.path, storyteller, "a".repeat(100_000))).status()).toBe(413);
  for (const body of [{ ...valid, text: " \n\t " }, { ...valid, text: "null\0text" }, { ...valid, text: "a".repeat(10_001) }, { ...valid, storyteller: "" }, { ...valid, id: "invalid" }]) expect((await post(page.request, path, body)).status()).toBe(400);
  for (const field of ["id", "storyteller", "text"]) {
    const missing = new URLSearchParams(valid); missing.delete(field);
    const duplicate = new URLSearchParams(valid); duplicate.append(field, valid[field as keyof typeof valid]);
    for (const body of [missing, duplicate]) expect((await page.request.post(path, { data: body.toString(), headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(400);
  }
  expect(await rows()).toHaveLength(0);
  expect((await record(page.request, item.path, storyteller, "界".repeat(10_000), valid.id, { recorded_by: "forged", last_edited_by: "forged", storyteller_version: "999", version: "999", recorded_at: "0" })).status()).toBe(200);
  const saved = (await rows())[0]; expect(saved).toMatchObject({ version: 1, storyteller_version: 1 });
  expect(saved.recorded_by).toBe((await db.execute("SELECT created_by FROM items")).rows[0].created_by);
  expect(saved.recorded_at).toBeGreaterThan(0); expect(String(saved.text)).toHaveLength(10_000);
});

test("version-six upgrade preserves populated files, keeper history and sessions and rolls back late failure before rerun", async ({ page }) => {
  const item = await family(page); const storyteller = await person(page.request, item.collection);
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Bowl", description: "Blue ceramic bowl.", currentKeeper: storyteller })).status()).toBe(200);
  const tables = ["items", "item_revisions", "item_photos", "people", "person_revisions", "sessions", "accounts", "memberships"];
  const before = await Promise.all(tables.map(async table => (await db.execute(`SELECT * FROM ${table}`)).rows));
  await removeStoriesSchema(db);
  await db.execute("CREATE INDEX stories_item ON collections(name)");
  try {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv })).toThrow();
    expect((await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='stories'")).rows).toHaveLength(0);
    expect((await db.execute("SELECT name FROM schema_migrations")).rows).toHaveLength(6);
  } finally { await db.execute("DROP INDEX stories_item"); }
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect(await Promise.all(tables.map(async table => (await db.execute(`SELECT * FROM ${table}`)).rows))).toEqual(before);
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
  await page.goto(item.path); await expect(page.locator(".keeper-summary")).toContainText("Sam");
  expect((await record(page.request, item.path, storyteller)).status()).toBe(200);
  const saved = await rows();
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect(await rows()).toEqual(saved); expect((await db.execute("SELECT name FROM schema_migrations")).rows).toHaveLength(7);
  const photo = await page.request.get(item.path + "/photo"); expect(photo.ok()).toBe(true); expect(photo.headers()["content-type"]).toBe("image/jpeg");
});

test("story text is escaped and long attribution remains keyboard-usable on mobile without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const item = await family(page); const storyteller = await person(page.request, item.collection, "N".repeat(200), "Q".repeat(400));
  await openForm(page, item.path);
  await page.getByLabel("Storyteller", { exact: true }).focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Add a person in a new tab" })).toBeFocused();
  await submit(page, storyteller, '<script>window.storyExecuted=true</script>\n' + "W".repeat(1500));
  await expect(page.getByRole("article").locator(".story-text")).toContainText("<script>");
  expect(await page.evaluate(() => "storyExecuted" in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

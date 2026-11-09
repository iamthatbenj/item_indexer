import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient, type Row } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { removePeopleSchema } from "./support/legacy-database";
import { familyJourney, dbUrl, outbox, origin, post, operatorEnv } from "./support/family";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept } = familyJourney(db);
test.setTimeout(120_000);
test.beforeEach(async () => {
  await db.batch(["story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
});
test.afterAll(() => db.close());

async function photo(request: APIRequestContext, collection: string) {
  const bytes = await readFile(resolve("tests/fixtures/photos/small.png"));
  const id = randomUUID();
  const begin = await post(request, `${collection}/photo-uploads`, { id, size: String(bytes.length) });
  expect(begin.status()).toBe(200);
  expect((await request.put((await begin.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  expect((await post(request, `${collection}/photo-uploads/${id}/finish`, {})).status()).toBe(200);
  return { id, path: `${collection}/items/${id}` };
}
async function family(page: Page) {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  return { collection, ...await photo(page.request, collection) };
}
async function save(page: Page, name: string, description: string) {
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Short description", { exact: true }).fill(description);
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Save item details", exact: true }).click(),
  ]);
  await expect(page.getByRole("status")).toContainText("Item details saved.");
  await expect.poll(() => page.locator(".item-photo").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
}
async function current(id: string) { return (await db.execute({ sql: "SELECT * FROM items WHERE id=?", args: [id] })).rows[0]; }
async function revisions(id: string) { return (await db.execute({ sql: "SELECT * FROM item_revisions WHERE item_id=? ORDER BY version", args: [id] })).rows; }
const editor = (page: Page) => page.getByRole("region", { name: "Name and describe this belonging" });

// Writes enter through public HTTP/browser boundaries; SQL inspects durable
// artifacts and injects failures/legacy state, never substitutes implementation.
test("ordinary member and administrator complete and edit the same object or set with recoverable attributed versions", async ({ page, browser }) => {
  const item = await family(page);
  const original = await current(item.id);
  const originalPhoto = (await db.execute("SELECT * FROM item_photos")).rows[0];
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await relative.goto(item.path);
  await save(relative, "  Grandmother’s tea set  ", "Six cups and saucers, recorded as one set.\nBlue flowers on white porcelain.");
  await expect(relative.getByRole("heading", { name: "Grandmother’s tea set", exact: true })).toBeVisible();
  await expect(relative.getByRole("status")).toContainText("Complete with a photo");
  await page.goto(item.path);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Grandmother’s tea set");
  await save(page, "Grandmother’s tea set", "Six cups and saucers with blue flowers. Kept together as a set.");
  const history = await revisions(item.id);
  const memberId = String((await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id);
  expect(history.map(row => Number(row.version))).toEqual([1, 2]);
  expect(history[0]).toMatchObject({ name: "", description: "", status: "draft", edited_by: original.created_by, edited_at: original.created_at });
  expect(history[1]).toMatchObject({ name: "Grandmother’s tea set", description: "Six cups and saucers, recorded as one set.\nBlue flowers on white porcelain.", status: "complete", edited_by: memberId });
  expect(history[0].id).not.toBe(history[1].id);
  expect(await current(item.id)).toMatchObject({ id: item.id, collection_id: item.collection.split("/").pop(), created_by: original.created_by, version: 3, last_edited_by: original.created_by, status: "complete" });
  expect((await db.execute("SELECT * FROM item_photos")).rows[0]).toEqual(originalPhoto);
  await relative.goto(item.collection);
  await relative.getByRole("link", { name: /Grandmother’s tea set — Complete item/ }).click();
  await expect(relative.getByLabel("Short description", { exact: true })).toHaveValue("Six cups and saucers with blue flowers. Kept together as a set.");
  const beforeRemoval = await current(item.id);
  expect((await post(page.request, `${item.collection}/members/${memberId}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  expect(await current(item.id)).toEqual(beforeRemoval);
  expect(await revisions(item.id)).toEqual(history);
  expect((await db.execute({ sql: "SELECT id FROM accounts WHERE id=?", args: [memberId] })).rows).toHaveLength(1);
  expect((await page.request.get(item.path)).status()).toBe(200);
  expect((await post(relative.request, item.path + "/details", { version: "3", name: "Removed edit", description: "Not authorized" })).status()).toBe(404);
  await context.close();
});

test("blank and partially completed fields remain drafts and clearing a field preserves the completed contribution", async ({ page }) => {
  const item = await family(page); await page.goto(item.path);
  await save(page, "Blue bowl", "");
  expect(await current(item.id)).toMatchObject({ name: "Blue bowl", description: "", status: "draft", version: 2 });
  await save(page, "Blue bowl", "Hand-painted with a white rim.");
  expect((await current(item.id)).status).toBe("complete");
  await save(page, "\u3000  ", "Hand-painted with a white rim.");
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect(await current(item.id)).toMatchObject({ name: "", status: "draft", version: 4 });
  expect((await revisions(item.id))[2]).toMatchObject({ name: "Blue bowl", description: "Hand-painted with a white rim.", status: "complete" });
  await save(page, "", " \n\t ");
  expect(await current(item.id)).toMatchObject({ name: "", description: "", status: "draft", version: 5 });
  await page.goto(item.collection);
  await expect(page.getByRole("link", { name: /Untitled belonging — Draft item/ })).toBeVisible();
});

test("stale browser saves keep attempted input and open the latest version separately without silent rebasing", async ({ page, browser }) => {
  const item = await family(page);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation); await relative.goto(item.path);
  await expect(relative.getByLabel("Name", { exact: true })).toBeEnabled();
  await relative.getByLabel("Name", { exact: true }).fill("My remembered name");
  await relative.getByLabel("Short description", { exact: true }).fill("My different description should remain available.");
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Saved by another member", description: "Their contribution wins this version." })).status()).toBe(200);
  await relative.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(editor(relative).getByRole("alert")).toContainText("saved version changed");
  await expect(relative.getByLabel("Name", { exact: true })).toHaveValue("My remembered name");
  await expect(relative.getByLabel("Short description", { exact: true })).toHaveValue("My different description should remain available.");
  await expect(relative.getByRole("button", { name: "Save item details", exact: true })).toBeDisabled();
  const popup = context.waitForEvent("page");
  await relative.getByRole("link", { name: "Open latest saved item in a new tab", exact: true }).click();
  const latest = await popup;
  await expect(latest.getByRole("heading", { name: "Saved by another member", exact: true })).toBeVisible();
  await expect(relative.getByLabel("Name", { exact: true })).toHaveValue("My remembered name");
  expect(await revisions(item.id)).toHaveLength(1);
  expect((await current(item.id)).version).toBe(2);
  await context.close();
});

test("competing same-version requests commit exactly one attributed edit and one recoverable prior version", async ({ page, browser }) => {
  const item = await family(page);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const results = await Promise.all([
    post(page.request, item.path + "/details", { version: "1", name: "Founder name", description: "Founder description" }),
    post(relative.request, item.path + "/details", { version: "1", name: "Relative name", description: "Relative description" }),
  ]);
  expect(results.map(result => result.status()).sort()).toEqual([200, 409]);
  const row = await current(item.id);
  const winner = results[0].status() === 200 ? "founder@example.com" : "relative@example.com";
  expect(row.last_edited_by).toBe((await db.execute({ sql: "SELECT id FROM accounts WHERE email=?", args: [winner] })).rows[0].id);
  expect(row.version).toBe(2);
  expect(await revisions(item.id)).toHaveLength(1);
  // Even a stale request that happens to match the winner cannot rebase itself.
  expect((await post(page.request, item.path + "/details", { version: "1", name: String(row.name), description: String(row.description) })).status()).toBe(409);
  expect((await post(page.request, item.path + "/details", { version: "2", name: String(row.name), description: String(row.description) })).status()).toBe(200);
  expect((await current(item.id)).version).toBe(2);
  expect(await revisions(item.id)).toHaveLength(1);
  await context.close();
});

test("cross-collection and signed-out writes are denied; stale removed-member sessions keep their attempted text", async ({ page, browser, request }) => {
  const item = await family(page);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const other = await browser.newContext(); const stranger = await other.newPage();
  await signIn(stranger, "other@example.com", true); const elsewhere = await createCollection(stranger, "Separate family");
  const fields = { version: "1", name: "Forged name", description: "Forged description" };
  expect((await post(stranger.request, item.path + "/details", fields)).status()).toBe(404);
  expect((await post(page.request, `${elsewhere}/items/${item.id}/details`, fields)).status()).toBe(404);
  expect((await post(request, item.path + "/details", fields)).status()).toBe(401);
  expect((await stranger.request.get(item.path)).status()).toBe(404);
  const member = (await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0];
  // Compile the development-only lazy route before opening a stale editor;
  // production has no on-demand HMR refresh when this handler is first used.
  expect((await post(page.request, `${item.collection}/members/${member.id}`, { action: "invalid" })).status()).toBe(400);
  await relative.goto(item.path);
  await expect(relative.getByLabel("Name", { exact: true })).toBeEnabled();
  await relative.getByLabel("Name", { exact: true }).fill("Keep my draft after removal");
  expect((await post(page.request, `${item.collection}/members/${member.id}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  await relative.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(editor(relative).getByRole("alert")).toContainText("unavailable");
  await expect(relative.getByLabel("Name", { exact: true })).toHaveValue("Keep my draft after removal");
  expect((await current(item.id)).version).toBe(1);
  expect(await revisions(item.id)).toHaveLength(0);
  await context.close(); await other.close();
});

test("direct completion requests cannot bypass the retained-photo requirement or forge status/editor identity", async ({ page }) => {
  const item = await family(page);
  const original = await current(item.id);
  const storedPhoto = (await db.execute("SELECT * FROM item_photos")).rows[0];
  await db.execute("DELETE FROM item_photos");
  expect((await post(page.request, item.path + "/details", { version: "1", name: "No photo", description: "Must not complete", status: "complete", photo_key: "untrusted", last_edited_by: "someone-else" })).status()).toBe(409);
  expect(await current(item.id)).toEqual(original);
  expect(await revisions(item.id)).toHaveLength(0);
  await insert("item_photos", storedPhoto);
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Real item", description: "Actual retained photo exists", status: "draft", last_edited_by: "someone-else" })).status()).toBe(200);
  expect(await current(item.id)).toMatchObject({ status: "complete", last_edited_by: original.created_by });
});

test("bounded forms validate versions, duplicate fields, nulls and character limits while supporting full-length Unicode", async ({ page }) => {
  const item = await family(page); const endpoint = item.path + "/details";
  const fields = { version: "1", name: "Name", description: "Description" };
  expect((await page.request.post(endpoint, { form: fields, headers: { Origin: "https://foreign.invalid" } })).status()).toBe(403);
  expect((await page.request.post(endpoint, { form: fields })).status()).toBe(403);
  expect((await page.request.post(endpoint, { data: "{}", headers: { Origin: origin, "Content-Type": "application/json" } })).status()).toBe(415);
  expect((await page.request.post(endpoint, { data: "x".repeat(16 * 1024 + 1), headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(413);
  for (const version of ["", "0", "-1", "1.2", "1e0", "01", "9007199254740992"]) expect((await post(page.request, endpoint, { ...fields, version })).status()).toBe(400);
  for (const invalid of [{ name: "x".repeat(201) }, { description: "x".repeat(1201) }, { name: "null\0name" }]) expect((await post(page.request, endpoint, { ...fields, ...invalid })).status()).toBe(400);
  expect((await post(page.request, endpoint, { version: "1", name: "Missing description" })).status()).toBe(400);
  expect((await page.request.post(endpoint, { data: "version=1&name=a&name=b&description=c", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(400);
  expect(await revisions(item.id)).toHaveLength(0);
  expect((await post(page.request, endpoint, { version: "1", name: "茶".repeat(200), description: "器".repeat(1200) })).status()).toBe(200);
  expect(await current(item.id)).toMatchObject({ name: "茶".repeat(200), description: "器".repeat(1200), status: "complete", version: 2 });
});

test("database failures roll back revisions and current details together and leave browser input retryable", async ({ page }) => {
  const item = await family(page); await page.goto(item.path);
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
  await page.getByLabel("Name", { exact: true }).fill("Keep this attempted name");
  await page.getByLabel("Short description", { exact: true }).fill("Keep this attempted description");
  for (const target of ["UPDATE ON items", "INSERT ON item_revisions"]) {
    await db.execute(`CREATE TRIGGER fail_item_edit BEFORE ${target} BEGIN SELECT RAISE(ABORT, 'private-driver-marker'); END`);
    try {
      await page.getByRole("button", { name: "Save item details", exact: true }).click();
      await expect(editor(page).getByRole("alert")).toContainText("Save was not confirmed");
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Keep this attempted name");
      await expect(page.getByLabel("Short description", { exact: true })).toHaveValue("Keep this attempted description");
      await expect(page.locator("body")).not.toContainText("private-driver-marker");
      expect((await current(item.id)).version).toBe(1);
      expect(await revisions(item.id)).toHaveLength(0);
    } finally { await db.execute("DROP TRIGGER fail_item_edit"); }
  }
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Save item details", exact: true }).click()]);
  expect((await current(item.id)).version).toBe(2);
  expect(await revisions(item.id)).toHaveLength(1);
});

test("a lost save acknowledgement preserves text and a retry rejects the stale version without extra history", async ({ page }) => {
  const item = await family(page); await page.goto(item.path);
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
  await page.getByLabel("Name", { exact: true }).fill("Possibly saved name");
  await page.getByLabel("Short description", { exact: true }).fill("Keep this on a lost response");
  await page.route("**/details", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await page.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(editor(page).getByRole("alert")).toContainText("Save was interrupted");
  await expect(page.getByLabel("Short description", { exact: true })).toHaveValue("Keep this on a lost response");
  await page.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(editor(page).getByRole("alert")).toContainText("saved version changed");
  expect((await current(item.id)).version).toBe(2);
  expect(await revisions(item.id)).toHaveLength(1);
});

async function insert(table: string, row: Row) {
  const columns = Object.keys(row);
  await db.execute({ sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`, args: columns.map(column => row[column]) });
}

test("migration upgrades populated version-three records without changing photo relationships, access or capture", async ({ page }) => {
  const item = await family(page);
  const memberships = (await db.execute("SELECT * FROM memberships")).rows;
  const sessions = (await db.execute("SELECT * FROM sessions")).rows;
  const oldItem = (await db.execute("SELECT id, collection_id, created_by, created_at, status FROM items")).rows[0];
  const oldPhoto = (await db.execute("SELECT id, item_id, photo_key, thumbnail_key, width, height, photo_bytes, sha256, created_at FROM item_photos")).rows[0];
  const oldUpload = (await db.execute("SELECT id, collection_id, account_id, input_bytes, created_at, expires_at, state, attempt, lease_until FROM photo_uploads")).rows[0];
  await removePeopleSchema(db);
  for (const table of ["item_revisions", "photo_uploads", "item_photos", "items"]) await db.execute(`DROP TABLE ${table}`);
  for (const statement of (await readFile("migrations/0003_photo_drafts.sql", "utf8")).split(";").map(s => s.trim()).filter(Boolean)) await db.execute(statement);
  await insert("items", oldItem); await insert("item_photos", oldPhoto); await insert("photo_uploads", oldUpload);
  await db.execute("DELETE FROM schema_migrations WHERE name IN ('0004_item_details.sql', '0005_multiple_item_photos.sql')");
  // Fail at the final CREATE TABLE, after all ALTERs, to prove atomic rollback.
  await db.execute("CREATE TABLE item_revisions (marker TEXT)");
  expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv })).toThrow();
  expect((await db.execute("SELECT * FROM items")).rows[0]).toEqual(oldItem);
  expect((await db.execute("SELECT * FROM schema_migrations WHERE name='0004_item_details.sql'")).rows).toHaveLength(0);
  expect((await db.execute("SELECT * FROM item_photos")).rows[0]).toEqual(oldPhoto);
  await db.execute("DROP TABLE item_revisions");
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
  expect((await db.execute("SELECT * FROM memberships")).rows).toEqual(memberships);
  expect((await db.execute("SELECT * FROM sessions")).rows).toEqual(sessions);
  // Explicit columns avoid native libSQL's stale SELECT-* column metadata across external DDL.
  expect((await db.execute("SELECT id, item_id, photo_key, thumbnail_key, width, height, photo_bytes, sha256, created_at, created_by, removed_at, removed_by FROM item_photos")).rows[0]).toMatchObject({ ...oldPhoto, created_by: oldItem.created_by, removed_at: null, removed_by: null });
  expect(await current(item.id)).toMatchObject({ ...oldItem, version: 1, name: "", description: "", last_edited_by: null });
  await page.goto(item.path); await save(page, "Existing belonging", "A photo captured before this migration.");
  expect((await revisions(item.id))[0].edited_by).toBe(oldItem.created_by);
  const beforeRerun = await current(item.id); const history = await revisions(item.id);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect(await current(item.id)).toEqual(beforeRerun); expect(await revisions(item.id)).toEqual(history);
  expect((await page.request.get(item.path + "/photo")).status()).toBe(200);
  const fresh = await photo(page.request, item.collection);
  expect((await current(fresh.id)).version).toBe(1);
});

test("long text remains escaped, labelled and keyboard-usable without mobile horizontal overflow", async ({ page }) => {
  const item = await family(page); await page.setViewportSize({ width: 375, height: 812 }); await page.goto(item.path);
  const name = "a".repeat(200); const description = '<script>alert("not executed")</script>\n' + "b".repeat(1000);
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
  await page.getByLabel("Name", { exact: true }).focus(); await page.keyboard.press("Tab");
  await expect(page.getByLabel("Short description", { exact: true })).toBeFocused();
  await save(page, name, description);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.locator(".item-description")).toHaveText(description);
  expect(await page.locator(".item-description script").count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(item.collection);
  await expect(page.getByRole("link", { name: new RegExp(name + " — Complete item") })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

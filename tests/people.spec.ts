import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { familyJourney, dbUrl, outbox, origin, post, operatorEnv } from "./support/family";
import { removePeopleSchema } from "./support/legacy-database";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept } = familyJourney(db);
test.setTimeout(150_000);
test.beforeEach(async ({ request }) => {
  await db.batch(["person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  // Finish first-use development handler compilation before app pages open.
  expect((await post(request, "/collections/prewarm/people/records", {})).status()).toBe(401);
  expect((await post(request, "/collections/prewarm/people/prewarm/details", {})).status()).toBe(401);
  expect((await post(request, "/collections/prewarm/items/prewarm/details", {})).status()).toBe(401);
  expect((await post(request, "/collections/prewarm/items/prewarm/photo-uploads", {})).status()).toBe(401);
  expect((await post(request, "/collections/prewarm/items/prewarm/photo-uploads/prewarm/finish", {})).status()).toBe(401);
  expect((await post(request, "/collections/prewarm/members/prewarm", {})).status()).toBe(303);
});
test.afterAll(() => db.close());

async function family(page: Page) {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  return { collection, ...await photo(page.request, collection) };
}
async function photo(request: APIRequestContext, collection: string) {
  const bytes = await readFile("tests/fixtures/photos/small.png"); const id = randomUUID();
  const begin = await post(request, collection + "/photo-uploads", { id, size: String(bytes.length) });
  expect(begin.status()).toBe(200);
  expect((await request.put((await begin.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  expect((await post(request, `${collection}/photo-uploads/${id}/finish`, {})).status()).toBe(200);
  return { id, path: `${collection}/items/${id}` };
}
async function person(request: APIRequestContext, collection: string, name = "Sam", note = "Aunt on Dad’s side") {
  const id = randomUUID();
  expect((await post(request, collection + "/people/records", { id, name, note })).status()).toBe(200);
  return { id, path: `${collection}/people/${id}` };
}
async function createInBrowser(page: Page, collection: string, name: string, note: string) {
  await page.goto(collection + "/people/new");
  await expect(page.getByLabel("Person name", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel("Person name", { exact: true }).fill(name);
  await page.getByLabel("Identifying note (optional)", { exact: true }).fill(note);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Save person", exact: true }).click()]);
  await expect(page.getByRole("status")).toHaveText("Person details saved.");
  return { id: new URL(page.url()).pathname.split("/").pop()!, path: new URL(page.url()).pathname };
}
async function saveItem(page: Page, keeper: string, name = "Blue bowl", description = "A hand-painted family bowl.") {
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Short description", { exact: true }).fill(description);
  await page.getByLabel("Current keeper (optional)", { exact: true }).selectOption(keeper);
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Save item details", exact: true }).click()]);
  await expect(page.getByRole("status")).toContainText("Item details saved.");
}
const current = async (id: string) => (await db.execute({ sql: "SELECT * FROM items WHERE id=?", args: [id] })).rows[0];
const personRow = async (id: string) => (await db.execute({ sql: "SELECT id, collection_id, name, note, version, created_by, created_at, last_edited_by, updated_at FROM people WHERE id=?", args: [id] })).rows[0];
const history = async (id: string) => (await db.execute({ sql: "SELECT * FROM person_revisions WHERE person_id=? ORDER BY version", args: [id] })).rows;
const itemEdit = (request: APIRequestContext, path: string, version: string, keeper: string, extra: Record<string, string> = {}) => post(request, path + "/details", { version, name: "Blue bowl", description: "A hand-painted family bowl.", currentKeeper: keeper, ...extra });

test("members record same-name people with identifying notes, search their directory and keep people independent from accounts", async ({ page, browser }) => {
  const item = await family(page);
  await page.getByRole("link", { name: "Manage people and current keepers" }).click();
  await expect(page.getByRole("heading", { name: "People in this family collection" })).toBeVisible();
  const first = await createInBrowser(page, item.collection, "  Sam  ", "Aunt on Dad’s side");
  const second = await createInBrowser(page, item.collection, "Sam", "Cousin in Bristol");
  expect(first.id).not.toBe(second.id);
  await page.goto(item.collection + "/people");
  await expect(page.getByRole("link", { name: "Sam", exact: true })).toHaveCount(2);
  await expect(page.getByText("Aunt on Dad’s side", { exact: true })).toBeVisible();
  await expect(page.getByText("Cousin in Bristol", { exact: true })).toBeVisible();
  await page.getByLabel("Search names and identifying notes").fill("BRISTOL");
  await page.getByRole("button", { name: "Search people" }).click();
  await expect(page.getByRole("link", { name: "Sam", exact: true })).toHaveCount(1);
  await expect(page.getByText("Cousin in Bristol", { exact: true })).toBeVisible();
  await expect(page.getByText("Aunt on Dad’s side", { exact: true })).toHaveCount(0);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const before = (await db.execute("SELECT id, email FROM accounts ORDER BY id")).rows;
  const third = await createInBrowser(relative, item.collection, "Gran", "");
  expect(await personRow(third.id)).toMatchObject({ name: "Gran", note: "", version: 1 });
  expect((await db.execute("SELECT id, email FROM accounts ORDER BY id")).rows).toEqual(before);
  expect((await db.execute("SELECT * FROM memberships")).rows).toHaveLength(2);
  expect((await db.execute("SELECT * FROM invitations")).rows).toHaveLength(1);
  await context.close();
});

test("a non-member current keeper is reusable across items, changeable and optional for completion", async ({ page }) => {
  const item = await family(page); const keeper = await person(page.request, item.collection); const other = await person(page.request, item.collection, "Sam", "Cousin in Bristol");
  const another = await photo(page.request, item.collection);
  await page.goto(item.path); await saveItem(page, "");
  expect(await current(item.id)).toMatchObject({ status: "complete", current_keeper_id: null, version: 2 });
  await saveItem(page, keeper.id);
  await expect(page.locator(".keeper-summary")).toContainText("Sam — Aunt on Dad’s side");
  await page.goto(another.path); await saveItem(page, keeper.id);
  expect(await current(another.id)).toMatchObject({ current_keeper_id: keeper.id, current_keeper_version: 1 });
  await page.goto(item.path); await saveItem(page, other.id); await saveItem(page, "");
  expect(await current(item.id)).toMatchObject({ current_keeper_id: null, current_keeper_version: null, version: 5, status: "complete" });
  const revisions = (await db.execute({ sql: "SELECT version, current_keeper_id, current_keeper_version FROM item_revisions WHERE item_id=? ORDER BY version", args: [item.id] })).rows;
  expect(revisions.map(row => row.current_keeper_id)).toEqual([null, null, keeper.id, other.id]);
  expect((await db.execute("SELECT id FROM accounts")).rows).toHaveLength(1);
  await expect(page.locator(".keeper-summary")).toContainText("Not recorded");
});

test("person edits preserve identity, earlier identifying details and historical keeper versions without rewriting editor attribution", async ({ page, browser }) => {
  const item = await family(page); const keeper = await person(page.request, item.collection);
  expect((await itemEdit(page.request, item.path, "1", keeper.id)).status()).toBe(200);
  const initial = await personRow(keeper.id); const originalItem = await current(item.id);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation); await relative.goto(keeper.path);
  await expect(relative.getByLabel("Identifying note (optional)")).toBeEnabled();
  await relative.getByLabel("Person name", { exact: true }).fill("Samantha");
  await relative.getByLabel("Identifying note (optional)").fill("Aunt; now living in York");
  await Promise.all([relative.waitForEvent("load"), relative.getByRole("button", { name: "Save person details" }).click()]);
  await expect(relative.getByRole("heading", { name: "Samantha", exact: true })).toBeVisible();
  const editor = (await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id;
  expect(await personRow(keeper.id)).toMatchObject({ id: keeper.id, version: 2, created_by: initial.created_by, last_edited_by: editor });
  expect((await history(keeper.id))[0]).toMatchObject({ name: "Sam", note: "Aunt on Dad’s side", version: 1, edited_by: initial.created_by, edited_at: initial.created_at });
  expect(await current(item.id)).toEqual(originalItem);
  await page.goto(item.path);
  await expect(page.locator(".keeper-summary")).toContainText("Samantha — Aunt; now living in York");
  expect((await itemEdit(page.request, item.path, "2", keeper.id, { description: "A revised description" })).status()).toBe(200);
  const prior = (await db.execute({ sql: "SELECT current_keeper_id, current_keeper_version, edited_by FROM item_revisions WHERE item_id=? AND version=2", args: [item.id] })).rows[0];
  expect(prior).toMatchObject({ current_keeper_id: keeper.id, current_keeper_version: 1, edited_by: originalItem.last_edited_by });
  expect((await post(page.request, `${item.collection}/members/${editor}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  expect((await personRow(keeper.id)).last_edited_by).toBe(editor);
  expect((await db.execute({ sql: "SELECT id FROM accounts WHERE id=?", args: [editor] })).rows).toHaveLength(1);
  expect(await history(keeper.id)).toHaveLength(1);
  await context.close();
});

test("stale person saves preserve both attempted fields and require review of the latest version", async ({ page, browser }) => {
  const item = await family(page); const keeper = await person(page.request, item.collection);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation); await relative.goto(keeper.path);
  await expect(relative.getByLabel("Person name", { exact: true })).toBeEnabled();
  await relative.getByLabel("Person name", { exact: true }).fill("Attempted name");
  await relative.getByLabel("Identifying note (optional)").fill("Attempted identifying note");
  expect((await post(page.request, keeper.path + "/details", { version: "1", name: "Saved name", note: "Other member’s note" })).status()).toBe(200);
  await relative.getByRole("button", { name: "Save person details" }).click();
  await expect(relative.getByRole("main").getByRole("alert")).toContainText("changed while you were editing");
  await expect(relative.getByLabel("Person name", { exact: true })).toHaveValue("Attempted name");
  await expect(relative.getByLabel("Identifying note (optional)")).toHaveValue("Attempted identifying note");
  await expect(relative.getByRole("button", { name: "Save person details" })).toBeDisabled();
  const popupPromise = relative.waitForEvent("popup"); await relative.getByRole("link", { name: "Open latest saved person in a new tab" }).click();
  const popup = await popupPromise; await expect(popup.getByRole("heading", { name: "Saved name", exact: true })).toBeVisible();
  expect(await personRow(keeper.id)).toMatchObject({ name: "Saved name", note: "Other member’s note", version: 2 });
  expect(await history(keeper.id)).toHaveLength(1);
  await context.close();
});

test("competing person edits, no-ops and creation retries are atomic and retain one attributed prior state", async ({ page }) => {
  const item = await family(page); const id = randomUUID(); const body = { id, name: "Sam", note: "Aunt" };
  const creates = await Promise.all([post(page.request, item.collection + "/people/records", body), post(page.request, item.collection + "/people/records", body)]);
  expect(creates.map(r => r.status())).toEqual([200, 200]);
  expect((await db.execute("SELECT id FROM people")).rows).toHaveLength(1);
  const path = `${item.collection}/people/${id}/details`;
  expect((await post(page.request, path, { version: "1", name: " Sam ", note: " Aunt " })).status()).toBe(200);
  expect(await history(id)).toHaveLength(0);
  const edits = await Promise.all([post(page.request, path, { version: "1", name: "Sam A", note: "First" }), post(page.request, path, { version: "1", name: "Sam B", note: "Second" })]);
  expect(edits.map(r => r.status()).sort()).toEqual([200, 409]);
  expect((await personRow(id)).version).toBe(2); expect(await history(id)).toHaveLength(1);
  // A retry after someone renamed the record cannot duplicate or rewind it.
  expect((await post(page.request, item.collection + "/people/records", body)).status()).toBe(200);
  expect((await personRow(id)).version).toBe(2);
  expect((await post(page.request, item.collection + "/people/records", { ...body, note: "Changed request" })).status()).toBe(409);
  expect((await db.execute("SELECT id FROM people")).rows).toHaveLength(1);
});

test("keeper changes compete with text edits and a stale browser keeps its selected person and attempted text", async ({ page }) => {
  const item = await family(page); const one = await person(page.request, item.collection); const two = await person(page.request, item.collection, "Ruth", "Cousin");
  await page.goto(item.path);
  await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
  await page.getByLabel("Name", { exact: true }).fill("Attempted bowl name");
  await page.getByLabel("Short description", { exact: true }).fill("Attempted description");
  await page.getByLabel("Current keeper (optional)").selectOption(one.id);
  expect((await itemEdit(page.request, item.path, "1", two.id)).status()).toBe(200);
  await page.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("saved version changed");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Attempted bowl name");
  await expect(page.getByLabel("Current keeper (optional)")).toHaveValue(one.id);
  expect(await current(item.id)).toMatchObject({ current_keeper_id: two.id, version: 2 });
  const races = await Promise.all([itemEdit(page.request, item.path, "2", one.id), itemEdit(page.request, item.path, "2", "", { name: "Competing description edit" })]);
  expect(races.map(r => r.status()).sort()).toEqual([200, 409]);
  expect((await current(item.id)).version).toBe(3);
  expect((await db.execute({ sql: "SELECT id FROM item_revisions WHERE item_id=?", args: [item.id] })).rows).toHaveLength(2);
});

test("people choice refresh and photo refresh preserve unsaved keeper, text and the original item version", async ({ page }) => {
  const item = await family(page); const first = await person(page.request, item.collection);
  await page.goto(item.path); await expect(page.getByLabel("Name", { exact: true })).toBeEnabled();
  await page.getByLabel("Name", { exact: true }).fill("Unsaved bowl");
  await page.getByLabel("Current keeper (optional)").selectOption(first.id);
  const second = await person(page.request, item.collection, "Sam", "Cousin in Bristol");
  await page.getByRole("button", { name: "Refresh keeper choices", exact: true }).click();
  await expect(page.getByRole("region", { name: "Name and describe this belonging" }).getByRole("status")).toContainText("choices refreshed");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Unsaved bowl");
  await expect(page.getByLabel("Current keeper (optional)")).toHaveValue(first.id);
  await page.getByLabel("Find a current keeper", { exact: true }).fill("Bristol");
  await page.getByLabel("Find a current keeper", { exact: true }).press("Enter");
  expect((await current(item.id)).version).toBe(1);
  await expect(page.getByLabel("Current keeper (optional)").locator("option")).toHaveCount(3); // selected keeper stays present
  await page.getByLabel("Current keeper (optional)").selectOption(second.id);
  const picker = page.getByRole("region", { name: "Add another photo" }).getByLabel("Choose from your photo library", { exact: true });
  await expect(picker).toBeEnabled(); await picker.setInputFiles("tests/fixtures/photos/small.webp");
  await page.getByRole("button", { name: "Add photo", exact: true }).click();
  await expect(page.locator(".item-view")).toHaveCount(2);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Unsaved bowl");
  await expect(page.getByLabel("Current keeper (optional)")).toHaveValue(second.id);
  await expect(page.locator('input[name="version"]')).toHaveValue("1");
  expect((await current(item.id)).version).toBe(1);
  await saveItem(page, second.id, "Unsaved bowl");
  expect(await current(item.id)).toMatchObject({ current_keeper_id: second.id, version: 2 });
});

test("directory reads and person/keeper writes reject unrelated collections and accounts at public boundaries", async ({ page, browser, request }) => {
  const item = await family(page); const first = await person(page.request, item.collection, "Private name", "Private identifying note");
  const otherCollection = await createCollection(page, "Separate collection"); const other = await person(page.request, otherCollection, "Other collection name", "Other note");
  const ownDirectory = await page.request.get(item.collection + "/people/records");
  expect(ownDirectory.headers()["cache-control"]).toContain("no-store");
  expect((await ownDirectory.json()).people.map((p: { id: string }) => p.id)).toEqual([first.id]);
  expect((await itemEdit(page.request, item.path, "1", other.id)).status()).toBe(400); // actor belongs to BOTH collections
  expect((await post(page.request, `${otherCollection}/people/${first.id}/details`, { version: "1", name: "Wrong collection", note: "" })).status()).toBe(404);
  expect((await page.request.get(`${otherCollection}/people/${first.id}`)).status()).toBe(404);
  const context = await browser.newContext(); const outsider = await context.newPage();
  await signIn(outsider, "outsider@example.com", true); await createCollection(outsider, "Unrelated collection");
  for (const path of [item.collection + "/people", first.path, item.collection + "/people/new"]) {
    const response = await outsider.request.get(path); expect(response.status()).toBe(404); expect(await response.text()).not.toContain("Private identifying note");
  }
  const denied = await outsider.request.get(item.collection + "/people/records?q=Private");
  expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain("Private name");
  expect((await post(outsider.request, item.collection + "/people/records", { id: randomUUID(), name: "Intruder", note: "" })).status()).toBe(404);
  expect((await post(outsider.request, first.path + "/details", { version: "1", name: "Intruder", note: "" })).status()).toBe(404);
  expect((await itemEdit(outsider.request, item.path, "1", first.id)).status()).toBe(404);
  expect((await request.get(item.collection + "/people/records")).status()).toBe(401);
  expect((await post(request, item.collection + "/people/records", { id: randomUUID(), name: "Anonymous", note: "" })).status()).toBe(401);
  expect((await request.get(first.path, { maxRedirects: 0 })).status()).toBe(307);
  expect((await personRow(first.id)).name).toBe("Private name"); expect((await current(item.id)).version).toBe(1);
  await context.close();
});

test("membership removal denies stale person editors and keeper writes while retaining contributions", async ({ page, browser }) => {
  const item = await family(page); const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const keeper = await person(relative.request, item.collection); const original = await personRow(keeper.id);
  await relative.goto(keeper.path); await expect(relative.getByLabel("Person name", { exact: true })).toBeEnabled();
  await relative.getByLabel("Person name", { exact: true }).fill("Keep my attempted name");
  expect((await post(page.request, `${item.collection}/members/${original.created_by}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  await relative.getByRole("button", { name: "Save person details" }).click();
  await expect(relative.getByRole("main").getByRole("alert")).toContainText("unavailable");
  await expect(relative.getByLabel("Person name", { exact: true })).toHaveValue("Keep my attempted name");
  expect((await relative.request.get(item.collection + "/people/records")).status()).toBe(404);
  expect((await post(relative.request, item.collection + "/people/records", { id: randomUUID(), name: "No longer authorized", note: "" })).status()).toBe(404);
  expect((await itemEdit(relative.request, item.path, "1", keeper.id)).status()).toBe(404);
  expect(await personRow(keeper.id)).toEqual(original);
  expect((await itemEdit(page.request, item.path, "1", keeper.id)).status()).toBe(200);
  expect((await db.execute({ sql: "SELECT id FROM accounts WHERE id=?", args: [original.created_by] })).rows).toHaveLength(1);
  await context.close();
});

test("database failures leave person creation, attributed revisions and keeper changes fully retryable", async ({ page }) => {
  const item = await family(page); const id = randomUUID(); const body = { id, name: "Sam", note: "Aunt" };
  await db.execute("CREATE TRIGGER fail_person_create BEFORE INSERT ON people BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END");
  try {
    const failed = await post(page.request, item.collection + "/people/records", body); expect(failed.status()).toBe(503); expect(await failed.text()).not.toContain("private diagnostic");
    expect((await db.execute("SELECT id FROM people")).rows).toHaveLength(0);
  } finally { await db.execute("DROP TRIGGER fail_person_create"); }
  expect((await post(page.request, item.collection + "/people/records", body)).status()).toBe(200);
  const path = `${item.collection}/people/${id}`; const original = await personRow(id);
  for (const operation of ["INSERT ON person_revisions", "UPDATE ON people"]) {
    await db.execute(`CREATE TRIGGER fail_person_edit BEFORE ${operation} BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END`);
    try {
      expect((await post(page.request, path + "/details", { version: "1", name: "Edited", note: "Different" })).status()).toBe(503);
      expect(await personRow(id)).toEqual(original); expect(await history(id)).toHaveLength(0);
    } finally { await db.execute("DROP TRIGGER fail_person_edit"); }
  }
  await page.goto(path); await expect(page.getByLabel("Person name", { exact: true })).toBeEnabled();
  await page.getByLabel("Identifying note (optional)").fill("Retried note");
  await db.execute("CREATE TRIGGER fail_person_edit BEFORE UPDATE ON people BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END");
  try {
    await page.getByRole("button", { name: "Save person details" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Save was not confirmed");
    await expect(page.getByLabel("Identifying note (optional)")).toHaveValue("Retried note");
  } finally { await db.execute("DROP TRIGGER fail_person_edit"); }
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Save person details" }).click()]);
  expect((await personRow(id)).version).toBe(2);
  await db.execute("CREATE TRIGGER fail_keeper BEFORE UPDATE ON items BEGIN SELECT RAISE(ABORT, 'private diagnostic'); END");
  try {
    expect((await itemEdit(page.request, item.path, "1", id)).status()).toBe(503);
    expect(await current(item.id)).toMatchObject({ current_keeper_id: null, version: 1 });
    expect((await db.execute("SELECT id FROM item_revisions")).rows).toHaveLength(0);
  } finally { await db.execute("DROP TRIGGER fail_keeper"); }
  expect((await itemEdit(page.request, item.path, "1", id)).status()).toBe(200);
});

test("forms bound and validate identifying details, versions and keeper fields without trusting client-declared attribution", async ({ page }) => {
  const item = await family(page); const endpoint = item.collection + "/people/records";
  for (const fields of [{ name: "", note: "" }, { name: " \n\u3000", note: "" }, { name: "x".repeat(201), note: "" }, { name: "Sam", note: "x".repeat(401) }, { name: "Sam\0", note: "" }]) {
    expect((await post(page.request, endpoint, { id: randomUUID(), ...fields })).status()).toBe(400);
  }
  expect((await page.request.post(endpoint, { form: { id: randomUUID(), name: "Sam", note: "" }, headers: { Origin: "https://foreign.invalid" }, maxRedirects: 0 })).status()).toBe(403);
  expect((await page.request.post(endpoint, { data: "id=x&name=x&note=" + "n".repeat(17_000), headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(413);
  expect((await page.request.post(endpoint, { data: "id=x&name=Sam&name=Other&note=", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(400);
  const keeper = await person(page.request, item.collection, "親".repeat(200), "記".repeat(400));
  for (const version of ["0", "01", "1.0", "9007199254740991"]) expect((await post(page.request, keeper.path + "/details", { version, name: "Sam", note: "" })).status()).toBe(400);
  expect((await page.request.post(keeper.path + "/details", { data: "version=1&version=1&name=Sam&note=", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(400);
  const forged = { id: randomUUID() };
  expect((await post(page.request, endpoint, { id: forged.id, name: "Unlinked person", note: "", account_id: "forged", created_by: "forged", last_edited_by: "forged", version: "777" })).status()).toBe(200);
  expect(await personRow(forged.id)).toMatchObject({ version: 1, created_by: (await current(item.id)).created_by, last_edited_by: (await current(item.id)).created_by });
  expect((await itemEdit(page.request, item.path, "1", keeper.id, { current_keeper_version: "999", edited_by: "forged", status: "draft" })).status()).toBe(200);
  expect(await current(item.id)).toMatchObject({ current_keeper_id: keeper.id, current_keeper_version: 1, status: "complete" });
  const original = await current(item.id);
  expect((await post(page.request, item.path + "/details", { version: "2", name: "New name", description: "Text from an older client" })).status()).toBe(200);
  expect(await current(item.id)).toMatchObject({ current_keeper_id: keeper.id, current_keeper_version: 1, last_edited_by: original.created_by });
  const encoded = new URLSearchParams({ version: "3", name: "Bowl", description: "Description", currentKeeper: keeper.id }); encoded.append("currentKeeper", forged.id);
  expect((await page.request.post(item.path + "/details", { data: encoded.toString(), headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(400);
  expect((await itemEdit(page.request, item.path, "3", randomUUID())).status()).toBe(400);
  expect((await current(item.id)).version).toBe(3);
});

test("lost person creation and edit acknowledgements preserve attempted details without duplicate people or silent overwrites", async ({ page }) => {
  const item = await family(page); await page.goto(item.collection + "/people/new");
  await expect(page.getByLabel("Person name", { exact: true })).toBeEnabled();
  await page.getByLabel("Person name", { exact: true }).fill("Sam");
  await page.getByLabel("Identifying note (optional)").fill("Aunt");
  await page.route("**/people/records", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await page.getByRole("button", { name: "Save person", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Save was interrupted");
  await expect(page.getByLabel("Person name", { exact: true })).toHaveValue("Sam");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Save person", exact: true }).click()]);
  expect((await db.execute("SELECT id FROM people")).rows).toHaveLength(1);
  await expect(page.getByLabel("Identifying note (optional)")).toBeEnabled();
  await page.getByLabel("Identifying note (optional)").fill("My new note");
  await page.route("**/people/*/details", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await page.getByRole("button", { name: "Save person details" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Save was interrupted");
  await page.getByRole("button", { name: "Save person details" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("changed while you were editing");
  await expect(page.getByLabel("Identifying note (optional)")).toHaveValue("My new note");
  const saved = (await db.execute("SELECT id, version FROM people")).rows[0];
  expect(saved.version).toBe(2); expect(await history(String(saved.id))).toHaveLength(1);
});

test("version-five upgrade preserves populated items, photos, sessions and revisions and rolls back a late failure before rerun", async ({ page }) => {
  const item = await family(page);
  expect((await itemEdit(page.request, item.path, "1", "")).status()).toBe(200);
  const photos = (await db.execute("SELECT id, item_id, photo_key, thumbnail_key, sha256 FROM item_photos")).rows;
  const accounts = (await db.execute("SELECT id, email FROM accounts")).rows;
  const sessions = (await db.execute("SELECT * FROM sessions")).rows;
  await removePeopleSchema(db);
  const before = (await db.execute("SELECT id, name, description, version, status, created_by, last_edited_by FROM items")).rows;
  const revisions = (await db.execute("SELECT id, item_id, version, name, description, edited_by FROM item_revisions")).rows;
  await db.execute("CREATE INDEX items_current_keeper ON collections(name)");
  try {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv })).toThrow();
    expect((await db.execute("SELECT id, name, description, version, status, created_by, last_edited_by FROM items")).rows).toEqual(before);
    expect((await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('people','person_revisions')")).rows).toHaveLength(0);
    expect((await db.execute("PRAGMA table_info(items)")).rows.map(row => row.name)).not.toContain("current_keeper_id");
    expect((await db.execute("SELECT name FROM schema_migrations WHERE name='0006_people_and_keepers.sql'")).rows).toHaveLength(0);
  } finally { await db.execute("DROP INDEX items_current_keeper"); }
  for (let run = 0; run < 2; run++) execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect((await db.execute("SELECT id, name, description, version, status, created_by, last_edited_by FROM items")).rows).toEqual(before);
  expect((await db.execute("SELECT id, item_id, version, name, description, edited_by FROM item_revisions")).rows).toEqual(revisions);
  expect((await db.execute("SELECT id, item_id, photo_key, thumbnail_key, sha256 FROM item_photos")).rows).toEqual(photos);
  expect((await db.execute("SELECT id, email FROM accounts")).rows).toEqual(accounts); expect((await db.execute("SELECT * FROM sessions")).rows).toEqual(sessions);
  expect((await db.execute("SELECT current_keeper_id, current_keeper_version FROM items")).rows[0]).toEqual({ current_keeper_id: null, current_keeper_version: null });
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
  await page.goto(item.path); await expect(page.getByRole("heading", { name: "Blue bowl", exact: true })).toBeVisible();
  const keeper = await person(page.request, item.collection); expect((await itemEdit(page.request, item.path, "2", keeper.id)).status()).toBe(200);
  expect((await db.execute("SELECT name FROM schema_migrations")).rows).toHaveLength(6);
});

test("long identifying details remain escaped, labelled and usable by keyboard on mobile without horizontal overflow", async ({ page }) => {
  const item = await family(page); const name = "A".repeat(200); const note = '<img src=x onerror="window.personInjected=true">'.padEnd(400, "n");
  const keeper = await person(page.request, item.collection, name, note);
  await page.setViewportSize({ width: 375, height: 812 }); await page.goto(keeper.path);
  await expect(page.getByLabel("Person name", { exact: true })).toBeEnabled();
  await page.getByLabel("Person name", { exact: true }).focus(); await page.keyboard.press("Tab");
  await expect(page.getByLabel("Identifying note (optional)")).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => (window as Window & { personInjected?: boolean }).personInjected)).toBeUndefined();
  await page.goto(item.collection + "/people");
  await expect(page.getByText(note, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto(item.path); await expect(page.getByLabel("Current keeper (optional)")).toBeEnabled();
  await page.getByLabel("Current keeper (optional)").selectOption(keeper.id);
  await expect(page.getByText("They do not need an app account.", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

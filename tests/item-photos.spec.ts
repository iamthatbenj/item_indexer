import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient, type Value } from "@libsql/client";
import { randomUUID, createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { GetObjectCommand, ListObjectsV2Command, PutBucketPolicyCommand, DeleteBucketPolicyCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { removePeopleSchema } from "./support/legacy-database";
import { familyJourney, dbUrl, outbox, origin, post, operatorEnv } from "./support/family";
import { testStorage } from "./support/storage";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept } = familyJourney(db);
let storage: ReturnType<typeof testStorage>;
const fixture = (name = "small.png") => readFile(`tests/fixtures/photos/${name}`);
const capture = (page: Page) => page.getByRole("region", { name: "Add another photo", exact: true });
const gallery = (page: Page) => page.locator(".item-view");
test.setTimeout(120_000);
test.beforeAll(() => { storage = testStorage(); });
test.beforeEach(async ({ request }) => {
  await db.batch(["story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  // Compile lazy development handlers before any active app page can receive
  // a Fast Refresh navigation. These anonymous requests mutate no records.
  const path = "/collections/prewarm/items/prewarm";
  expect((await post(request, path + "/photo-uploads", {})).status()).toBe(401);
  expect((await post(request, path + "/photo-uploads/prewarm/finish", {})).status()).toBe(401);
  expect((await request.get(path + "/photos/prewarm")).status()).toBe(401);
});
test.afterAll(() => { db.close(); storage.client.destroy(); });

type Item = { id: string; collection: string; path: string };
async function family(page: Page): Promise<Item> {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  const upload = await start(page.request, collection, await fixture());
  expect((await post(page.request, upload.finish, {})).status()).toBe(200);
  return { id: upload.id, collection, path: `${collection}/items/${upload.id}` };
}
async function start(request: APIRequestContext, parent: string, bytes: Buffer, id = randomUUID()) {
  const response = await post(request, `${parent}/photo-uploads`, { id, size: String(bytes.length) });
  expect(response.status()).toBe(200);
  const upload = await response.json();
  expect((await request.put(upload.uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).status()).toBe(200);
  return { id, finish: `${parent}/photo-uploads/${id}/finish` };
}
async function add(request: APIRequestContext, item: Item, bytes?: Buffer) {
  const upload = await start(request, item.path, bytes ?? await fixture());
  expect((await post(request, upload.finish, {})).status()).toBe(200);
  return upload;
}
async function photos(item: Item) { return (await db.execute({ sql: "SELECT id, item_id, photo_key, thumbnail_key, width, height, photo_bytes, sha256, created_at, created_by, removed_at, removed_by FROM item_photos WHERE item_id=? ORDER BY created_at, id", args: [item.id] })).rows; }
async function keys(item: Item) {
  return (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: `photos/${item.collection.split("/").pop()}/${item.id}/` }))).Contents?.map(row => row.Key!).sort() ?? [];
}
async function object(key: string) { return Buffer.from(await (await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }))).Body!.transformToByteArray()); }
const photoPath = (item: Item, id: string) => `${item.path}/photos/${id}`;
const remove = (request: APIRequestContext, item: Item, id: string) => post(request, photoPath(item, id), { confirm: "yes" });
async function insert(table: string, row: Record<string, Value>) {
  await db.execute({ sql: `INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`, args: Object.values(row) });
}

test("ordinary members add camera/library views, open details and remove a view without duplicating collection items", async ({ page, browser }) => {
  const item = await family(page);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await relative.waitForLoadState("load");
  await relative.goto(item.path); await relative.setViewportSize({ width: 375, height: 812 });
  await expect(relative.getByRole("button", { name: "Remove photo 1", exact: true })).toBeDisabled();
  for (const [index, picker] of ["Take a photo", "Choose from your photo library"].entries()) {
    const input = capture(relative).getByLabel(picker, { exact: true });
    await expect(input).toBeEnabled();
    await input.setInputFiles("tests/fixtures/photos/rotated-gps.jpg");
    await capture(relative).getByRole("button", { name: "Add photo", exact: true }).click();
    await expect(gallery(relative)).toHaveCount(index + 2);
  }
  for (const image of await relative.locator(".item-photo").all()) await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  const rows = await photos(item);
  const memberId = (await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id;
  expect(rows.slice(1).map(row => row.created_by)).toEqual([memberId, memberId]);
  const response = await relative.request.get(photoPath(item, String(rows[1].id)), { maxRedirects: 0 });
  expect(response.status()).toBe(307); expect(response.headers()["cache-control"]).toContain("no-store");
  expect((await relative.request.get(response.headers().location)).status()).toBe(200);
  await relative.getByRole("button", { name: "Remove photo 1", exact: true }).click();
  await expect(gallery(relative)).toHaveCount(2);
  expect((await relative.request.get(photoPath(item, String(rows[0].id)), { maxRedirects: 0 })).status()).toBe(404);
  await page.goto(item.collection);
  await expect(page.locator(".draft-grid > li")).toHaveCount(1);
  const thumbnail = await page.request.get(item.path + "/photo?size=thumbnail", { maxRedirects: 0 });
  expect(thumbnail.headers().location).toContain(String(rows[1].thumbnail_key));
  expect(await relative.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(relative.getByRole("link", { name: "Open retained photo 1 at full size", exact: true })).toBeVisible();
  await context.close();
});

test("extra photos reuse real orientation, resolution, metadata and integrity rules without changing item text history", async ({ page }) => {
  const item = await family(page);
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Tea set", description: "Six matching cups." })).status()).toBe(200);
  const before = (await db.execute("SELECT * FROM items")).rows;
  const history = (await db.execute("SELECT * FROM item_revisions")).rows;
  for (const name of ["rotated-gps.jpg", "detail-6000.jpg", "small.webp"]) await add(page.request, item, await fixture(name));
  const rows = await photos(item);
  const expected = [[200, 400], [3200, 2133], [400, 200]];
  for (const [index, row] of rows.slice(1).entries()) {
    const bytes = await object(String(row.photo_key)); const metadata = await sharp(bytes).metadata();
    expect([metadata.width, metadata.height]).toEqual(expected[index]);
    expect(row.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Number(row.photo_bytes)).toBe(bytes.length);
    for (const key of ["exif", "xmp", "iptc", "icc", "orientation"] as const) expect(metadata[key]).toBeUndefined();
    const thumb = await sharp(await object(String(row.thumbnail_key))).metadata();
    expect(Math.max(thumb.width!, thumb.height!)).toBeLessThanOrEqual(480);
  }
  expect((await db.execute("SELECT * FROM items")).rows).toEqual(before);
  expect((await db.execute("SELECT * FROM item_revisions")).rows).toEqual(history);
});

test("malformed, disguised and animated additions never attach or damage the existing photo", async ({ page }) => {
  const item = await family(page); const before = await photos(item); const originalKeys = await keys(item);
  for (const name of ["malformed.jpg", "unsupported.svg", "animated.png", "animated.webp"]) {
    const upload = await start(page.request, item.path, await fixture(name));
    expect((await post(page.request, upload.finish, {})).status()).toBe(400);
    expect(await photos(item)).toEqual(before); expect(await keys(item)).toEqual(originalKeys);
  }
  expect((await page.request.get(item.path + "/photo")).status()).toBe(200);
});

test("attachment reads, additions and removals enforce current membership and collection/item scope", async ({ page, browser }) => {
  const item = await family(page); const extra = await add(page.request, item);
  const otherCollection = await createCollection(page, "Other collection");
  const otherUpload = await start(page.request, otherCollection, await fixture());
  expect((await post(page.request, otherUpload.finish, {})).status()).toBe(200);
  const other: Item = { id: otherUpload.id, collection: otherCollection, path: `${otherCollection}/items/${otherUpload.id}` };
  expect((await remove(page.request, other, extra.id)).status()).toBe(404);
  expect((await page.request.get(photoPath(other, extra.id), { maxRedirects: 0 })).status()).toBe(404);
  expect((await post(page.request, `${otherCollection}/items/${item.id}/photo-uploads`, { id: randomUUID(), size: "40" })).status()).toBe(404);
  const context = await browser.newContext(); const stranger = await context.newPage();
  expect((await stranger.request.get(photoPath(item, extra.id), { maxRedirects: 0 })).status()).toBe(401);
  expect((await remove(stranger.request, item, extra.id)).status()).toBe(401);
  await signIn(stranger, "stranger@example.com", true);
  for (const action of [() => remove(stranger.request, item, extra.id), () => post(stranger.request, item.path + "/photo-uploads", { id: randomUUID(), size: "40" }), () => post(stranger.request, extra.finish, {})]) expect((await action()).status()).toBe(404);
  expect((await stranger.request.get(photoPath(item, extra.id), { maxRedirects: 0 })).status()).toBe(404);
  expect((await photos(item)).filter(row => row.removed_at === null)).toHaveLength(2);
  expect((await photos(other)).filter(row => row.removed_at === null)).toHaveLength(1);
  await context.close();
});

test("upload retries stay bound to their item and uploader, and saved/removed operation replay cannot resurrect a photo", async ({ page, browser }) => {
  const item = await family(page);
  const second = await start(page.request, item.collection, await fixture()); await post(page.request, second.finish, {});
  const pending = await start(page.request, item.path, await fixture());
  expect((await post(page.request, `${item.collection}/items/${second.id}/photo-uploads`, { id: pending.id, size: String((await fixture()).length) })).status()).toBe(404);
  expect((await post(page.request, `${item.collection}/items/${second.id}/photo-uploads/${pending.id}/finish`, {})).status()).toBe(404);
  expect((await post(page.request, `${item.collection}/photo-uploads/${pending.id}/finish`, {})).status()).toBe(404);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  expect((await post(relative.request, pending.finish, {})).status()).toBe(404);
  const results = await Promise.all([post(page.request, pending.finish, {}), post(page.request, pending.finish, {})]);
  expect(results.filter(response => response.status() === 200).length).toBeGreaterThanOrEqual(1);
  expect(results.every(response => [200, 409].includes(response.status()))).toBe(true);
  expect((await post(page.request, pending.finish, {})).status()).toBe(200);
  expect(await photos(item)).toHaveLength(2);
  expect((await remove(page.request, item, pending.id)).status()).toBe(200);
  const files = await keys(item);
  expect((await post(page.request, pending.finish, {})).status()).toBe(200);
  const retry = await post(page.request, item.path + "/photo-uploads", { id: pending.id, size: String((await fixture()).length) });
  expect(await retry.json()).toEqual({ itemUrl: item.path });
  expect((await photos(item)).filter(row => row.removed_at === null)).toHaveLength(1);
  expect(await keys(item)).toEqual(files);
  await context.close();
});

test("competing removal requests cannot remove the last photo and repeated removal never changes another view", async ({ page }) => {
  const item = await family(page); await add(page.request, item); await add(page.request, item);
  const original = await photos(item); const files = await keys(item);
  const results = await Promise.all(original.map(row => remove(page.request, item, String(row.id))));
  expect(results.map(response => response.status()).sort()).toEqual([200, 200, 409]);
  const rows = await photos(item); const active = rows.filter(row => row.removed_at === null);
  expect(active).toHaveLength(1);
  const removed = rows.find(row => row.removed_at !== null)!;
  for (const response of await Promise.all([remove(page.request, item, String(removed.id)), remove(page.request, item, String(removed.id))])) expect(response.status()).toBe(200);
  expect(await photos(item)).toEqual(rows); expect(await keys(item)).toEqual(files);
  expect((await remove(page.request, item, String(active[0].id))).status()).toBe(409);
  await page.goto(item.path); await expect(gallery(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove photo 1", exact: true })).toBeDisabled();
  for (const row of rows) {
    expect((await page.request.get(photoPath(item, String(row.id)), { maxRedirects: 0 })).status()).toBe(row.removed_at === null ? 307 : 404);
    expect(createHash("sha256").update(await object(String(row.photo_key))).digest("hex")).toBe(row.sha256);
  }
});

test("database publication/removal failures roll back relations and clean only unpublished files", async ({ page }) => {
  const item = await family(page); const original = await photos(item); const files = await keys(item);
  const pending = await start(page.request, item.path, await fixture());
  await db.execute("CREATE TRIGGER reject_extra BEFORE UPDATE OF state ON photo_uploads WHEN NEW.state='saved' AND NEW.target_item_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'simulated publication failure'); END");
  try { expect((await post(page.request, pending.finish, {})).status()).toBe(503); } finally { await db.execute("DROP TRIGGER reject_extra"); }
  expect(await photos(item)).toEqual(original); expect(await keys(item)).toEqual(files);
  expect((await post(page.request, pending.finish, {})).status()).toBe(200);
  const beforeRemoval = await photos(item); const savedFiles = await keys(item);
  await db.execute("CREATE TRIGGER reject_remove BEFORE UPDATE OF removed_at ON item_photos BEGIN SELECT RAISE(ABORT, 'simulated removal failure'); END");
  try { expect((await remove(page.request, item, pending.id)).status()).toBe(503); } finally { await db.execute("DROP TRIGGER reject_remove"); }
  expect(await photos(item)).toEqual(beforeRemoval); expect(await keys(item)).toEqual(savedFiles);
  expect((await remove(page.request, item, pending.id)).status()).toBe(200);
  expect(await keys(item)).toEqual(savedFiles);
});

test("failed additional thumbnail storage cleans attempted objects but never the prior view", async ({ page }) => {
  const item = await family(page); const before = await photos(item); const files = await keys(item);
  const pending = await start(page.request, item.path, await fixture());
  await storage.client.send(new PutBucketPolicyCommand({ Bucket: storage.bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:PutObject", Resource: `arn:aws:s3:::${storage.bucket}/photos/*-thumb.jpg` }] }) }));
  try { expect((await post(page.request, pending.finish, {})).status()).toBe(503); }
  finally { await storage.client.send(new DeleteBucketPolicyCommand({ Bucket: storage.bucket })); }
  expect(await photos(item)).toEqual(before); expect(await keys(item)).toEqual(files);
  expect((await post(page.request, pending.finish, {})).status()).toBe(200);
  expect(await photos(item)).toHaveLength(2);
});

test("removal is a database-only retained relationship change even during a storage outage", async ({ page }) => {
  const item = await family(page); const extra = await add(page.request, item); const files = await keys(item);
  execFileSync("podman", ["pause", storage.container]);
  try { expect((await remove(page.request, item, extra.id)).status()).toBe(200); }
  finally { execFileSync("podman", ["unpause", storage.container]); }
  expect(await keys(item)).toEqual(files);
  expect((await photos(item)).find(row => row.id === extra.id)?.removed_at).not.toBeNull();
});

test("revoking membership during extra-photo processing prevents publication and preserves the existing views", async ({ page, browser }) => {
  const item = await family(page); const before = await photos(item); const files = await keys(item);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const member = (await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0];
  const pending = await start(relative.request, item.path, await fixture());
  execFileSync("podman", ["pause", storage.container]);
  let finishing: ReturnType<typeof post> | undefined;
  try {
    finishing = post(relative.request, pending.finish, {});
    await expect.poll(async () => (await db.execute({ sql: "SELECT state FROM photo_uploads WHERE id=?", args: [pending.id] })).rows[0].state).toBe("processing");
    expect((await post(page.request, `${item.collection}/members/${member.id}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  } finally { execFileSync("podman", ["unpause", storage.container]); }
  expect((await finishing!).status()).toBe(409);
  expect(await photos(item)).toEqual(before); expect(await keys(item)).toEqual(files);
  expect((await remove(relative.request, item, String(before[0].id))).status()).toBe(404);
  expect((await relative.request.get(photoPath(item, String(before[0].id)), { maxRedirects: 0 })).status()).toBe(404);
  await context.close();
});

test("lost add/remove acknowledgements retry safely through the browser", async ({ page }) => {
  const item = await family(page); await page.goto(item.path);
  await capture(page).getByLabel("Choose from your photo library", { exact: true }).setInputFiles("tests/fixtures/photos/small.png");
  await page.route("**/photo-uploads/*/finish", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await capture(page).getByRole("button", { name: "Add photo", exact: true }).click();
  await expect(capture(page).getByRole("alert")).toContainText("save was interrupted");
  expect(await photos(item)).toHaveLength(2);
  await capture(page).getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(gallery(page)).toHaveCount(2); expect(await photos(item)).toHaveLength(2);
  const removed = await gallery(page).first().getAttribute("data-photo-id");
  await page.route(`**/photos/${removed}`, async route => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    await route.fetch(); await route.abort("failed");
  }, { times: 1 });
  await page.getByRole("button", { name: "Remove photo 1", exact: true }).click();
  await expect(page.getByRole("region", { name: "Item photos", exact: true }).getByRole("alert")).toContainText("Removal was interrupted");
  await page.getByRole("button", { name: "Remove photo 1", exact: true }).click();
  await expect(gallery(page)).toHaveCount(1);
  expect((await photos(item)).filter(row => row.removed_at === null)).toHaveLength(1);
});

test("photo refreshes preserve unsaved text and its original editing version, even when another tab saved meanwhile", async ({ page }) => {
  const item = await family(page);
  expect((await post(page.request, item.path + "/details", { version: "invalid", name: "", description: "" })).status()).toBe(400);
  await page.goto(item.path);
  const editor = page.getByRole("region", { name: "Name and describe this belonging", exact: true });
  await expect(editor.getByLabel("Name", { exact: true })).toBeEnabled();
  await editor.getByLabel("Name", { exact: true }).fill("My unsaved name");
  await editor.getByLabel("Short description", { exact: true }).fill("My unsaved description.");
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Already saved elsewhere", description: "Another tab's newer text." })).status()).toBe(200);
  await capture(page).getByLabel("Choose from your photo library", { exact: true }).setInputFiles("tests/fixtures/photos/small.png");
  await capture(page).getByRole("button", { name: "Add photo", exact: true }).click();
  await expect(gallery(page)).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Already saved elsewhere", exact: true })).toBeVisible();
  await expect(editor.getByLabel("Name", { exact: true })).toHaveValue("My unsaved name");
  await expect(editor.locator("input[name=version]")).toHaveValue("1");
  await editor.getByRole("button", { name: "Save item details", exact: true }).click();
  await expect(editor.getByRole("alert")).toContainText("saved version changed");
  await expect(editor.getByLabel("Short description", { exact: true })).toHaveValue("My unsaved description.");
  expect((await db.execute("SELECT name, version FROM items")).rows[0]).toMatchObject({ name: "Already saved elsewhere", version: 2 });
  expect((await db.execute("SELECT * FROM item_revisions")).rows).toHaveLength(1);
});

test("additional-photo forms enforce origin, body bounds, confirmation, expiry and item-bound lease retries", async ({ page }) => {
  const item = await family(page); const extra = await add(page.request, item);
  expect((await page.request.post(photoPath(item, extra.id), { form: { confirm: "yes" }, headers: { Origin: "https://foreign.example" } })).status()).toBe(403);
  expect((await post(page.request, photoPath(item, extra.id), {})).status()).toBe(400);
  expect((await post(page.request, item.path + "/photo-uploads", { id: randomUUID(), size: String(20 * 1024 * 1024 + 1) })).status()).toBe(400);
  expect((await page.request.post(item.path + "/photo-uploads", { data: "id=a&id=b&size=12", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" } })).status()).toBe(400);
  expect((await post(page.request, item.path + "/photo-uploads", { id: "a".repeat(5000), size: "1" })).status()).toBe(413);
  const pending = await start(page.request, item.path, await fixture());
  await db.execute({ sql: "UPDATE photo_uploads SET state='processing', attempt='old', lease_until=? WHERE id=?", args: [Date.now() + 60_000, pending.id] });
  expect((await post(page.request, pending.finish, {})).status()).toBe(409);
  await db.execute({ sql: "UPDATE photo_uploads SET lease_until=0 WHERE id=?", args: [pending.id] });
  expect((await post(page.request, pending.finish, {})).status()).toBe(200);
  const expired = await start(page.request, item.path, await fixture());
  await db.execute({ sql: "UPDATE photo_uploads SET expires_at=0 WHERE id=?", args: [expired.id] });
  expect((await post(page.request, expired.finish, {})).status()).toBe(410);
});

test("populated version-four upgrade preserves photos, text revisions and sessions, rolls back failures and remains rerunnable", async ({ page }) => {
  const item = await family(page);
  await post(page.request, item.path + "/details", { version: "1", name: "Existing name", description: "Existing description" });
  const original = (await photos(item))[0];
  const legacyPhoto = Object.fromEntries(Object.entries(original).filter(([key]) => !["created_by", "removed_at", "removed_by"].includes(key)));
  const upload = { ...(await db.execute("SELECT * FROM photo_uploads")).rows[0] }; delete upload.target_item_id;
  const items = (await db.execute("SELECT * FROM items")).rows; const history = (await db.execute("SELECT * FROM item_revisions")).rows;
  const sessions = (await db.execute("SELECT * FROM sessions")).rows;
  await removePeopleSchema(db);
  await db.execute("DROP TABLE photo_uploads"); await db.execute("DROP TABLE item_photos");
  const statements = (await readFile("migrations/0003_photo_drafts.sql", "utf8")).split(";").map(s => s.trim()).filter(Boolean);
  for (const statement of statements.filter(s => s.startsWith("CREATE TABLE photo_uploads") || s.startsWith("CREATE INDEX photo_uploads_") || s.startsWith("CREATE TABLE item_photos"))) await db.execute(statement);
  await insert("item_photos", legacyPhoto); await insert("photo_uploads", upload);
  await db.execute("DELETE FROM schema_migrations WHERE name='0005_multiple_item_photos.sql'");
  await db.execute("CREATE INDEX item_photos_item ON accounts(id)");
  try { expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv })).toThrow(); }
  finally { await db.execute("DROP INDEX item_photos_item"); }
  expect((await db.execute("SELECT * FROM item_photos")).rows).toEqual([legacyPhoto]);
  expect((await db.execute("SELECT * FROM schema_migrations WHERE name='0005_multiple_item_photos.sql'")).rows).toHaveLength(0);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect((await photos(item))[0]).toEqual(original);
  expect((await db.execute("SELECT * FROM items")).rows).toEqual(items); expect((await db.execute("SELECT * FROM item_revisions")).rows).toEqual(history);
  expect((await db.execute("SELECT * FROM sessions")).rows).toEqual(sessions);
  expect((await post(page.request, `${item.collection}/photo-uploads/${item.id}/finish`, {})).status()).toBe(200);
  await add(page.request, item); expect((await remove(page.request, item, String(original.id))).status()).toBe(200);
  const after = await photos(item);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect(await photos(item)).toEqual(after); expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
  expect((await page.request.get(item.path + "/photo")).status()).toBe(200);
});

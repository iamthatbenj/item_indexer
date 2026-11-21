import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID, createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, writeFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { familyJourney, dbUrl, outbox, origin, operatorEnv, post } from "./support/family";
import { testStorage } from "./support/storage";
import { removeInventorySchema } from "./support/legacy-database";

const db = createClient({ url: dbUrl, timeout: 5000 });
const { signIn, createCollection, invite, accept } = familyJourney(db);
const run = promisify(execFile);
let storage: ReturnType<typeof testStorage>;
let observer: APIRequestContext;
const observedCollections = new Set<string>();
test.setTimeout(120_000);
test.beforeAll(() => { storage = testStorage(); });
test.beforeEach(async ({ request, page }) => {
  observer = page.request; observedCollections.clear();
  await db.execute("DROP TRIGGER IF EXISTS inventory_publication_fault");
  await db.batch(["inventory_export_attempts", "inventory_exports", "story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  await request.get("/collections/prewarm/inventory");
  await request.get("/collections/prewarm/inventory/requests");
  await request.get("/collections/prewarm/inventory/requests/prewarm/download");
  expect((await post(request, "/collections/prewarm/inventory/requests", { action: "create", id: randomUUID() })).status()).toBe(401);
});
test.afterEach(async ({ page }) => {
  await quiesce(page);
  // Do not let background generation outlive a destructive fixture reset.
  await expect.poll(async () => {
    let active = 0;
    for (const collection of observedCollections) {
      const response = await observer.get(endpoint(collection)); expect(response.status()).toBe(200);
      active += (await response.json()).jobs.filter((job: { status: string }) => job.status === "processing").length;
    }
    return active;
  }, { timeout: 40_000 }).toBe(0);
  await db.execute("DROP TRIGGER IF EXISTS inventory_publication_fault");
  await db.batch(["DELETE FROM inventory_export_attempts", "DELETE FROM inventory_exports"], "write");
  const objects = (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket }))).Contents ?? [];
  for (let offset = 0; offset < objects.length; offset += 20) await Promise.all(objects.slice(offset, offset + 20).map(object => storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: object.Key! }))));
});
test.afterAll(() => { db.close(); storage.client.destroy(); });

const endpoint = (collection: string) => collection + "/inventory/requests";
async function capture(request: APIRequestContext, collection: string, itemId?: string) {
  observedCollections.add(collection);
  const bytes = await readFile("tests/fixtures/photos/small.png"); const id = randomUUID();
  const path = itemId ? `${collection}/items/${itemId}/photo-uploads` : collection + "/photo-uploads";
  const start = await post(request, path, { id, size: String(bytes.length) }); expect(start.status()).toBe(200);
  expect((await request.put((await start.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  expect((await post(request, `${path}/${id}/finish`, {})).status()).toBe(200);
  return id;
}
async function family(page: Page) {
  await signIn(page, "founder@example.com", true); const collection = await createCollection(page);
  const id = await capture(page.request, collection);
  const account = String((await db.execute("SELECT id FROM accounts WHERE email='founder@example.com'")).rows[0].id);
  return { collection, id, account, path: `${collection}/items/${id}` };
}
async function job(request: APIRequestContext, collection: string, id = randomUUID()) {
  observedCollections.add(collection);
  const response = await post(request, endpoint(collection), { action: "create", id }); expect(response.status()).toBe(202);
  const result = await response.json(); expect(result.job.status).toBe("processing"); return id;
}
async function terminal(id: string, status = "ready") {
  // Poll through the public app while its background worker is writing. A
  // second native file connection must not hold readers across worker commits.
  await expect.poll(async () => {
    for (const collection of observedCollections) {
      const response = await observer.get(endpoint(collection)); expect(response.status()).toBe(200);
      const found = (await response.json()).jobs.find((job: { id: string }) => job.id === id);
      if (found) return found.status;
    }
    return undefined;
  }, { timeout: 35_000 }).toBe(status);
  return (await db.execute({ sql: "SELECT * FROM inventory_exports WHERE id=?", args: [id] })).rows[0];
}
async function artifact(request: APIRequestContext, collection: string, id: string) {
  const grant = await request.get(endpoint(collection) + `/${id}/download`, { maxRedirects: 0 }); expect(grant.status()).toBe(302);
  const response = await request.get(grant.headers().location); expect(response.status()).toBe(200); expect(response.headers()["content-type"]).toContain("application/pdf");
  return { bytes: await response.body(), url: grant.headers().location };
}
async function quiesce(...pages: Page[]) {
  await Promise.all(pages.map(async page => { await page.goto("/"); await page.waitForLoadState("networkidle"); }));
}
async function seedMore(page: Page, collection: string, id: string, count: number) {
  // Leave live clients before direct fixture writes or DDL, just as populated
  // migration fixtures leave them before rebuilding live schemas.
  await quiesce(page);
  const source = (await db.execute({ sql: "SELECT * FROM item_photos WHERE item_id=? ORDER BY created_at,id LIMIT 1", args: [id] })).rows[0];
  const item = (await db.execute({ sql: "SELECT * FROM items WHERE id=?", args: [id] })).rows[0];
  const raw = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: String(source.photo_key) }));
  const photo = Buffer.from(await raw.Body!.transformToByteArray());
  const thumb = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: String(source.thumbnail_key) }));
  const thumbnail = Buffer.from(await thumb.Body!.transformToByteArray());
  for (let i = 0; i < count; i++) {
    const itemId = randomUUID(); const photoId = randomUUID(); const prefix = `collections/${String(item.collection_id)}/inventory-fixture/${photoId}`;
    await Promise.all([storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: prefix + ".jpg", Body: photo, ContentType: "image/jpeg" })), storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: prefix + "-thumb.jpg", Body: thumbnail, ContentType: "image/jpeg" }))]);
    await db.batch([
      { sql: "INSERT INTO items(id,collection_id,created_by,created_at,name,description) VALUES(?,?,?,?,?,?)", args: [itemId, String(item.collection_id), String(item.created_by), Number(item.created_at) + i + 1, `Bowl ${i + 1} — José 家族 🏺 ` + "W".repeat(i === 0 ? 150 : 0), i === 0 ? "Long retained description. ".repeat(44) : `Description for bowl ${i + 1}.`] },
      { sql: "INSERT INTO item_photos(id,item_id,photo_key,thumbnail_key,width,height,photo_bytes,sha256,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [photoId, itemId, prefix + ".jpg", prefix + "-thumb.jpg", Number(source.width), Number(source.height), photo.length, String(source.sha256), Number(source.created_at) + i + 1, String(item.created_by)] },
    ], "write");
  }
}

test("an ordinary member downloads a self-contained multi-page PDF with saved text, draft placeholders and one thumbnail per item", async ({ page, browser }, info) => {
  const item = await family(page); await capture(page.request, item.collection, item.id); await seedMore(page, item.collection, item.id, 30);
  const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  await relative.getByRole("link", { name: "Download a compact inventory PDF", exact: true }).click();
  await expect(relative.getByRole("button", { name: "Generate inventory PDF", exact: true })).toBeEnabled({ timeout: 30_000 });
  const before = Date.now(); await relative.getByRole("button", { name: "Generate inventory PDF", exact: true }).click();
  const downloadLink = relative.getByRole("link", { name: "Download private inventory PDF", exact: true }); await expect(downloadLink).toBeVisible({ timeout: 35_000 });
  const [download] = await Promise.all([relative.waitForEvent("download"), downloadLink.click()]);
  const path = info.outputPath("member-inventory.pdf"); await download.saveAs(path);
  const record = (await db.execute("SELECT * FROM inventory_exports")).rows[0];
  const bytes = await readFile(path); expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.sha256);
  expect(bytes.length).toBe(Number(record.pdf_bytes)); expect(Number(record.page_count)).toBeGreaterThan(1);
  expect((await db.execute("SELECT requested_by FROM inventory_exports")).rows[0].requested_by).not.toBe(item.account);
  expect((await db.execute("SELECT * FROM item_revisions")).rows).toHaveLength(0);
  expect((await db.execute("SELECT id FROM item_photos")).rows).toHaveLength(32);
  expect((await post(relative.request, "/auth/sign-out", {})).status()).toBe(303);
  await context.setOffline(true);
  const text = (await run("pdftotext", ["-layout", path, "-"])).stdout;
  expect(text).toContain("Untitled belonging — Draft item"); expect(text).toContain("No short description recorded.");
  expect(text).toContain("José 家族 🏺"); expect(text).toContain("Description for bowl 30.");
  expect(text.match(/Item and short description/g)).toHaveLength(Number(record.page_count));
  const images = (await run("pdfimages", ["-list", path])).stdout.split("\n").filter(line => /^\s*\d+\s+\d+\s+image\s/.test(line)); expect(images).toHaveLength(31);
  const fonts = (await run("pdffonts", [path])).stdout; expect(fonts).toContain("NotoSansCJKsc"); expect(fonts).not.toContain(" no ");
  await run("pdftoppm", ["-f", "1", "-singlefile", "-scale-to", "1100", "-png", path, info.outputPath("member-inventory-page1")]);
  console.log(JSON.stringify({ inventoryItems: 31, pdfBytes: bytes.length, pages: record.page_count, memberJourneyMs: Date.now() - before }));
  await context.close();
});

test("generation and new download grants enforce current collection membership and fixed collection scope", async ({ page, browser }) => {
  const item = await family(page); const invitation = await invite(page, item.collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const id = await job(relative.request, item.collection); const ready = await terminal(id);
  const saved = await artifact(relative.request, item.collection, id);
  const unsigned = new URL(saved.url); unsigned.search = ""; expect((await relative.request.get(unsigned.toString())).status()).toBe(403);
  const otherContext = await browser.newContext(); const other = await otherContext.newPage(); await signIn(other, "outsider@example.com", true); const otherCollection = await createCollection(other, "Unrelated family collection");
  expect((await post(other.request, endpoint(item.collection), { action: "create", id: randomUUID() })).status()).toBe(404);
  expect((await other.request.get(endpoint(item.collection))).status()).toBe(404);
  expect((await other.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await other.request.get(endpoint(otherCollection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await post(other.request, endpoint(otherCollection), { action: "retry", id })).status()).toBe(409);
  const member = String((await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id);
  expect((await post(page.request, `${item.collection}/members/${member}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  expect((await relative.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await post(relative.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(404);
  const remaining = await artifact(page.request, item.collection, id); expect(remaining.bytes).toEqual(saved.bytes);
  expect((await db.execute({ sql: "SELECT sha256 FROM inventory_exports WHERE id=?", args: [id] })).rows[0].sha256).toBe(ready.sha256);
  await context.close(); await otherContext.close();
});

test("a missing retained thumbnail fails without a partial download; retry uses the original saved snapshot", async ({ page }, info) => {
  const item = await family(page); expect((await post(page.request, item.path + "/details", { version: "1", name: "Name at snapshot", description: "Snapshot description." })).status()).toBe(200);
  const key = String((await db.execute("SELECT thumbnail_key FROM item_photos")).rows[0].thumbnail_key);
  const body = Buffer.from(await (await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }))).Body!.transformToByteArray());
  await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
  const id = await job(page.request, item.collection); await terminal(id, "failed");
  expect((await page.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
  expect((await db.execute("SELECT artifact_key FROM inventory_exports")).rows[0].artifact_key).toBeNull();
  expect((await post(page.request, item.path + "/details", { version: "2", name: "Later saved name", description: "Later description." })).status()).toBe(200);
  await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: body, ContentType: "image/jpeg" }));
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(202);
  const record = await terminal(id); expect(record.attempts).toBe(2);
  const pdf = await artifact(page.request, item.collection, id); const path = info.outputPath("retried.pdf"); await import("node:fs/promises").then(fs => fs.writeFile(path, pdf.bytes));
  const text = (await run("pdftotext", [path, "-"])).stdout; expect(text).toContain("Name at snapshot"); expect(text).not.toContain("Later saved name");
  const status = await (await page.request.get(endpoint(item.collection))).text(); expect(status).not.toContain("thumbnailKey"); expect(status).not.toContain("inventories/");
});

test("concurrent and lost-response retries do not create duplicate generation attempts or artifact identities", async ({ page }) => {
  const item = await family(page); const id = randomUUID();
  const responses = await Promise.all([post(page.request, endpoint(item.collection), { action: "create", id }), post(page.request, endpoint(item.collection), { action: "create", id })]);
  expect(responses.map(response => response.status()).sort()).toEqual([200, 202]); await terminal(id);
  expect((await db.execute("SELECT * FROM inventory_export_attempts")).rows).toHaveLength(1);
  await page.goto(item.collection + "/inventory"); await expect(page.getByRole("button", { name: "Generate inventory PDF", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.route("**/inventory/requests", async route => { if (route.request().method() === "POST") { await route.fetch(); await route.abort("failed"); } else await route.continue(); }, { times: 1 });
  await page.getByRole("button", { name: "Generate inventory PDF", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("request");
  const all = (await db.execute("SELECT id FROM inventory_exports")).rows; expect(all).toHaveLength(2); const second = String(all.find(row => row.id !== id)!.id); await terminal(second);
  await page.getByRole("button", { name: "Generate inventory PDF", exact: true }).click(); await expect(page.getByRole("link", { name: "Download private inventory PDF", exact: true })).toHaveCount(2);
  expect((await db.execute("SELECT * FROM inventory_exports")).rows).toHaveLength(2); expect((await db.execute("SELECT * FROM inventory_export_attempts")).rows).toHaveLength(2);
});

test("empty collections produce an honest printable inventory; expiry, discard, capacity and input validation do not alter family records", async ({ page }, info) => {
  await signIn(page, "founder@example.com", true); const collection = await createCollection(page); const id = await job(page.request, collection); await terminal(id);
  const pdf = await artifact(page.request, collection, id); const path = info.outputPath("empty.pdf"); await import("node:fs/promises").then(fs => fs.writeFile(path, pdf.bytes));
  expect((await run("pdftotext", [path, "-"])).stdout).toContain("No saved items in this family collection");
  expect((await post(page.request, endpoint(collection), { action: "create", id: "bad" })).status()).toBe(400);
  expect((await post(page.request, endpoint(collection), { action: "create", id: randomUUID(), accountId: randomUUID() })).status()).toBe(409);
  expect((await page.request.post(endpoint(collection), { form: { action: "create", id: randomUUID() }, headers: { Origin: "https://unrelated.example" } })).status()).toBe(403);
  for (let i = 0; i < 4; i++) { const other = await job(page.request, collection); await terminal(other); }
  expect((await post(page.request, endpoint(collection), { action: "create", id: randomUUID() })).status()).toBe(429);
  await quiesce(page);
  await db.execute({ sql: "UPDATE inventory_exports SET expires_at=0 WHERE id=?", args: [id] });
  expect((await page.request.get(endpoint(collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
  expect((await post(page.request, endpoint(collection), { action: "discard", id })).status()).toBe(200);
  const fresh = await job(page.request, collection); await terminal(fresh);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0); expect((await db.execute("SELECT * FROM memberships")).rows).toHaveLength(1);
});

test("large representative inventories stay bounded; oversized collections and unsupported glyphs never yield a misleading PDF", async ({ page }) => {
  const item = await family(page); await seedMore(page, item.collection, item.id, 99);
  const before = Date.now(); const id = await job(page.request, item.collection); const record = await terminal(id);
  const downloaded = await artifact(page.request, item.collection, id); expect(downloaded.bytes.length).toBeLessThan(16 * 1024 * 1024);
  console.log(JSON.stringify({ inventoryItems: 100, pdfBytes: downloaded.bytes.length, pages: record.page_count, generationAndDownloadMs: Date.now() - before }));
  await seedMore(page, item.collection, item.id, 101);
  expect((await post(page.request, endpoint(item.collection), { action: "create", id: randomUUID() })).status()).toBe(422);
  expect((await db.execute("SELECT * FROM inventory_exports")).rows).toHaveLength(1);
});

test("unsupported text and missing ready artifacts fail explicitly rather than publishing an incomplete or unverifiable PDF", async ({ page }) => {
  const item = await family(page); expect((await post(page.request, item.path + "/details", { version: "1", name: "Unrenderable " + String.fromCodePoint(0x10ffff), description: "Still retained." })).status()).toBe(200);
  const bad = await job(page.request, item.collection); await terminal(bad, "failed");
  expect((await page.request.get(endpoint(item.collection) + `/${bad}/download`, { maxRedirects: 0 })).status()).toBe(409);
  expect((await post(page.request, item.path + "/details", { version: "2", name: "Renderable", description: "Saved description." })).status()).toBe(200);
  const good = await job(page.request, item.collection); const ready = await terminal(good);
  await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: String(ready.artifact_key) }));
  expect((await page.request.get(endpoint(item.collection) + `/${good}/download`, { maxRedirects: 0 })).status()).toBe(503);
  expect((await db.execute("SELECT name FROM items")).rows[0].name).toBe("Renderable");
});

for (const fault of ["publication failure", "membership removal"] as const) {
  test(`${fault} at publication cannot expose a private candidate; a fresh authorized retry uses a different attempt key`, async ({ page, browser }) => {
    const item = await family(page); const invitation = await invite(page, item.collection, "relative@example.com");
    const context = await browser.newContext(); const relative = await context.newPage(); await signIn(relative, "relative@example.com"); await accept(relative, invitation);
    await quiesce(page, relative);
    await db.execute(fault === "publication failure"
      ? "CREATE TRIGGER inventory_publication_fault BEFORE UPDATE OF status ON inventory_exports WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT,'publication fault'); END"
      : "CREATE TRIGGER inventory_publication_fault AFTER UPDATE OF phase ON inventory_exports WHEN NEW.phase='publishing' BEGIN DELETE FROM memberships WHERE collection_id=NEW.collection_id AND account_id=NEW.requested_by; END");
    let id: string;
    try {
      id = await job(relative.request, item.collection); const failed = await terminal(id, "failed"); expect(failed.artifact_key).toBeNull();
      expect((await page.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
      if (fault === "membership removal") expect((await relative.request.get(endpoint(item.collection))).status()).toBe(404);
      const candidates = (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: `inventories/${item.collection.split("/").pop()}/${id}/` }))).Contents ?? [];
      expect(candidates).toHaveLength(1);
    } finally { await quiesce(page, relative); await db.execute("DROP TRIGGER inventory_publication_fault"); }
    if (fault === "membership removal") await accept(relative, await invite(page, item.collection, "relative@example.com"));
    expect((await post(relative.request, endpoint(item.collection), { action: "retry", id: id! })).status()).toBe(202);
    const ready = await terminal(id!); expect(ready.attempts).toBe(2);
    const attempts = (await db.execute("SELECT candidate_key FROM inventory_export_attempts ORDER BY attempt")).rows;
    expect(attempts[0].candidate_key).not.toBe(attempts[1].candidate_key); expect(ready.artifact_key).toBe(attempts[1].candidate_key);
    expect((await artifact(relative.request, item.collection, id!)).bytes.length).toBe(Number(ready.pdf_bytes));
    expect((await post(relative.request, endpoint(item.collection), { action: "discard", id: id! })).status()).toBe(200);
    expect((await db.execute("SELECT * FROM inventory_export_attempts")).rows).toHaveLength(0);
    expect((await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: "inventories/" }))).Contents ?? []).toHaveLength(0);
    expect((await db.execute("SELECT id FROM items")).rows).toHaveLength(1); expect((await db.execute("SELECT id FROM item_photos")).rows).toHaveLength(1);
    await context.close();
  });
}

test("an abandoned durable lease is visibly interrupted, retryable and bounded to three attempts", async ({ page }) => {
  const item = await family(page); const key = String((await db.execute("SELECT thumbnail_key FROM item_photos")).rows[0].thumbnail_key);
  await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
  const id = await job(page.request, item.collection); await terminal(id, "failed");
  // Simulate the durable state left by a terminated invocation, not an internal
  // worker mock. All retries still traverse the public authenticated endpoint.
  await quiesce(page);
  await db.execute({ sql: "UPDATE inventory_exports SET status='processing',phase='photos',lease=?,lease_expires_at=0,error=NULL WHERE id=?", args: [randomUUID(), id] });
  expect((await (await page.request.get(endpoint(item.collection))).json()).jobs[0].status).toBe("interrupted");
  for (let attempt = 2; attempt <= 3; attempt++) {
    expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(202);
    expect((await terminal(id, "failed")).attempts).toBe(attempt);
  }
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(409);
  expect((await db.execute("SELECT * FROM inventory_export_attempts")).rows).toHaveLength(3);
  expect((await page.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
});

test("CJK and mixed-font text survive an automatic page break without losing glyphs or continuation", async ({ page }, info) => {
  const item = await family(page); await seedMore(page, item.collection, item.id, 5);
  const items = (await db.execute({ sql: "SELECT id FROM items WHERE collection_id=? ORDER BY created_at,id", args: [item.collection.split("/").pop()!] })).rows;
  const description = "家族".repeat(500) + " AFTER café 🏺 " + "記憶".repeat(50);
  for (let index = 0; index < items.length; index++) {
    expect((await post(page.request, `${item.collection}/items/${String(items[index].id)}/details`, {
      version: "1", name: `Entry ${index + 1}`, description: index === items.length - 1 ? description : "Filler.",
    })).status()).toBe(200);
  }
  const id = await job(page.request, item.collection); const ready = await terminal(id);
  expect(Number(ready.page_count)).toBeGreaterThan(1);
  const path = info.outputPath("cjk-continuation.pdf"); await writeFile(path, (await artifact(page.request, item.collection, id)).bytes);
  const text = (await run("pdftotext", ["-layout", path, "-"])).stdout;
  expect(text.match(/[家族記憶]/gu)?.join("")).toBe("家族".repeat(500) + "記憶".repeat(50));
  expect(text.replace(/\s/gu, "")).toContain("AFTERcafé🏺");
  expect(text.match(/Item and short description/g)).toHaveLength(Number(ready.page_count));
  expect(text).toContain("item 6 continued");
});

test("unusual collection whitespace and a long multi-page item remain printable and keyboard usable on mobile", async ({ page }, info) => {
  await signIn(page, "founder@example.com", true);
  const response = await post(page.request, "/collections", { name: "F\n".repeat(60) }); expect(response.status()).toBe(303);
  const collection = new URL(response.headers().location).pathname; const id = await capture(page.request, collection);
  const name = "W".repeat(200); const description = "START\n" + "line\n".repeat(235) + "END";
  expect((await post(page.request, `${collection}/items/${id}/details`, { version: "1", name, description })).status()).toBe(200);
  await page.setViewportSize({ width: 375, height: 812 }); await page.goto(collection + "/inventory");
  const generate = page.getByRole("button", { name: "Generate inventory PDF", exact: true }); await expect(generate).toBeEnabled({ timeout: 30_000 }); await generate.focus(); await page.keyboard.press("Enter");
  const link = page.getByRole("link", { name: "Download private inventory PDF", exact: true }); await expect(link).toBeVisible({ timeout: 35_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]); const path = info.outputPath("long-inventory.pdf"); await download.saveAs(path);
  const text = (await run("pdftotext", [path, "-"])).stdout;
  expect(text.replace(/\s/g, "")).toContain(name); expect(text).toContain("START"); expect(text).toContain("END");
  expect(text.match(/\bline\b/g)).toHaveLength(235);
  expect((await run("pdfinfo", [path])).stdout).toContain("Pages:");
});

test("automatic status checking has a wall-clock budget even when responses are delayed", async ({ page }) => {
  const item = await family(page); await page.goto(item.collection + "/inventory");
  await expect(page.getByRole("button", { name: "Generate inventory PDF", exact: true })).toBeEnabled({ timeout: 30_000 });
  let accepted: unknown; let checks = 0;
  await page.route("**/inventory/requests", async route => {
    if (route.request().method() === "POST") {
      const response = await route.fetch(); accepted = (await response.json()).job; await route.fulfill({ response });
    } else {
      checks++;
      // Delay the real browser transport, not an internal polling function.
      // Twenty delay-only iterations would run for about 60 seconds.
      await new Promise(resolve => setTimeout(resolve, 1500));
      try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobs: [accepted] }) }); }
      catch (error) { if (!route.request().failure()) throw error; }
    }
  });
  await page.getByRole("button", { name: "Generate inventory PDF", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("paused after 30 seconds", { timeout: 35_000 });
  const paused = checks; await page.waitForTimeout(3500); expect(checks).toBe(paused);
  await page.unroute("**/inventory/requests");
  await page.getByRole("button", { name: "Check inventory status", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download private inventory PDF", exact: true })).toBeVisible();
});

test("the additive version-nine upgrade preserves populated family content, rolls back partial DDL and is rerunnable", async ({ page }) => {
  const item = await family(page); await quiesce(page);
  const before = (await db.execute("SELECT * FROM item_photos")).rows;
  await removeInventorySchema(db);
  await db.execute("CREATE TABLE inventory_export_attempts(sentinel TEXT)");
  try {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv })).toThrow();
    expect((await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory_exports'")).rows).toHaveLength(0);
    expect((await db.execute("SELECT name FROM schema_migrations WHERE name='0009_inventory_exports.sql'")).rows).toHaveLength(0);
    expect((await db.execute("SELECT * FROM item_photos")).rows).toEqual(before);
  } finally {
    await db.execute("DROP TABLE inventory_export_attempts");
    execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  }
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect((await db.execute("SELECT * FROM schema_migrations")).rows).toHaveLength(12);
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
  expect((await page.request.get(endpoint(item.collection))).status()).toBe(200);
});

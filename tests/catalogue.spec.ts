import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, writeFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { familyJourney, dbUrl, outbox, origin, operatorEnv, post } from "./support/family";
import { testStorage } from "./support/storage";
import { removeCatalogueSchema } from "./support/legacy-database";

const db = createClient({ url: dbUrl, timeout: 5000 });
const { signIn, createCollection, invite, accept } = familyJourney(db);
const run = promisify(execFile);
let storage: ReturnType<typeof testStorage>;
let observer: APIRequestContext;
const observedCollections = new Set<string>();
test.setTimeout(180_000);
test.beforeAll(() => { storage = testStorage(); });
test.beforeEach(async ({ request, page }) => {
  observer = page.request; observedCollections.clear();
  await db.execute("DROP TRIGGER IF EXISTS catalogue_publication_fault");
  await db.batch(["catalogue_export_attempts", "catalogue_exports", "inventory_export_attempts", "inventory_exports", "story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  await request.get("/collections/prewarm/catalogue");
  await request.get("/collections/prewarm/catalogue/requests");
  await request.get("/collections/prewarm/catalogue/requests/prewarm/download");
  expect((await post(request, "/collections/prewarm/catalogue/requests", { action: "create", id: randomUUID() })).status()).toBe(401);
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
  await db.execute("DROP TRIGGER IF EXISTS catalogue_publication_fault");
  await db.batch(["DELETE FROM catalogue_export_attempts", "DELETE FROM catalogue_exports", "DELETE FROM inventory_export_attempts", "DELETE FROM inventory_exports"], "write");
  const objects = (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket }))).Contents ?? [];
  for (let offset = 0; offset < objects.length; offset += 20) await Promise.all(objects.slice(offset, offset + 20).map(object => storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: object.Key! }))));
});
test.afterAll(() => { db.close(); storage.client.destroy(); });

const endpoint = (collection: string) => collection + "/catalogue/requests";
async function capture(request: APIRequestContext, collection: string, itemId?: string, file = "small.png") {
  observedCollections.add(collection);
  const bytes = await readFile(`tests/fixtures/photos/${file}`); const id = randomUUID();
  const path = itemId ? `${collection}/items/${itemId}/photo-uploads` : collection + "/photo-uploads";
  const start = await post(request, path, { id, size: String(bytes.length) }); expect(start.status()).toBe(200);
  expect((await request.put((await start.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  expect((await post(request, `${path}/${id}/finish`, {})).status()).toBe(200);
  return id;
}
async function family(page: Page, name = "Family one") {
  await signIn(page, "founder@example.com", true); const collection = await createCollection(page, name);
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
  return (await db.execute({ sql: "SELECT * FROM catalogue_exports WHERE id=?", args: [id] })).rows[0];
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
    const itemId = randomUUID(); const photoId = randomUUID(); const prefix = `collections/${String(item.collection_id)}/catalogue-fixture/${photoId}`;
    await Promise.all([storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: prefix + ".jpg", Body: photo, ContentType: "image/jpeg" })), storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: prefix + "-thumb.jpg", Body: thumbnail, ContentType: "image/jpeg" }))]);
    await db.batch([
      { sql: "INSERT INTO items(id,collection_id,created_by,created_at,name,description) VALUES(?,?,?,?,?,?)", args: [itemId, String(item.collection_id), String(item.created_by), Number(item.created_at) + i + 1, `Bowl ${i + 1} — José 家族 🏺 ` + "W".repeat(i === 0 ? 150 : 0), i === 0 ? "Long retained description. ".repeat(44) : `Description for bowl ${i + 1}.`] },
      { sql: "INSERT INTO item_photos(id,item_id,photo_key,thumbnail_key,width,height,photo_bytes,sha256,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [photoId, itemId, prefix + ".jpg", prefix + "-thumb.jpg", Number(source.width), Number(source.height), photo.length, String(source.sha256), Number(source.created_at) + i + 1, String(item.created_by)] },
    ], "write");
  }
}


async function person(request: APIRequestContext, collection: string, name: string, note = "") {
  const id = randomUUID(); expect((await post(request, collection + "/people/records", { id, name, note })).status()).toBe(200); return id;
}
async function story(request: APIRequestContext, path: string, storyteller: string, text: string) {
  const id = randomUUID(); expect((await post(request, path + "/stories", { id, storyteller, text })).status()).toBe(200); return id;
}
async function savePDF(request: APIRequestContext, collection: string, id: string, path: string) {
  const pdf = await artifact(request, collection, id); await writeFile(path, pdf.bytes);
  return { ...pdf, text: (await run("pdftotext", ["-layout", path, "-"])).stdout };
}
async function waitInventory(collection: string, id: string) {
  await expect.poll(async () => (await (await observer.get(collection + "/inventory/requests")).json()).jobs.find((job: { id: string }) => job.id === id)?.status).toBe("ready");
}

test("an ordinary member downloads a standalone illustrated catalogue with all photos, keepers and independently attributed current stories", async ({ page, browser }, info) => {
  const item = await family(page); const second = await capture(page.request, item.collection);
  await capture(page.request, item.collection, item.id, "detail-6000.jpg"); await capture(page.request, item.collection, item.id);
  const aunt = await person(page.request, item.collection, "Sam", "Aunt on Dad’s side");
  const uncle = await person(page.request, item.collection, "Sam", "Uncle on Mum’s side");
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Painted bowl 家族", description: "A saved description, not a verified history.", currentKeeper: aunt })).status()).toBe(200);
  const contributorContext = await browser.newContext(); const contributor = await contributorContext.newPage();
  const contributorInvite = await invite(page, item.collection, "recorder@example.com");
  await signIn(contributor, "recorder@example.com"); await accept(contributor, contributorInvite);
  const first = await story(contributor.request, item.path, aunt, "It arrived in 1950.");
  const narrative = "CURRENT RECOLLECTION: it arrived in 1960. " + "家族".repeat(1800) + "\n" + "Long independent memory. ".repeat(180) + " END OF RECOLLECTION.";
  expect((await post(page.request, item.path + `/stories/${first}/details`, { version: "1", text: narrative })).status()).toBe(200);
  await story(page.request, item.path, uncle, "A different memory: it arrived in 1970 and was blue.");
  const departed = String((await db.execute("SELECT id FROM accounts WHERE email='recorder@example.com'")).rows[0].id);
  expect((await post(page.request, item.collection + `/members/${departed}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  await contributorContext.close();
  const context = await browser.newContext(); const member = await context.newPage();
  const readerInvite = await invite(page, item.collection, "reader@example.com");
  await signIn(member, "reader@example.com"); await accept(member, readerInvite);
  await member.getByRole("link", { name: "Download an illustrated family catalogue", exact: true }).click();
  const generate = member.getByRole("button", { name: "Generate catalogue PDF", exact: true }); await expect(generate).toBeEnabled({ timeout: 30_000 });
  const started = Date.now(); await generate.click();
  const link = member.getByRole("link", { name: "Download private catalogue PDF", exact: true }); await expect(link).toBeVisible({ timeout: 35_000 });
  const [download] = await Promise.all([member.waitForEvent("download"), link.click()]); const path = info.outputPath("family-catalogue.pdf"); await download.saveAs(path);
  const record = (await db.execute("SELECT * FROM catalogue_exports")).rows[0]; const bytes = await readFile(path);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(record.sha256); expect(bytes.length).toBe(Number(record.pdf_bytes));
  expect(record.requested_by).not.toBe(item.account);
  expect((await post(member.request, "/auth/sign-out", {})).status()).toBe(303); await context.setOffline(true);
  const text = (await run("pdftotext", ["-layout", path, "-"])).stdout;
  for (const expected of ["Painted bowl 家族", "Untitled belonging", "Draft item", "No stories recorded.", "Current keeper: Sam", "Aunt on Dad’s side", "Uncle on Mum’s side", "Recorded by: recorder@example.com", "Last edited by: founder@example.com", "END OF RECOLLECTION.", "it arrived in 1970 and was blue."]) expect(text.replace(/\s+/gu, " ")).toContain(expected);
  expect(text).not.toContain("It arrived in 1950.");
  // Extract only the body rectangle so repeated page headings cannot interrupt
  // a word/pair spanning a page boundary in this exact-content assertion.
  const body = (await run("pdftotext", ["-r", "72", "-x", "0", "-y", "189", "-W", "596", "-H", "610", path, "-"])).stdout;
  expect(body.replace(/\s/gu, "")).toContain(narrative.replace(/\s/gu, ""));
  const images = (await run("pdfimages", ["-list", path])).stdout.split("\n").filter(line => /^\s*\d+\s+\d+\s+image\s/.test(line)); expect(images).toHaveLength(4);
  expect(images.some(line => Number(line.trim().split(/\s+/)[3]) > 480)).toBe(true);
  const destinations = (await run("pdfinfo", ["-dests", path])).stdout;
  expect(destinations).toContain(`item-${item.id}`); expect(destinations).toContain(`item-${second}`);
  const html = (await run("pdftohtml", ["-i", "-stdout", path])).stdout; expect(html).toMatch(/href="[^"]*#\d+"/);
  const fonts = (await run("pdffonts", [path])).stdout; expect(fonts).toContain("NotoSansCJKsc"); expect(fonts).not.toContain(" no ");
  await run("pdftoppm", ["-f", "1", "-singlefile", "-scale-to", "1000", "-png", path, info.outputPath("catalogue-index")]);
  await run("pdftoppm", ["-f", "2", "-singlefile", "-scale-to", "1000", "-png", path, info.outputPath("catalogue-item")]);
  console.log(JSON.stringify({ catalogueItems: 2, photos: images.length, pages: record.page_count, bytes: bytes.length, memberJourneyMs: Date.now() - started }));
  await context.close();
});

test("a multi-page index resolves to the correct item sections with printed page references", async ({ page }, info) => {
  const item = await family(page); await seedMore(page, item.collection, item.id, 22);
  const id = await job(page.request, item.collection); const ready = await terminal(id);
  const path = info.outputPath("indexed-catalogue.pdf"); await savePDF(page.request, item.collection, id, path);
  const destinations = (await run("pdfinfo", ["-dests", path])).stdout;
  const matches = [...destinations.matchAll(/^\s*(\d+)\s+.*"item-([^"]+)"/gm)];
  expect(matches).toHaveLength(23);
  const indexText = (await run("pdftotext", ["-f", "1", "-l", "2", path, "-"])).stdout;
  expect(indexText.match(/p\.\s+\d+/g)).toHaveLength(23);
  for (const match of [matches[0], matches[11], matches[22]]) {
    const pageNumber = match[1]; const itemId = match[2];
    const source = (await db.execute({ sql: "SELECT name FROM items WHERE id=?", args: [itemId] })).rows[0];
    const body = (await run("pdftotext", ["-f", pageNumber, "-l", pageNumber, path, "-"])).stdout;
    expect(body.replace(/\s/gu, "")).toContain((String(source.name) || "Untitled belonging").replace(/\s/gu, ""));
    expect(indexText).toMatch(new RegExp("p\\.\\s+" + pageNumber + "\\b"));
  }
  console.log(JSON.stringify({ catalogueItems: 23, pages: ready.page_count, bytes: ready.pdf_bytes }));
});

test("collection scope, account pinning, cross-format identifiers and new grants after revocation remain private", async ({ page, browser, request }) => {
  const item = await family(page); const id = await job(page.request, item.collection); await terminal(id);
  const inventory = randomUUID(); expect((await post(page.request, item.collection + "/inventory/requests", { action: "create", id: inventory })).status()).toBe(202); await waitInventory(item.collection, inventory);
  expect((await page.request.get(endpoint(item.collection) + `/${inventory}/download`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await page.request.get(item.collection + `/inventory/requests/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id: inventory })).status()).toBe(404);
  expect((await post(page.request, endpoint(item.collection), { action: "create", id: randomUUID(), accountId: randomUUID() })).status()).toBe(409);
  expect((await request.get(endpoint(item.collection))).status()).toBe(401);
  const context = await browser.newContext(); const other = await context.newPage(); await signIn(other, "other@example.com", true); const own = await createCollection(other, "Other family");
  expect((await post(other.request, endpoint(item.collection), { action: "create", id: randomUUID() })).status()).toBe(404);
  expect((await other.request.get(endpoint(own) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  await accept(other, await invite(page, item.collection, "other@example.com"));
  expect((await other.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(302);
  const account = String((await db.execute("SELECT id FROM accounts WHERE email='other@example.com'")).rows[0].id);
  expect((await post(page.request, item.collection + `/members/${account}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  expect((await other.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  await context.close();
});

test("a valid JPEG with the wrong saved checksum cannot become a confirmed catalogue", async ({ page }) => {
  const item = await family(page);
  const photo = (await db.execute("SELECT photo_key,photo_bytes,sha256 FROM item_photos")).rows[0];
  const original = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: String(photo.photo_key) }));
  const replacement = Buffer.from(await original.Body!.transformToByteArray());
  // Change an 8-bit JPEG quantization coefficient: a decodable image with the
  // exact same byte count. A length-only check must not satisfy this regression.
  const table = replacement.indexOf(Buffer.from([0xff, 0xdb])); expect(table).toBeGreaterThan(0);
  expect(replacement[table + 4] >>> 4).toBe(0);
  replacement[table + 5] = replacement[table + 5] === 255 ? 254 : replacement[table + 5] + 1;
  await sharp(replacement).raw().toBuffer();
  expect(replacement.length).toBe(Number(photo.photo_bytes));
  expect(createHash("sha256").update(replacement).digest("hex")).not.toBe(photo.sha256);
  await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: String(photo.photo_key), Body: replacement, ContentType: "image/jpeg" }));
  const id = await job(page.request, item.collection); await terminal(id, "failed");
  expect((await (await page.request.get(endpoint(item.collection))).json()).jobs[0].error).toContain("checksum");
  expect((await db.execute("SELECT artifact_key FROM catalogue_exports")).rows[0].artifact_key).toBeNull();
  expect((await page.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
});

test("missing retained originals fail without a PDF; retry preserves the saved narrative snapshot", async ({ page }, info) => {
  const item = await family(page); const teller = await person(page.request, item.collection, "Pat", "Not an app participant");
  const memory = await story(page.request, item.path, teller, "ORIGINAL MEMORY — 1950.");
  const key = String((await db.execute("SELECT photo_key FROM item_photos")).rows[0].photo_key);
  const original = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key })); const bytes = await original.Body!.transformToByteArray();
  await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
  const id = await job(page.request, item.collection); await terminal(id, "failed");
  expect((await page.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
  expect((await db.execute("SELECT artifact_key FROM catalogue_exports")).rows[0].artifact_key).toBeNull();
  expect((await post(page.request, item.path + `/stories/${memory}/details`, { version: "1", text: "LATER EDIT MUST NOT ENTER THE OLD SNAPSHOT." })).status()).toBe(200);
  await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: bytes, ContentType: "image/jpeg" }));
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(202);
  expect((await terminal(id)).attempts).toBe(2);
  const pdf = await savePDF(page.request, item.collection, id, info.outputPath("retried-catalogue.pdf"));
  expect(pdf.text).toContain("ORIGINAL MEMORY"); expect(pdf.text).not.toContain("LATER EDIT");
  expect((await db.execute("SELECT text FROM stories")).rows[0].text).toContain("LATER EDIT");
});

test("lost creation responses and concurrent retries keep one catalogue and one canonical artifact", async ({ page }) => {
  const item = await family(page); await page.goto(item.collection + "/catalogue"); await expect(page.getByRole("button", { name: "Generate catalogue PDF", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.route("**/catalogue/requests", async route => { if (route.request().method() === "POST") { await route.fetch(); await route.abort("failed"); } else await route.continue(); }, { times: 1 });
  await page.getByRole("button", { name: "Generate catalogue PDF", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("Check status");
  await page.unroute("**/catalogue/requests");
  await page.getByRole("button", { name: "Generate catalogue PDF", exact: true }).click();
  await expect(page.getByRole("link", { name: "Download private catalogue PDF", exact: true })).toBeVisible({ timeout: 35_000 });
  const saved = (await db.execute("SELECT * FROM catalogue_exports")).rows; expect(saved).toHaveLength(1); expect(saved[0].attempts).toBe(1);
  const responses = await Promise.all([post(page.request, endpoint(item.collection), { action: "create", id: String(saved[0].id) }), post(page.request, endpoint(item.collection), { action: "retry", id: String(saved[0].id) })]);
  expect(responses.map(response => response.status())).toEqual([200, 200]);
  expect((await db.execute("SELECT * FROM catalogue_export_attempts")).rows).toHaveLength(1);
  const files = (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: "inventories/" }))).Contents ?? []; expect(files).toHaveLength(1);
});

for (const fault of ["publication failure", "membership removal"] as const) test(`${fault} while publishing never grants an incomplete or unauthorized catalogue`, async ({ page, browser }) => {
  const item = await family(page); const context = await browser.newContext(); const member = await context.newPage();
  const invitation = await invite(page, item.collection, "relative@example.com");
  await signIn(member, "relative@example.com"); await accept(member, invitation); await quiesce(page, member);
  await db.execute(fault === "publication failure" ? "CREATE TRIGGER catalogue_publication_fault BEFORE UPDATE OF status ON catalogue_exports WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT,'publication fault'); END" : "CREATE TRIGGER catalogue_publication_fault AFTER UPDATE OF phase ON catalogue_exports WHEN NEW.phase='publishing' BEGIN DELETE FROM memberships WHERE collection_id=NEW.collection_id AND account_id=NEW.requested_by; END");
  let id: string;
  try {
    id = await job(member.request, item.collection); await terminal(id, "failed");
    expect((await page.request.get(endpoint(item.collection) + `/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
    expect((await db.execute("SELECT artifact_key FROM catalogue_exports")).rows[0].artifact_key).toBeNull();
  } finally { await quiesce(page, member); await db.execute("DROP TRIGGER catalogue_publication_fault"); }
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id: id! })).status()).toBe(202);
  const ready = await terminal(id!); expect(ready.attempts).toBe(2);
  const attempts = (await db.execute("SELECT candidate_key FROM catalogue_export_attempts ORDER BY attempt")).rows; expect(attempts[0].candidate_key).not.toBe(attempts[1].candidate_key);
  await context.close();
});

test("shared capacity, expiry, discard and unsupported story text do not damage source records", async ({ page }) => {
  const item = await family(page); const teller = await person(page.request, item.collection, "Sam"); const memory = await story(page.request, item.path, teller, "Unsupported \u{10ffff}");
  const failed = await job(page.request, item.collection); await terminal(failed, "failed");
  expect((await (await page.request.get(endpoint(item.collection))).json()).jobs[0].error).toContain("not supported");
  expect((await post(page.request, item.path + `/stories/${memory}/details`, { version: "1", text: "Readable recollection." })).status()).toBe(200);
  for (let index = 0; index < 4; index++) { const id = randomUUID(); expect((await post(page.request, item.collection + "/inventory/requests", { action: "create", id })).status()).toBe(202); await waitInventory(item.collection, id); }
  expect((await post(page.request, endpoint(item.collection), { action: "create", id: randomUUID() })).status()).toBe(429);
  await quiesce(page); await db.execute({ sql: "UPDATE catalogue_exports SET expires_at=0 WHERE id=?", args: [failed] });
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id: failed })).status()).toBe(409);
  expect((await post(page.request, endpoint(item.collection), { action: "discard", id: failed })).status()).toBe(200);
  expect((await db.execute("SELECT * FROM catalogue_exports")).rows).toHaveLength(0);
  expect((await db.execute("SELECT text FROM stories")).rows[0].text).toBe("Readable recollection.");
  expect((await db.execute("SELECT * FROM item_photos")).rows).toHaveLength(1);
});

test("a retained failed snapshot exposes an abandoned lease and enforces the three-attempt bound", async ({ page }) => {
  const item = await family(page);
  const key = String((await db.execute("SELECT photo_key FROM item_photos")).rows[0].photo_key);
  await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
  const id = await job(page.request, item.collection); await terminal(id, "failed"); await quiesce(page);
  await db.execute({ sql: "UPDATE catalogue_exports SET status='processing',phase='photos',lease=?,lease_expires_at=0,error=NULL WHERE id=?", args: [randomUUID(), id] });
  expect((await (await page.request.get(endpoint(item.collection))).json()).jobs[0].status).toBe("interrupted");
  for (let attempt = 2; attempt <= 3; attempt++) {
    expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(202);
    expect((await terminal(id, "failed")).attempts).toBe(attempt);
  }
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(409);
  expect((await db.execute("SELECT * FROM catalogue_export_attempts")).rows).toHaveLength(3);
});

test("long labels and escaped narrative remain readable through keyboard-driven mobile download", async ({ page }, info) => {
  const collectionName = "家".repeat(120); const item = await family(page, collectionName);
  const name = "<script>window.catalogueExecuted=true</script>" + "W".repeat(150);
  const tellerName = "Sam" + "W".repeat(180); const note = "N".repeat(400);
  const teller = await person(page.request, item.collection, tellerName, note);
  expect((await post(page.request, item.path + "/details", { version: "1", name, description: "A long-labelled belonging.", currentKeeper: teller })).status()).toBe(200);
  await story(page.request, item.path, teller, "<script>not executable</script> START " + "memory ".repeat(1000) + "END");
  await page.setViewportSize({ width: 375, height: 812 }); await page.goto(item.collection + "/catalogue");
  const generate = page.getByRole("button", { name: "Generate catalogue PDF", exact: true }); await expect(generate).toBeEnabled({ timeout: 30_000 }); await generate.focus(); await page.keyboard.press("Enter");
  const link = page.getByRole("link", { name: "Download private catalogue PDF", exact: true }); await expect(link).toBeVisible({ timeout: 35_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => "catalogueExecuted" in window)).toBe(false);
  const [download] = await Promise.all([page.waitForEvent("download"), link.click()]); const path = info.outputPath("mobile-catalogue.pdf"); await download.saveAs(path);
  const text = (await run("pdftotext", [path, "-"])).stdout; const compact = text.replace(/\s/gu, "");
  expect(compact).toContain(collectionName); expect(compact).toContain(name); expect(compact).toContain(tellerName); expect(compact).toContain(note);
  expect(text.match(/memory/g)).toHaveLength(1000); expect(text).toContain("END"); expect(compact).toContain("<script>notexecutable</script>");
  expect((await run("pdfinfo", [path])).stdout).toMatch(/JavaScript:\s+no/);
});

test("oversized photo or story sets are rejected before creating a misleading partial catalogue", async ({ page }) => {
  const item = await family(page); const teller = await person(page.request, item.collection, "Sam"); await quiesce(page);
  const source = String((await db.execute("SELECT id FROM item_photos")).rows[0].id);
  await db.batch(Array.from({ length: 200 }, (_, index) => ({ sql: "INSERT INTO item_photos(id,item_id,photo_key,thumbnail_key,width,height,photo_bytes,sha256,created_at,created_by) SELECT ?,item_id,?,?,width,height,photo_bytes,sha256,created_at,created_by FROM item_photos WHERE id=?", args: [randomUUID(), `photos/fake-${index}.jpg`, `photos/fake-${index}-thumb.jpg`, source] })), "write");
  const photos = await post(page.request, endpoint(item.collection), { action: "create", id: randomUUID() }); expect(photos.status()).toBe(422); expect((await photos.json()).error).toContain("200 retained photos");
  await db.execute({ sql: "DELETE FROM item_photos WHERE id<>?", args: [source] });
  await db.batch(Array.from({ length: 1001 }, () => ({ sql: "INSERT INTO stories(id,item_id,storyteller_id,storyteller_version,text,recorded_by,recorded_at,last_edited_by,updated_at,creation_hash) VALUES(?,?,?,1,'A recollection.',?,?,?,?, 'fixture')", args: [randomUUID(), item.id, teller, item.account, Date.now(), item.account, Date.now()] })), "write");
  const stories = await post(page.request, endpoint(item.collection), { action: "create", id: randomUUID() }); expect(stories.status()).toBe(422); expect((await stories.json()).error).toContain("1000 independent stories");
  expect((await db.execute("SELECT * FROM catalogue_exports")).rows).toHaveLength(0);
});

test("migration ten is additive, transactional on failure and rerunnable with version-nine artifacts intact", async ({ page }) => {
  const item = await family(page); const id = randomUUID(); expect((await post(page.request, item.collection + "/inventory/requests", { action: "create", id })).status()).toBe(202); await waitInventory(item.collection, id);
  const before = (await db.execute("SELECT * FROM inventory_exports")).rows; await quiesce(page); await removeCatalogueSchema(db);
  await db.execute("CREATE TABLE catalogue_export_attempts(sentinel TEXT)");
  try {
    expect(() => execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv })).toThrow();
    expect((await db.execute("SELECT name FROM sqlite_master WHERE name='catalogue_exports'")).rows).toHaveLength(0);
    expect((await db.execute("SELECT name FROM schema_migrations WHERE name='0010_catalogue_exports.sql'")).rows).toHaveLength(0);
  } finally { await db.execute("DROP TABLE catalogue_export_attempts"); execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv }); }
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect((await db.execute("SELECT * FROM inventory_exports")).rows).toEqual(before); expect((await db.execute("SELECT * FROM schema_migrations")).rows).toHaveLength(14);
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
});

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID, createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import { readFile, rm, writeFile } from "node:fs/promises";
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { familyJourney, dbUrl, outbox, origin, operatorEnv, post } from "./support/family";
import { testStorage } from "./support/storage";
import { removeArchiveSchema } from "./support/legacy-database";

const db = createClient({ url: dbUrl, timeout: 5000 });
const { signIn, createCollection, invite, accept } = familyJourney(db);
const run = promisify(execFile);
let storage: ReturnType<typeof testStorage>, observer: APIRequestContext;
const observed = new Set<string>();
const tables = ["archive_export_attempts", "archive_exports", "catalogue_export_attempts", "catalogue_exports", "inventory_export_attempts", "inventory_exports", "story_revisions", "stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"];
test.setTimeout(180_000);
test.beforeAll(() => { storage = testStorage(); });
test.beforeEach(async ({ page, request }) => {
  observer = page.request; observed.clear();
  await db.execute("DROP TRIGGER IF EXISTS archive_publication_fault");
  await db.batch(tables.map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
  await request.get("/collections/prewarm/archive"); await request.get("/collections/prewarm/archive/requests");
  await request.get("/collections/prewarm/archive/requests/prewarm/download");
  expect((await post(request, "/collections/prewarm/archive/requests", { action: "create", id: randomUUID() })).status()).toBe(401);
});
test.afterEach(async ({ page }) => {
  await quiesce(page);
  await expect.poll(async () => {
    let active = 0;
    for (const collection of observed) {
      const response = await observer.get(endpoint(collection)); expect(response.status()).toBe(200);
      active += (await response.json()).jobs.filter((job: { status: string }) => job.status === "processing").length;
    }
    return active;
  }, { timeout: 65_000 }).toBe(0);
  await db.execute("DROP TRIGGER IF EXISTS archive_publication_fault");
  await db.batch(tables.slice(0, 6).map(table => `DELETE FROM ${table}`), "write");
  const objects = (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket }))).Contents ?? [];
  for (let offset = 0; offset < objects.length; offset += 20) await Promise.all(objects.slice(offset, offset + 20).map(object => storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: object.Key! }))));
});
test.afterAll(() => { db.close(); storage.client.destroy(); });
const endpoint = (collection: string) => collection + "/archive/requests";
async function quiesce(...pages: Page[]) { await Promise.all(pages.map(async page => { await page.goto("/"); await page.waitForLoadState("networkidle"); })); }
async function capture(request: APIRequestContext, collection: string, itemId?: string, file = "small.png") {
  const bytes = await readFile(`tests/fixtures/photos/${file}`), id = randomUUID();
  const path = itemId ? `${collection}/items/${itemId}/photo-uploads` : collection + "/photo-uploads";
  const start = await post(request, path, { id, size: String(bytes.length) }); expect(start.status()).toBe(200);
  expect((await request.put((await start.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).status()).toBe(200);
  expect((await post(request, `${path}/${id}/finish`, {})).status()).toBe(200); return id;
}
async function family(page: Page, name = "Archive family") {
  await signIn(page, "founder@example.com", true); const collection = await createCollection(page, name); observed.add(collection);
  const id = await capture(page.request, collection);
  const account = String((await db.execute("SELECT id FROM accounts WHERE email='founder@example.com'")).rows[0].id);
  return { collection, id, account, path: `${collection}/items/${id}` };
}
async function job(request: APIRequestContext, collection: string, id = randomUUID()) {
  const response = await post(request, endpoint(collection), { action: "create", id }); expect(response.status()).toBe(202); return id;
}
async function terminal(collection: string, id: string, status = "ready") {
  await expect.poll(async () => (await (await observer.get(endpoint(collection))).json()).jobs.find((job: { id: string }) => job.id === id)?.status, { timeout: 60_000 }).toBe(status);
  return (await db.execute({ sql: "SELECT * FROM archive_exports WHERE id=?", args: [id] })).rows[0];
}
async function artifact(request: APIRequestContext, collection: string, id: string, path: string) {
  const grant = await request.get(`${endpoint(collection)}/${id}/download`, { maxRedirects: 0 }); expect(grant.status()).toBe(302);
  const response = await request.get(grant.headers().location); expect(response.status()).toBe(200); expect(response.headers()["content-type"]).toContain("application/zip");
  const bytes = await response.body(); await writeFile(path, bytes);
  const verified = JSON.parse((await run("python3", ["assets/portable-archive/verify.py", path])).stdout); expect(verified.valid).toBe(true);
  const data = JSON.parse((await run("python3", ["-c", "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('data.json').decode())", path])).stdout);
  return { bytes, data, verified, url: grant.headers().location };
}
async function person(request: APIRequestContext, collection: string, name: string, note = "") {
  const id = randomUUID(); expect((await post(request, collection + "/people/records", { id, name, note })).status()).toBe(200); return id;
}
async function story(request: APIRequestContext, path: string, teller: string, text: string) {
  const id = randomUUID(); expect((await post(request, path + "/stories", { id, storyteller: teller, text })).status()).toBe(200); return id;
}

// Highest-seam round trip: public creation/download, actual ZIP bytes, standard
// library reader/verifier, stable graph/version identity and retained binary hashes.
test("an ordinary member preserves independent identities, all supported history and exact retained bytes in an offline archive", async ({ page, browser }, info) => {
  const item = await family(page, "Family 家族 🏺");
  await capture(page.request, item.collection, item.id, "detail-6000.jpg");
  const removed = await capture(page.request, item.collection, item.id);
  expect((await post(page.request, `${item.path}/photos/${removed}`, { confirm: "yes" })).status()).toBe(200);
  const aunt = await person(page.request, item.collection, "Sam", "Aunt on Dad’s side");
  const uncle = await person(page.request, item.collection, "Sam", "Uncle on Mum’s side");
  expect((await post(page.request, item.path + "/details", { version: "1", name: "Bowl 家族 🏺", description: "First description.", currentKeeper: aunt })).status()).toBe(200);
  const relative = await browser.newContext(); const rp = await relative.newPage();
  const invitation = await invite(page, item.collection, "relative@example.com");
  await signIn(rp, "relative@example.com"); await accept(rp, invitation, "Family 家族 🏺");
  const memory = await story(rp.request, item.path, aunt, "I remember 1950. <script>not code</script>");
  expect((await post(page.request, `${item.collection}/people/${aunt}/details`, { version: "1", name: "Sam renamed", note: "Still the same aunt" })).status()).toBe(200);
  expect((await post(page.request, item.path + `/stories/${memory}/details`, { version: "1", text: "Another member’s edit." })).status()).toBe(200);
  expect((await post(page.request, item.path + `/stories/${memory}/details`, { version: "2", text: "I remember 1950. <script>not code</script>" })).status()).toBe(200);
  await story(page.request, item.path, uncle, "I disagree; it was 1960.");
  expect((await post(page.request, item.path + "/details", { version: "2", name: "Bowl 家族 🏺", description: "Current description.", currentKeeper: uncle })).status()).toBe(200);
  await quiesce(page, rp);
  // Markers in operational tables must never leak through an accidental SELECT *.
  await db.execute("INSERT INTO approved_founders(email,approved_at) VALUES('NEVER_EXPORT_APPROVAL@example.com',1)");
  const source = (await db.execute("SELECT * FROM item_photos WHERE removed_at IS NULL ORDER BY created_at,id")).rows;
  const expected = new Map<string, Buffer>();
  for (const photo of source) for (const field of ["photo_key", "thumbnail_key"]) {
    const object = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: String(photo[field]) })); expected.set(String(photo[field]), Buffer.from(await object.Body!.transformToByteArray()));
  }
  const started = Date.now(), id = await job(rp.request, item.collection); const row = await terminal(item.collection, id);
  const archive = await artifact(rp.request, item.collection, id, info.outputPath("family.zip"));
  expect(createHash("sha256").update(archive.bytes).digest("hex")).toBe(row.sha256);
  expect(archive.bytes.length).toBe(Number(row.artifact_bytes));
  const d = archive.data;
  expect(d.snapshot.source_collection_id).toBe(item.collection.split("/").pop()); expect(d.snapshot.id).toBe(id);
  expect(d.items[0]).toMatchObject({ id: item.id, version: 3, current_keeper_id: uncle, description: "Current description." });
  expect(d.item_revisions.map((r: { version: number }) => r.version)).toEqual([1, 2]);
  expect(d.item_revisions[1]).toMatchObject({ current_keeper_id: aunt, current_keeper_version: 1 });
  expect(d.people.find((p: { id: string }) => p.id === aunt)).toMatchObject({ name: "Sam renamed", version: 2 });
  expect(d.person_revisions[0]).toMatchObject({ person_id: aunt, name: "Sam", note: "Aunt on Dad’s side", version: 1 });
  const s = d.stories.find((s: { id: string }) => s.id === memory);
  expect(s).toMatchObject({ version: 3, storyteller_id: aunt, storyteller_version: 1, last_edited_by: item.account });
  expect(s.recorded_by).not.toBe(item.account);
  expect(d.story_revisions.filter((r: { story_id: string }) => r.story_id === memory).map((r: { text: string }) => r.text)).toEqual(["I remember 1950. <script>not code</script>", "Another member’s edit."]);
  expect(d.stories).toHaveLength(2); expect(d.contributors).toHaveLength(2); expect(d.people).toHaveLength(2);
  expect(d.photos.find((p: { id: string }) => p.id === removed)).toMatchObject({ retained_file: null, thumbnail_file: null, removed_by: item.account });
  for (const photo of source) {
    const record = d.photos.find((p: { id: string }) => p.id === photo.id);
    for (const [field, descriptor] of [["photo_key", record.retained_file], ["thumbnail_key", record.thumbnail_file]]) {
      const raw = Buffer.from((await run("python3", ["-c", "import zipfile,sys; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))", info.outputPath("family.zip"), descriptor.path], { encoding: "buffer" })).stdout);
      expect(raw).toEqual(expected.get(String(photo[field])));
    }
  }
  const serialized = JSON.stringify(d); expect(serialized).not.toMatch(/NEVER_EXPORT_APPROVAL|creation_hash|token_digest|photo_key|thumbnail_key|OBJECT_STORAGE|TURSO_AUTH|membership|session/);
  expect(d.photos.some((p: { width: number }) => p.width === 3200)).toBe(true);
  // Remove the recorder's membership, then export again: credit survives without grants.
  await db.execute({ sql: "DELETE FROM memberships WHERE collection_id=? AND account_id=?", args: [d.collection.id, s.recorded_by] });
  const second = await job(page.request, item.collection); await terminal(item.collection, second);
  const departed = await artifact(page.request, item.collection, second, info.outputPath("departed.zip"));
  expect(departed.data.contributors).toContainEqual({ id: s.recorded_by, email: "relative@example.com" });
  expect((await rp.request.get(`${endpoint(item.collection)}/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  await relative.setOffline(true);
  expect(JSON.parse((await run("python3", ["assets/portable-archive/verify.py", info.outputPath("family.zip")])).stdout).valid).toBe(true);
  console.log(JSON.stringify({ archiveItems: d.items.length, retainedPhotos: source.length, bytes: archive.bytes.length, files: archive.verified.files, generationAndInspectionMs: Date.now() - started }));
  await relative.close();
});

for (const failure of ["missing main", "changed main", "missing thumbnail", "truncated thumbnail", "truncated scan thumbnail", "oversized thumbnail"]) test(`${failure} prevents completion; retry preserves the original frozen text and uses a fresh candidate`, async ({ page }, info) => {
  const item = await family(page); const teller = await person(page.request, item.collection, "Grandparent");
  const memory = await story(page.request, item.path, teller, "Original frozen story.");
  await quiesce(page);
  const photo = (await db.execute("SELECT * FROM item_photos")).rows[0];
  const key = String(photo[failure.includes("thumbnail") ? "thumbnail_key" : "photo_key"]);
  const body = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key })); const original = Buffer.from(await body.Body!.transformToByteArray());
  if (failure === "changed main") { const changed = Buffer.from(original); changed[changed.length - 3] ^= 1; await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: changed, ContentType: "image/jpeg" })); }
  else if (failure === "truncated thumbnail") await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: Buffer.from([0xff, 0xd8]), ContentType: "image/jpeg" }));
  else if (failure === "truncated scan thumbnail") {
    const valid = await sharp(await readFile("tests/fixtures/photos/detail-6000.jpg")).resize({ width: 480, height: 480, fit: "inside" }).jpeg().toBuffer();
    const truncated = valid.subarray(0, Math.floor(valid.length * 0.75));
    expect((await sharp(truncated).metadata()).format).toBe("jpeg"); // Header parsing alone is insufficient.
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: truncated, ContentType: "image/jpeg" }));
  } else if (failure === "oversized thumbnail") {
    const oversized = await sharp({ create: { width: 481, height: 1, channels: 3, background: "white" } }).jpeg().toBuffer();
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: oversized, ContentType: "image/jpeg" }));
  } else await storage.client.send(new DeleteObjectCommand({ Bucket: storage.bucket, Key: key }));
  const id = await job(page.request, item.collection); const failed = await terminal(item.collection, id, "failed"); expect(failed.artifact_key).toBeNull();
  if (failure.includes("thumbnail") && failure !== "missing thumbnail") expect(failed.error).toContain("unreadable");
  expect((await page.request.get(`${endpoint(item.collection)}/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
  expect((await post(page.request, `${item.path}/stories/${memory}/details`, { version: "1", text: "Later story must not replace the snapshot." })).status()).toBe(200);
  await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key, Body: original, ContentType: "image/jpeg" }));
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(202); await terminal(item.collection, id);
  const archive = await artifact(page.request, item.collection, id, info.outputPath("retried.zip"));
  expect(archive.data.stories[0].text).toBe("Original frozen story.");
  const attempts = (await db.execute("SELECT candidate_key FROM archive_export_attempts ORDER BY attempt")).rows;
  expect(attempts).toHaveLength(2); expect(attempts[0].candidate_key).not.toBe(attempts[1].candidate_key);
});

test("archive scope, anonymous access, account pins, cross-format IDs and revoked new grants fail closed", async ({ page, browser }, info) => {
  const item = await family(page); const id = await job(page.request, item.collection); await terminal(item.collection, id);
  const other = await browser.newContext(); const op = await other.newPage(); await signIn(op, "other@example.com", true);
  const otherCollection = await createCollection(op, "Unrelated family");
  const anonymous = await browser.newContext();
  for (const request of [other.request, anonymous.request]) {
    expect([401, 404]).toContain((await request.get(endpoint(item.collection))).status());
    expect([401, 404]).toContain((await request.get(`${endpoint(item.collection)}/${id}/download`, { maxRedirects: 0 })).status());
  }
  expect((await post(page.request, endpoint(item.collection), { action: "create", id: randomUUID(), accountId: "wrong" })).status()).toBe(409);
  expect((await post(other.request, endpoint(otherCollection), { action: "retry", id })).status()).toBe(409);
  expect((await page.request.get(item.collection + `/catalogue/requests/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await page.request.get(item.collection + `/inventory/requests/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  const relative = await browser.newContext(); const rp = await relative.newPage();
  const invitation = await invite(page, item.collection, "member@example.com"); await signIn(rp, "member@example.com"); await accept(rp, invitation, "Archive family"); await quiesce(page, rp, op);
  const account = (await db.execute("SELECT id FROM accounts WHERE email='member@example.com'")).rows[0].id;
  await db.execute({ sql: "DELETE FROM memberships WHERE collection_id=? AND account_id=?", args: [item.collection.split("/").pop()!, account] });
  expect((await post(relative.request, endpoint(item.collection), { action: "create", id: randomUUID() })).status()).toBe(404);
  expect((await relative.request.get(`${endpoint(item.collection)}/${id}/download`, { maxRedirects: 0 })).status()).toBe(404);
  const archive = await artifact(page.request, item.collection, id, info.outputPath("private.zip"));
  const unsigned = new URL(archive.url); unsigned.search = ""; expect((await page.request.get(unsigned.toString())).status()).not.toBe(200);
  await other.close(); await relative.close(); await anonymous.close();
});

test("empty collections, lost acknowledgements, concurrent retries, quota, expiry and discard remain honest", async ({ page }, info) => {
  await signIn(page, "founder@example.com", true); const collection = await createCollection(page, "Empty family"); observed.add(collection);
  const id = randomUUID();
  const results = await Promise.all([post(page.request, endpoint(collection), { action: "create", id }), post(page.request, endpoint(collection), { action: "create", id })]);
  expect(results.map(r => r.status()).sort()).toEqual([200, 202]); await terminal(collection, id);
  expect((await post(page.request, endpoint(collection), { action: "create", id })).status()).toBe(200);
  const first = await artifact(page.request, collection, id, info.outputPath("empty.zip")); expect(first.data.items).toEqual([]); expect(first.verified.files).toBe(3);
  const next = await job(page.request, collection); await terminal(collection, next);
  expect((await post(page.request, endpoint(collection), { action: "create", id: randomUUID() })).status()).toBe(429);
  await quiesce(page); await db.execute({ sql: "UPDATE archive_exports SET expires_at=1 WHERE id=?", args: [id] });
  expect((await page.request.get(`${endpoint(collection)}/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
  expect((await post(page.request, endpoint(collection), { action: "retry", id })).status()).toBe(409);
  expect((await post(page.request, endpoint(collection), { action: "discard", id })).status()).toBe(200);
  expect((await db.execute("SELECT COUNT(*) AS count FROM archive_exports")).rows[0].count).toBe(1);
  expect((await db.execute("SELECT COUNT(*) AS count FROM collections")).rows[0].count).toBe(1);
});

for (const fault of ["publication", "membership"]) test(`${fault} failure cannot publish or expose a candidate, and cleanup preserves source records`, async ({ page, browser }, info) => {
  const item = await family(page); const relative = await browser.newContext(); const rp = await relative.newPage();
  const invitation = await invite(page, item.collection, "member@example.com"); await signIn(rp, "member@example.com"); await accept(rp, invitation, "Archive family"); await quiesce(page, rp);
  const trigger = fault === "publication" ? "BEFORE UPDATE OF status ON archive_exports WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT,'injected publication failure'); END" : "AFTER UPDATE OF phase ON archive_exports WHEN NEW.phase='publishing' BEGIN DELETE FROM memberships WHERE collection_id=NEW.collection_id AND account_id=NEW.requested_by; END";
  await db.execute(`CREATE TRIGGER archive_publication_fault ${trigger}`);
  const id = await job(relative.request, item.collection); await terminal(item.collection, id, "failed");
  await quiesce(page, rp); await db.execute("DROP TRIGGER archive_publication_fault");
  const candidate = String((await db.execute("SELECT candidate_key FROM archive_export_attempts")).rows[0].candidate_key);
  const raw = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: candidate })); expect(raw.ContentType).toBe("application/zip"); raw.Body?.transformToWebStream().cancel();
  expect((await page.request.get(`${endpoint(item.collection)}/${id}/download`, { maxRedirects: 0 })).status()).toBe(409);
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(202); await terminal(item.collection, id);
  await artifact(page.request, item.collection, id, info.outputPath("recovered.zip"));
  expect((await db.execute("SELECT * FROM archive_export_attempts")).rows).toHaveLength(2);
  expect((await post(page.request, endpoint(item.collection), { action: "discard", id })).status()).toBe(200);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1); expect((await db.execute("SELECT * FROM item_photos")).rows).toHaveLength(1);
  await relative.close();
});

test("abandoned leases expose bounded retries and over-limit or incomplete source history is rejected before acceptance", async ({ page }) => {
  const item = await family(page); const id = await job(page.request, item.collection); await terminal(item.collection, id); await quiesce(page);
  await db.execute({ sql: "UPDATE archive_exports SET status='processing',phase='files',lease='abandoned',lease_expires_at=1,attempts=2 WHERE id=?", args: [id] });
  expect((await (await page.request.get(endpoint(item.collection))).json()).jobs[0].status).toBe("interrupted");
  const results = await Promise.all([post(page.request, endpoint(item.collection), { action: "retry", id }), post(page.request, endpoint(item.collection), { action: "retry", id })]);
  expect(results.map(r => r.status()).sort()).toEqual([202, 409]); await terminal(item.collection, id);
  await quiesce(page); await db.execute({ sql: "UPDATE archive_exports SET status='failed',error='abandoned' WHERE id=?", args: [id] });
  expect((await post(page.request, endpoint(item.collection), { action: "retry", id })).status()).toBe(409);
  await db.execute({ sql: "UPDATE items SET version=2 WHERE id=?", args: [item.id] });
  expect((await post(page.request, endpoint(item.collection), { action: "create", id: randomUUID() })).status()).toBe(409);
  await db.execute({ sql: "UPDATE items SET version=1 WHERE id=?", args: [item.id] });
  await db.execute("UPDATE item_photos SET photo_bytes=251658241");
  expect((await post(page.request, endpoint(item.collection), { action: "create", id: randomUUID() })).status()).toBe(422);
});

test("the additive version-eleven upgrade preserves prior PDF derivatives and rolls back partial DDL before rerun", async ({ page }) => {
  const item = await family(page); await quiesce(page);
  for (const format of ["inventory", "catalogue"]) {
    const id = randomUUID(); expect((await post(page.request, `${item.collection}/${format}/requests`, { action: "create", id })).status()).toBe(202);
    await expect.poll(async () => (await (await page.request.get(`${item.collection}/${format}/requests`)).json()).jobs[0].status).toBe("ready");
  }
  const derivatives = [(await db.execute("SELECT * FROM inventory_exports")).rows, (await db.execute("SELECT * FROM catalogue_exports")).rows];
  const before = (await db.execute("SELECT * FROM items")).rows; await removeArchiveSchema(db);
  await db.execute("CREATE TABLE archive_export_attempts(fault TEXT)");
  try {
    expect(() => execFileSync("node", ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv, stdio: "pipe" })).toThrow();
    expect((await db.execute("SELECT name FROM sqlite_master WHERE name='archive_exports'")).rows).toHaveLength(0);
    expect((await db.execute("SELECT * FROM schema_migrations WHERE name='0011_portable_archives.sql'")).rows).toHaveLength(0);
  } finally { await db.execute("DROP TABLE archive_export_attempts"); execFileSync("node", ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv }); }
  execFileSync("node", ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  expect((await db.execute("SELECT * FROM items")).rows).toEqual(before);
  expect([(await db.execute("SELECT * FROM inventory_exports")).rows, (await db.execute("SELECT * FROM catalogue_exports")).rows]).toEqual(derivatives);
  expect((await db.execute("SELECT * FROM schema_migrations")).rows).toHaveLength(11);
  expect((await db.execute("PRAGMA foreign_key_check")).rows).toHaveLength(0);
  const id = await job(page.request, item.collection); await terminal(item.collection, id);
});

test("the standalone verifier detects altered bytes, missing files, broken graphs, unsupported versions and unsafe ZIPs", async ({ page }, info) => {
  const item = await family(page); const id = await job(page.request, item.collection); await terminal(item.collection, id);
  const source = info.outputPath("valid.zip"); await artifact(page.request, item.collection, id, source);
  for (const mutation of ["missing", "altered", "dangling", "history", "permission", "version", "path", "duplicate"]) {
    const target = info.outputPath(`${mutation}.zip`);
    await run("python3", ["tests/support/archive-mutations.py", source, target, mutation]);
    await expect(run("python3", ["assets/portable-archive/verify.py", target])).rejects.toThrow("Archive verification failed");
  }
});

test("source-schema allowlists make future persistent fields require an explicit preservation decision", async ({ page }) => {
  await family(page); await quiesce(page);
  const columns: Record<string, string> = {
    collections: "id name created_at",
    accounts: "id email created_at",
    items: "id collection_id created_by created_at name description version last_edited_by updated_at status current_keeper_id current_keeper_version",
    people: "id collection_id name note version created_by created_at creation_hash last_edited_by updated_at",
    stories: "id item_id storyteller_id storyteller_version text version recorded_by recorded_at last_edited_by updated_at creation_hash",
    item_photos: "id item_id photo_key thumbnail_key width height photo_bytes sha256 created_at created_by removed_at removed_by",
    item_revisions: "id item_id version name description status edited_by edited_at current_keeper_id current_keeper_version",
    person_revisions: "id person_id version name note edited_by edited_at",
    story_revisions: "id story_id version text storyteller_id storyteller_version recorded_by recorded_at edited_by edited_at",
  };
  // Explicitly excluded: contributor account creation is login-system metadata;
  // idempotency hashes are operational; collection scoping is represented once;
  // private storage keys are remapped to portable file descriptors, never copied.
  for (const [table, fields] of Object.entries(columns)) expect((await db.execute(`PRAGMA table_xinfo(${table})`)).rows.map(row => row.name).sort()).toEqual(fields.split(" ").sort());
});

test("representative retained-image archives stay independent of thumbnails and report their measured size", async ({ page }, info) => {
  const item = await family(page); await capture(page.request, item.collection, item.id, "detail-6000.jpg"); await quiesce(page);
  const source = (await db.execute("SELECT * FROM item_photos ORDER BY width DESC LIMIT 1")).rows[0];
  const main = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: String(source.photo_key) })); const photo = Buffer.from(await main.Body!.transformToByteArray());
  const small = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: String(source.thumbnail_key) })); const thumb = Buffer.from(await small.Body!.transformToByteArray());
  for (let i = 0; i < 19; i++) {
    const iid = randomUUID(), pid = randomUUID(), key = `photos/archive-fixture-${pid}`;
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key + ".jpg", Body: photo, ContentType: "image/jpeg" }));
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: key + "-thumb.jpg", Body: thumb, ContentType: "image/jpeg" }));
    await db.batch([
      { sql: "INSERT INTO items(id,collection_id,created_by,created_at,name,description) VALUES(?,?,?,?,?,?)", args: [iid, item.collection.split("/").pop()!, item.account, Date.now() + i, `Bowl ${i}`, "Saved identifying description."] },
      { sql: "INSERT INTO item_photos(id,item_id,photo_key,thumbnail_key,width,height,photo_bytes,sha256,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)", args: [pid, iid, key + ".jpg", key + "-thumb.jpg", Number(source.width), Number(source.height), photo.length, String(source.sha256), Date.now() + i, item.account] },
    ], "write");
  }
  const started = Date.now(), id = await job(page.request, item.collection); await terminal(item.collection, id);
  const archive = await artifact(page.request, item.collection, id, info.outputPath("representative.zip"));
  expect(archive.data.items).toHaveLength(20); expect(archive.data.photos).toHaveLength(21);
  expect(archive.data.photos.filter((p: { width: number }) => p.width === 3200)).toHaveLength(20);
  expect(archive.bytes.length).toBeGreaterThan(photo.length * 20);
  console.log(JSON.stringify({ archiveItems: 20, activePhotos: 21, mainPhotoBytes: photo.length, zipBytes: archive.bytes.length, generationDownloadAndVerificationMs: Date.now() - started }));
});

test("long escaped labels and archive controls remain usable by keyboard on mobile", async ({ page }, info) => {
  const name = "<script>window.archiveExecuted=1</script> 家族 " + "W".repeat(65); const item = await family(page, name);
  await page.setViewportSize({ width: 375, height: 812 }); await page.goto(item.collection + "/archive");
  const generate = page.getByRole("button", { name: "Generate portable archive", exact: true }); await expect(generate).toBeEnabled(); await generate.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Download private archive ZIP" })).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => (window as Window & { archiveExecuted?: boolean }).archiveExecuted)).toBeUndefined();
  const download = page.waitForEvent("download"); await page.getByRole("link", { name: "Download private archive ZIP" }).focus(); await page.keyboard.press("Enter");
  await (await download).saveAs(info.outputPath("mobile.zip"));
  expect(JSON.parse((await run("python3", ["assets/portable-archive/verify.py", info.outputPath("mobile.zip")])).stdout).valid).toBe(true);
});

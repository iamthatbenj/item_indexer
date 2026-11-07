import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID, createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import sharp from "sharp";
import exifReader from "exif-reader";
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, PutBucketPolicyCommand, DeleteBucketPolicyCommand } from "@aws-sdk/client-s3";
import { removePeopleSchema } from "./support/legacy-database";
import { familyJourney, dbUrl, outbox, origin, post, operatorEnv } from "./support/family";
import { testStorage } from "./support/storage";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept } = familyJourney(db);
const fixtures = resolve("tests/fixtures/photos");
let storage: ReturnType<typeof testStorage>;
test.beforeAll(() => { storage = testStorage(); });
test.setTimeout(90_000);
test.beforeEach(async () => {
  await db.batch(["person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
});
test.afterAll(() => { db.close(); storage.client.destroy(); });

async function family(page: Page) {
  await signIn(page, "founder@example.com", true);
  return createCollection(page);
}
async function start(request: APIRequestContext, collection: string, bytes: Buffer, id = randomUUID()) {
  const response = await post(request, collection + "/photo-uploads", { id, size: String(bytes.length) });
  expect(response.status()).toBe(200);
  const result = await response.json() as { uploadUrl: string };
  const signed = new URL(result.uploadUrl);
  expect(signed.searchParams.get("X-Amz-SignedHeaders")).toContain("content-length");
  expect(signed.searchParams.has("x-amz-checksum-crc32")).toBe(false);
  expect((await request.put(result.uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).ok()).toBe(true);
  return { id, url: result.uploadUrl, finish: `${collection}/photo-uploads/${id}/finish` };
}
async function savedPhoto(request: APIRequestContext, collection: string, bytes: Buffer) {
  const upload = await start(request, collection, bytes);
  const result = await post(request, upload.finish, {});
  expect(result.status()).toBe(200);
  return { ...upload, path: String((await result.json()).itemUrl) };
}
async function object(key: string) {
  return Buffer.from(await (await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: key }))).Body!.transformToByteArray());
}
async function keys(prefix: string) {
  return (await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix }))).Contents?.map(object => object.Key!) ?? [];
}

for (const picker of ["Take a photo", "Choose from your photo library"]) {
  test(`${picker}: one photo saves without metadata and another ordinary member can see it`, async ({ page, browser }) => {
    const collection = await family(page);
    const invitation = await invite(page, collection, "relative@example.com");
    const relativeContext = await browser.newContext();
    const relative = await relativeContext.newPage();
    await signIn(relative, "relative@example.com");
    await accept(relative, invitation);
    await relative.setViewportSize({ width: 375, height: 812 });
    await expect(relative.getByText("We retain high-quality optimized photos", { exact: false })).toBeVisible();
    // Native invitation forms can render before the large development client
    // hydrates; allow navigation-scale readiness without enabling SSR controls.
    await expect(relative.getByLabel(picker, { exact: true })).toBeEnabled({ timeout: 30_000 });
    await relative.getByLabel(picker, { exact: true }).setInputFiles(`${fixtures}/small.png`);
    await expect(relative.getByRole("status")).toContainText("not saved yet");
    const gate = Promise.withResolvers<void>();
    await relative.route("**/photo-uploads/*/finish", async route => { await gate.promise; await route.continue(); });
    try {
      await relative.getByRole("button", { name: "Save photo draft", exact: true }).click();
      await expect(relative.getByRole("status")).toContainText("Processing and saving");
      expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
      await expect(relative.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
    } finally { gate.resolve(); }
    await expect(relative.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
    await expect(relative.getByRole("status")).toContainText("Saved with one photo");
    await expect.poll(() => relative.locator(".item-photo").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
    expect((await db.execute("SELECT status FROM items")).rows[0].status).toBe("draft");
    await page.goto(collection);
    await page.getByRole("link", { name: "Untitled belonging — Draft item", exact: false }).click();
    await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
    expect(await relative.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await relativeContext.close();
  });
}

test("a lost save acknowledgement retries through the browser without duplicating the draft", async ({ page }) => {
  const collection = await family(page);
  const input = page.getByLabel("Choose from your photo library", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles(`${fixtures}/small.png`);
  await page.route("**/photo-uploads/*/finish", async route => { await route.fetch(); await route.abort("failed"); }, { times: 1 });
  await page.getByRole("button", { name: "Save photo draft", exact: true }).click();
  await expect(page.getByRole("region", { name: "Capture a belonging" }).getByRole("alert")).toContainText("save was interrupted");
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
});

test("an expired browser selection can reselect the same file and save a fresh draft", async ({ page }) => {
  await family(page);
  const input = page.getByLabel("Choose from your photo library", { exact: true });
  await expect(input).toBeEnabled();
  await input.setInputFiles(`${fixtures}/small.png`);
  // Expire the selected intent immediately after issuance through the real UI.
  await page.route("**/photo-uploads", async route => {
    const response = await route.fetch();
    await db.execute("UPDATE photo_uploads SET expires_at=0");
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole("button", { name: "Save photo draft", exact: true }).click();
  await expect(page.getByRole("region", { name: "Capture a belonging" }).getByRole("alert")).toContainText("Select the photo again");
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
  await expect(input).toHaveValue("");
  await input.setInputFiles(`${fixtures}/small.png`);
  await page.getByRole("button", { name: "Save photo draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Untitled belonging", exact: true })).toBeVisible();
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
});

test("retained large image is bounded, detailed, metadata-free and linked to real private objects", async ({ page }) => {
  const collection = await family(page);
  const bytes = await readFile(`${fixtures}/detail-6000.jpg`);
  const upload = await savedPhoto(page.request, collection, bytes);
  const row = (await db.execute("SELECT * FROM item_photos")).rows[0];
  const photo = await object(String(row.photo_key));
  const thumbnail = await object(String(row.thumbnail_key));
  const metadata = await sharp(photo).metadata();
  expect([metadata.width, metadata.height]).toEqual([3200, 2133]);
  expect(Math.max((await sharp(thumbnail).metadata()).width!, (await sharp(thumbnail).metadata()).height!)).toBeLessThanOrEqual(480);
  for (const file of [photo, thumbnail]) {
    const m = await sharp(file).metadata();
    for (const key of ["exif", "xmp", "iptc", "icc", "orientation"] as const) expect(m[key]).toBeUndefined();
  }
  expect(row.sha256).toBe(createHash("sha256").update(photo).digest("hex"));
  expect(Number(row.photo_bytes)).toBe(photo.length);
  // Compare against an uncompressed reference at the same output resolution;
  // this is a numerical guard, not a substitute for manual text/detail review.
  const reference = await sharp(bytes).resize({ width: 3200, height: 3200, fit: "inside" }).removeAlpha().raw().toBuffer();
  const decoded = await sharp(photo).removeAlpha().raw().toBuffer();
  const meanError = reference.reduce((sum, pixel, i) => sum + Math.abs(pixel - decoded[i]), 0) / reference.length;
  expect(meanError).toBeLessThan(3);
  expect(await keys(`staging/${collection.split("/").pop()}/${upload.id}`)).toHaveLength(0);
  const response = await page.request.get(upload.path + "/photo", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const url = new URL(response.headers().location);
  expect(Number(url.searchParams.get("X-Amz-Expires"))).toBe(60);
  expect((await page.request.get(url.toString())).status()).toBe(200);
  url.search = "";
  expect((await page.request.get(url.toString())).status()).toBe(403);
});

test("orientation and synthetic GPS/device/date metadata are handled; small images never upscale", async ({ page }) => {
  const collection = await family(page);
  const input = await readFile(`${fixtures}/rotated-gps.jpg`);
  const original = await sharp(input).metadata();
  expect(original.orientation).toBe(6);
  expect(original.exif?.length).toBeGreaterThan(0);
  const tags = exifReader(original.exif!);
  expect(tags.Image?.Make).toBe("Synthetic fixture camera");
  expect(tags.Image?.DateTime).toBeInstanceOf(Date);
  expect(tags.GPSInfo?.GPSLatitude).toEqual([51, 30, 0]);
  await savedPhoto(page.request, collection, input);
  let row = (await db.execute("SELECT * FROM item_photos")).rows[0];
  let retained = await object(String(row.photo_key));
  let metadata = await sharp(retained).metadata();
  expect([metadata.width, metadata.height]).toEqual([200, 400]);
  expect(metadata.exif).toBeUndefined();
  expect(metadata.orientation).toBeUndefined();
  const { data } = await sharp(retained).extract({ left: 150, top: 25, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  expect(data[0]).toBeGreaterThan(200); expect(data[1]).toBeLessThan(80); // Red corner rotated clockwise.
  for (const file of ["small.png", "small.webp", "static-animation-text.png"]) {
    const upload = await savedPhoto(page.request, collection, await readFile(`${fixtures}/${file}`));
    row = (await db.execute({ sql: "SELECT * FROM item_photos WHERE item_id=?", args: [upload.id] })).rows[0];
    retained = await object(String(row.photo_key)); metadata = await sharp(retained).metadata();
    expect([metadata.width, metadata.height]).toEqual([400, 200]);
  }
});

test("malformed, disguised SVG, animated and oversized-pixel inputs never become saved items", async ({ page }) => {
  const collection = await family(page);
  for (const file of ["malformed.jpg", "unsupported.svg", "animated.png", "animated.webp"]) {
    const upload = await start(page.request, collection, await readFile(`${fixtures}/${file}`));
    const response = await post(page.request, upload.finish, {});
    expect(response.status()).toBe(400);
    expect((await response.json()).error).toMatch(/JPEG|PNG|WebP/);
    expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
    expect(await keys(`photos/${collection.split("/").pop()}/${upload.id}`)).toHaveLength(0);
  }
  // Valid oversized dimensions are rejected before an expensive full decode.
  const large = await sharp({ create: { width: 8000, height: 8000, channels: 3, background: "white" } }).png().toBuffer();
  const upload = await start(page.request, collection, large);
  expect((await post(page.request, upload.finish, {})).status()).toBe(400);
  const animated = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100, 100] }).toBuffer();
  expect((await sharp(animated).metadata()).pages).toBe(2);
  const animation = await start(page.request, collection, animated);
  expect((await post(page.request, animation.finish, {})).status()).toBe(400);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
});

test("PNG validation rejects broken chunk lengths, CRCs, truncation and trailing bytes without publication", async ({ page }) => {
  const collection = await family(page);
  const png = await readFile(`${fixtures}/small.png`);
  const oversizedChunk = Buffer.from(png); oversizedChunk.writeUInt32BE(0xffffffff, 8);
  const corruptCrc = Buffer.from(png); corruptCrc[32] ^= 1;
  for (const bytes of [oversizedChunk, corruptCrc, png.subarray(0, -1), Buffer.concat([png, Buffer.from("trailing")])]) {
    const upload = await start(page.request, collection, bytes);
    expect((await post(page.request, upload.finish, {})).status()).toBe(400);
    expect(await keys(`photos/${collection.split("/").pop()}/${upload.id}`)).toHaveLength(0);
  }
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
});

test("authorization denies strangers, wrong collections and removed sessions, while another collection remains accessible", async ({ page, browser, request }) => {
  const collection = await family(page);
  const otherCollection = await createCollection(page, "Another family");
  const invitation = await invite(page, collection, "relative@example.com");
  const otherInvitation = await invite(page, otherCollection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation); await accept(relative, otherInvitation, "Another family");
  const bytes = await readFile(`${fixtures}/small.png`);
  const first = await savedPhoto(relative.request, collection, bytes);
  const second = await savedPhoto(relative.request, otherCollection, bytes);
  const pending = await start(relative.request, collection, bytes);
  const outsiderContext = await browser.newContext(); const outsider = await outsiderContext.newPage();
  await signIn(outsider, "outsider@example.com", true); const outsiderCollection = await createCollection(outsider);
  for (const client of [request, outsider.request]) {
    expect([401, 404]).toContain((await client.get(first.path + "/photo", { maxRedirects: 0 })).status());
    expect([307, 404]).toContain((await client.get(first.path, { maxRedirects: 0 })).status());
    expect([401, 404]).toContain((await post(client, collection + "/photo-uploads", { id: randomUUID(), size: String(bytes.length) })).status());
    expect([401, 404]).toContain((await post(client, pending.finish, {})).status());
  }
  expect((await outsider.request.get(`${outsiderCollection}/items/${first.id}/photo`, { maxRedirects: 0 })).status()).toBe(404);
  expect((await post(page.request, pending.finish, {})).status()).toBe(404); // Creator-only finalization, even for another member.
  const relativeId = String((await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id);
  const bounded = (await relative.request.get(first.path + "/photo", { maxRedirects: 0 })).headers().location;
  expect((await post(page.request, `${collection}/members/${relativeId}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  for (const suffix of ["/photo", "/photo?size=thumbnail", ""]) expect((await relative.request.get(first.path + suffix)).status()).toBe(404);
  expect((await post(relative.request, pending.finish, {})).status()).toBe(404);
  expect((await post(relative.request, collection + "/photo-uploads", { id: randomUUID(), size: String(bytes.length) })).status()).toBe(404);
  expect((await relative.request.get(second.path + "/photo", { maxRedirects: 0 })).status()).toBe(307);
  expect((await request.get(bounded)).status()).toBe(200); // Bounded bearer links already issued cannot be recalled.
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(2);
  await outsiderContext.close(); await context.close();
});

test("concurrent/repeated finalization and a lost success response do not duplicate records or files", async ({ page }) => {
  const collection = await family(page);
  const bytes = await readFile(`${fixtures}/small.png`);
  const upload = await start(page.request, collection, bytes);
  const results = await Promise.all([post(page.request, upload.finish, {}), post(page.request, upload.finish, {})]);
  for (const result of results) expect([200, 409]).toContain(result.status());
  expect(results.some(result => result.status() === 200)).toBe(true);
  const retry = await post(page.request, collection + "/photo-uploads", { id: upload.id, size: String(bytes.length) });
  expect((await retry.json()).itemUrl).toBe(`${collection}/items/${upload.id}`);
  expect((await post(page.request, upload.finish, {})).status()).toBe(200);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
  expect((await db.execute("SELECT * FROM item_photos")).rows).toHaveLength(1);
  expect(await keys(`photos/${collection.split("/").pop()}/${upload.id}`)).toHaveLength(2);
});

test("database publication failure rolls back the item and cleans retained files; ordinary retry succeeds", async ({ page }) => {
  const collection = await family(page);
  const upload = await start(page.request, collection, await readFile(`${fixtures}/small.png`));
  await db.execute("CREATE TRIGGER fail_photo_publish BEFORE INSERT ON item_photos BEGIN SELECT RAISE(ABORT, 'synthetic photo publish failure'); END");
  try {
    const result = await post(page.request, upload.finish, {});
    expect(result.status()).toBe(503);
    expect(await result.text()).not.toContain("synthetic photo publish failure");
    expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
    expect((await db.execute("SELECT state FROM photo_uploads")).rows[0].state).toBe("pending");
    expect(await keys(`photos/${collection.split("/").pop()}/${upload.id}`)).toHaveLength(0);
  } finally { await db.execute("DROP TRIGGER fail_photo_publish"); }
  expect((await post(page.request, upload.finish, {})).status()).toBe(200);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
});

test("a failed thumbnail write cleans the full photo and creates no item; the same upload can retry", async ({ page }) => {
  const collection = await family(page);
  const upload = await start(page.request, collection, await readFile(`${fixtures}/small.png`));
  const prefix = `photos/${collection.split("/").pop()}/${upload.id}`;
  await storage.client.send(new PutBucketPolicyCommand({ Bucket: storage.bucket, Policy: JSON.stringify({ Version: "2012-10-17", Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:PutObject", Resource: `arn:aws:s3:::${storage.bucket}/${prefix}/*-thumb.jpg` }] }) }));
  try {
    const result = await post(page.request, upload.finish, {});
    expect(result.status()).toBe(503);
    expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
    expect(await keys(prefix)).toHaveLength(0);
    expect((await db.execute("SELECT state FROM photo_uploads")).rows[0].state).toBe("pending");
  } finally { await storage.client.send(new DeleteBucketPolicyCommand({ Bucket: storage.bucket })); }
  expect((await post(page.request, upload.finish, {})).status()).toBe(200);
  expect(await keys(prefix)).toHaveLength(2);
});

test("removal during storage I/O prevents publishing and preserves an existing saved item", async ({ page, browser }) => {
  const collection = await family(page);
  const invitation = await invite(page, collection, "relative@example.com");
  const context = await browser.newContext(); const relative = await context.newPage();
  await signIn(relative, "relative@example.com"); await accept(relative, invitation);
  const bytes = await readFile(`${fixtures}/small.png`);
  const saved = await savedPhoto(relative.request, collection, bytes);
  const upload = await start(relative.request, collection, bytes);
  execFileSync("podman", ["pause", storage.container], { stdio: "ignore", timeout: 10_000 });
  let pending: ReturnType<typeof post> | undefined;
  try {
    pending = post(relative.request, upload.finish, {});
    await expect.poll(async () => (await db.execute({ sql: "SELECT state FROM photo_uploads WHERE id=?", args: [upload.id] })).rows[0].state, { timeout: 5_000 }).toBe("processing");
    const relativeId = String((await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0].id);
    expect((await post(page.request, `${collection}/members/${relativeId}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
  } finally { execFileSync("podman", ["unpause", storage.container], { stdio: "ignore", timeout: 10_000 }); }
  expect((await pending!).status()).toBe(409);
  expect((await db.execute("SELECT id FROM items")).rows.map(row => row.id)).toEqual([saved.id]);
  expect(await keys(`photos/${collection.split("/").pop()}/${upload.id}`)).toHaveLength(0);
  expect((await page.request.get(saved.path)).status()).toBe(200);
  await context.close();
});

test("missing or size-mismatched staged files are not published and remain retryable", async ({ page }) => {
  const collection = await family(page);
  const id = randomUUID(); const bytes = await readFile(`${fixtures}/small.png`);
  expect((await post(page.request, collection + "/photo-uploads", { id, size: String(bytes.length) })).status()).toBe(200);
  const finish = `${collection}/photo-uploads/${id}/finish`;
  expect((await post(page.request, finish, {})).status()).toBe(503);
  // Operator fixture bypasses the signed size constraint to exercise the second
  // server-side size check against actual stored content.
  await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `staging/${collection.split("/").pop()}/${id}`, Body: "wrong size" }));
  expect((await post(page.request, finish, {})).status()).toBe(503);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
  await start(page.request, collection, bytes, id);
  expect((await post(page.request, finish, {})).status()).toBe(200);
});

test("stale processing leases recover, live leases prevent competing work, and expired uploads need a fresh selection", async ({ page }) => {
  const collection = await family(page);
  const upload = await start(page.request, collection, await readFile(`${fixtures}/small.png`));
  await db.execute({ sql: "UPDATE photo_uploads SET state='processing', attempt=?, lease_until=? WHERE id=?", args: [randomUUID(), Date.now() + 60_000, upload.id] });
  expect((await post(page.request, upload.finish, {})).status()).toBe(409);
  await db.execute("UPDATE photo_uploads SET lease_until=0");
  expect((await post(page.request, upload.finish, {})).status()).toBe(200);
  const expired = await start(page.request, collection, await readFile(`${fixtures}/small.webp`));
  await db.execute({ sql: "UPDATE photo_uploads SET expires_at=0 WHERE id=?", args: [expired.id] });
  expect((await post(page.request, expired.finish, {})).status()).toBe(410);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
});

test("bounded upload forms reject foreign origins, invalid sizes, oversize bodies, reused foreign IDs and exhausted allowances", async ({ page, request }) => {
  const collection = await family(page);
  const path = collection + "/photo-uploads";
  expect((await request.post(path, { form: { id: randomUUID(), size: "100" }, headers: { Origin: "https://attacker.invalid" } })).status()).toBe(403);
  expect((await page.request.post(path, { data: "{}", headers: { Origin: origin, "Content-Type": "application/json" } })).status()).toBe(415);
  for (const size of ["0", "-1", "20971521", "NaN", "1.5"]) expect((await post(page.request, path, { id: randomUUID(), size })).status()).toBe(400);
  expect((await post(page.request, path, { id: "not-a-uuid", size: "100" })).status()).toBe(400);
  expect((await post(page.request, path, { id: randomUUID(), size: "100", padding: "x".repeat(4096) })).status()).toBe(413);
  for (let i = 0; i < 20; i++) expect((await post(page.request, path, { id: randomUUID(), size: "100" })).status()).toBe(200);
  expect((await post(page.request, path, { id: randomUUID(), size: "100" })).status()).toBe(429);
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(0);
});

test("photo migration upgrades a version-two database without changing collections, memberships or sessions", async ({ page }) => {
  const collection = await family(page);
  const before = (await db.execute("SELECT * FROM memberships")).rows;
  await removePeopleSchema(db);
  for (const table of ["item_revisions", "photo_uploads", "item_photos", "items"]) await db.execute(`DROP TABLE ${table}`);
  await db.execute("DELETE FROM schema_migrations WHERE name IN ('0003_photo_drafts.sql', '0004_item_details.sql', '0005_multiple_item_photos.sql')");
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  await page.goto(collection);
  await expect(page.getByRole("heading", { name: "Family one", exact: true })).toBeVisible();
  expect((await db.execute("SELECT * FROM memberships")).rows).toEqual(before);
  await savedPhoto(page.request, collection, await readFile(`${fixtures}/small.png`));
  expect((await db.execute("SELECT * FROM items")).rows).toHaveLength(1);
});

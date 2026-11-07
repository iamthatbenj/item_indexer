import { test, expect } from "@playwright/test";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { removePeopleSchema } from "./support/legacy-database";
import { familyJourney, dbUrl, outbox, operatorEnv, origin, post } from "./support/family";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept, codeFor } = familyJourney(db);

test.beforeEach(async () => {
  await db.batch(["stories", "person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { force: true, recursive: true });
});
test.afterAll(() => db.close());

test("invited relative authenticates, acknowledges terms, joins durably, and signs in later as a member", async ({ page, browser }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  const invitation = await invite(page, collection, "Relative@Example.com");
  const relative = await browser.newContext();
  const other = await relative.newPage();
  await other.goto(invitation);
  await expect(other).toHaveURL(/\/sign-in$/);
  expect(await other.locator("body").innerText()).not.toContain("Family one");
  await signIn(other, "relative@example.com");
  await expect(other.getByRole("heading", { name: "Create a family collection" })).toHaveCount(0);
  await other.getByRole("link", { name: "Review invitation to Family one" }).click();
  await expect(other.getByText("Every family member has equal permission", { exact: false })).toBeVisible();
  await expect(other.getByText("contributions remain attributed", { exact: false })).toBeVisible();
  await expect(other.getByText("including financial evidence", { exact: false })).toBeVisible();
  await expect(other.getByText("Downloaded copies cannot be revoked", { exact: false })).toBeVisible();
  expect((await post(other.request, invitation + "/accept", {})).headers().location).toContain("error=terms");
  expect((await db.execute("SELECT * FROM memberships WHERE role='member'")).rows).toHaveLength(0);
  const beforeJoin = await other.request.get(collection);
  expect(beforeJoin.status()).toBe(404);
  await accept(other, invitation);
  await expect(other.getByText("You are a family member.", { exact: false })).toBeVisible();
  await expect(other.getByRole("heading", { name: "Invite a family member" })).toHaveCount(0);
  expect((await post(other.request, "/collections", { name: "Not a founder" })).status()).toBe(403);
  expect((await db.execute("SELECT role FROM memberships WHERE role='member'")).rows).toHaveLength(1);
  expect((await db.execute("SELECT email FROM approved_founders WHERE email='relative@example.com'")).rows).toHaveLength(0);
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await relative.close();
  // Even an expired, consumed invitation is not needed for a durable member's later sign-in.
  await db.execute("UPDATE invitations SET expires_at=0");
  const returning = await browser.newContext();
  const returned = await returning.newPage();
  await signIn(returned, "relative@example.com");
  await returned.getByRole("link", { name: "Family one", exact: false }).click();
  await expect(returned.getByRole("heading", { name: "Family one", exact: true })).toBeVisible();
  await returning.close();
});

test("forwarded invitations disclose nothing to wrong identities and collection actions enforce administrator scope", async ({ page, browser, request }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page, "Secret family name");
  const invitation = await invite(page, collection, "invited@example.com");
  const outsider = await browser.newContext();
  const other = await outsider.newPage();
  await signIn(other, "outsider@example.com", true);
  await other.goto(invitation);
  await expect(other.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  const text = await other.locator("body").innerText();
  expect(text).not.toContain("Secret family name");
  expect(text).not.toContain("invited@example.com");
  expect((await post(other.request, invitation + "/accept", { acknowledge: "yes", email: "invited@example.com" })).status()).toBe(404);
  expect((await post(other.request, collection + "/invitations", { email: "hijack@example.com", role: "administrator" })).status()).toBe(403);
  expect((await other.goto(collection))?.status()).toBe(404);
  expect((await post(request, invitation + "/accept", { acknowledge: "yes" })).headers().location).toBe(origin + "/sign-in");
  expect((await post(request, collection + "/invitations", { email: "hijack@example.com" })).headers().location).toBe(origin + "/sign-in");
  expect((await request.post(invitation + "/accept", { form: { acknowledge: "yes" }, headers: { Origin: "https://attacker.invalid" } })).status()).toBe(403);
  expect((await request.post(collection + "/invitations", { form: { email: "hijack@example.com" }, headers: { Origin: "https://attacker.invalid" } })).status()).toBe(403);
  expect((await db.execute("SELECT * FROM memberships")).rows).toHaveLength(1);
  expect((await db.execute("SELECT * FROM invitations")).rows).toHaveLength(1);
  await outsider.close();
});

test("one relative switches separate collections, with roles scoped independently", async ({ page, browser }) => {
  await signIn(page, "founder@example.com", true);
  const one = await createCollection(page, "Family one");
  const invitationOne = await invite(page, one, "relative@example.com");
  const two = await createCollection(page, "Family two");
  const invitationTwo = await invite(page, two, "relative@example.com");
  const secret = await createCollection(page, "Unrelated collection");
  const relative = await browser.newContext();
  const other = await relative.newPage();
  await signIn(other, "relative@example.com");
  await accept(other, invitationOne);
  await accept(other, invitationTwo, "Family two");
  const navigation = other.getByRole("navigation", { name: "Switch family collection" });
  await expect(navigation.getByRole("link", { name: "Family two (current)", exact: true })).toHaveAttribute("aria-current", "page");
  await navigation.getByRole("link", { name: "Family one", exact: true }).click();
  await expect(other.getByRole("heading", { name: "Family one", exact: true })).toBeVisible();
  await expect(other.getByRole("navigation").getByText("Unrelated collection")).toHaveCount(0);
  expect((await other.goto(secret))?.status()).toBe(404);
  expect((await post(other.request, one + "/invitations", { email: "blocked@example.com" })).status()).toBe(403);
  // Fixture promotion represents #5's future operator action; permissions are checked afresh, per collection.
  await db.execute({ sql: "UPDATE memberships SET role='administrator' WHERE collection_id=? AND role='member'", args: [two.split("/").pop()!] });
  expect((await post(other.request, two + "/invitations", { email: "allowed@example.com" })).headers().location).toContain("invite=sent");
  expect((await post(other.request, one + "/invitations", { email: "still-blocked@example.com" })).status()).toBe(403);
  await other.goto(one);
  await other.setViewportSize({ width: 375, height: 812 });
  expect(await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await relative.close();
});

test("expired invitations cannot obtain codes and expiry is rechecked at code redemption", async ({ page, browser }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  const invitation = await invite(page, collection, "relative@example.com");
  const relative = await browser.newContext();
  await post(relative.request, "/auth/request", { email: "relative@example.com" });
  const code = await codeFor("relative@example.com");
  await db.execute("UPDATE invitations SET expires_at=0");
  expect((await post(relative.request, "/auth/verify", { email: "relative@example.com", code })).headers().location).toContain("error=code");
  await db.execute("DELETE FROM email_challenges WHERE email='relative@example.com'");
  await post(relative.request, "/auth/request", { email: "relative@example.com" });
  expect((await db.execute("SELECT * FROM email_challenges WHERE email='relative@example.com'")).rows).toHaveLength(0);
  expect((await db.execute("SELECT * FROM accounts WHERE email='relative@example.com'")).rows).toHaveLength(0);
  await page.goto(invitation); // founder is also the wrong email; no details even for its administrator.
  await expect(page.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  await relative.close();
});

test("expiry after sign-in and invalid invitations cannot join or leak collection details", async ({ page, browser }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  const invitation = await invite(page, collection, "relative@example.com");
  const relative = await browser.newContext();
  const other = await relative.newPage();
  await signIn(other, "relative@example.com");
  await db.execute("UPDATE invitations SET expires_at=0");
  for (const path of [invitation, "/invitations/not-real"]) {
    await other.goto(path);
    await expect(other.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
    expect(await other.locator("body").innerText()).not.toContain("Family one");
    expect((await post(other.request, path + "/accept", { acknowledge: "yes" })).status()).toBe(404);
  }
  expect((await db.execute("SELECT * FROM memberships WHERE role='member'")).rows).toHaveLength(0);
  await relative.close();
});

test("resend replaces the old link, invitations have seven-day expiry, and repeated sends are bounded", async ({ page, browser }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  const old = await invite(page, collection, "relative@example.com");
  const latest = await invite(page, collection, "relative@example.com");
  expect(latest).not.toBe(old);
  const row = (await db.execute("SELECT created_at, expires_at FROM invitations")).rows[0];
  expect(Number(row.expires_at) - Number(row.created_at)).toBe(7 * 86400000);
  const relative = await browser.newContext();
  const other = await relative.newPage();
  await signIn(other, "relative@example.com");
  await other.goto(old);
  await expect(other.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  expect((await post(other.request, old + "/accept", { acknowledge: "yes" })).status()).toBe(404);
  await invite(page, collection, "relative@example.com");
  const limited = await post(page.request, collection + "/invitations", { email: "relative@example.com" });
  expect(limited.headers().location).toContain("invite=limited");
  expect((await db.execute("SELECT * FROM invitations")).rows).toHaveLength(1);
  await relative.close();
});

test("concurrent and repeat acceptance is idempotent, preserves roles, and cannot rejoin after removal", async ({ page, browser }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  const invitation = await invite(page, collection, "relative@example.com");
  const relative = await browser.newContext();
  const other = await relative.newPage();
  await signIn(other, "relative@example.com");
  const results = await Promise.all([post(other.request, invitation + "/accept", { acknowledge: "yes", role: "administrator" }), post(other.request, invitation + "/accept", { acknowledge: "yes" })]);
  expect(results.map(r => r.headers().location)).toEqual([origin + collection, origin + collection]);
  expect((await db.execute("SELECT * FROM memberships WHERE role='member'")).rows).toHaveLength(1);
  await other.goto(invitation);
  await expect(other.getByRole("heading", { name: "Already joined" })).toBeVisible();
  expect((await post(page.request, collection + "/invitations", { email: "relative@example.com" })).headers().location).toContain("invite=member");
  const account = (await db.execute("SELECT id FROM accounts WHERE email='relative@example.com'")).rows[0];
  await db.execute({ sql: "UPDATE memberships SET role='administrator' WHERE account_id=?", args: [account.id] });
  await post(other.request, invitation + "/accept", { acknowledge: "yes" });
  expect((await db.execute({ sql: "SELECT role FROM memberships WHERE account_id=?", args: [account.id] })).rows[0].role).toBe("administrator");
  await db.execute({ sql: "DELETE FROM memberships WHERE account_id=?", args: [account.id] });
  expect((await post(other.request, invitation + "/accept", { acknowledge: "yes" })).status()).toBe(404);
  expect((await other.goto(collection))?.status()).toBe(404);
  await relative.close();
});

test("invitation delivery failure removes eligibility and provides recoverable non-secret feedback", async ({ page, browser }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  await rm(outbox, { recursive: true, force: true });
  await writeFile(outbox, "not a directory", { mode: 0o600 });
  try {
    const response = await post(page.request, collection + "/invitations", { email: "relative@example.com" });
    expect(response.headers().location).toContain("invite=failed");
    expect((await db.execute("SELECT * FROM invitations")).rows).toHaveLength(0);
    expect(await response.text()).not.toContain("not a directory");
    const relative = await browser.newContext();
    await post(relative.request, "/auth/request", { email: "relative@example.com" });
    expect((await db.execute("SELECT * FROM email_challenges WHERE email='relative@example.com'")).rows).toHaveLength(0);
    await relative.close();
  } finally { await rm(outbox, { force: true }); }
  await invite(page, collection, "relative@example.com");
});

test("acceptance rolls back membership and invitation consumption together on failure", async ({ page, browser }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  const invitation = await invite(page, collection, "relative@example.com");
  const relative = await browser.newContext();
  const other = await relative.newPage();
  await signIn(other, "relative@example.com");
  await db.execute("CREATE TRIGGER fail_join BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT, 'test join failure'); END");
  try {
    const response = await post(other.request, invitation + "/accept", { acknowledge: "yes" });
    expect(response.status()).toBe(503);
    expect(await response.text()).not.toContain("test join failure");
    expect((await db.execute("SELECT accepted_at FROM invitations")).rows[0].accepted_at).toBeNull();
    expect((await db.execute("SELECT * FROM memberships WHERE role='member'")).rows).toHaveLength(0);
  } finally { await db.execute("DROP TRIGGER fail_join"); }
  await accept(other, invitation);
  await relative.close();
});

test("existing founder records survive upgrading a version-one database and invitations work afterwards", async ({ page }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page, "Existing family record");
  // Reconstruct the actual previous schema in this disposable test database.
  await removePeopleSchema(db);
  for (const table of ["item_revisions", "photo_uploads", "item_photos", "items", "invitations"]) await db.execute(`DROP TABLE ${table}`);
  await db.execute("DELETE FROM schema_migrations WHERE name IN ('0002_family_invitations.sql', '0003_photo_drafts.sql', '0004_item_details.sql', '0005_multiple_item_photos.sql')");
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Existing family record", exact: true })).toBeVisible();
  expect((await db.execute("SELECT role FROM memberships")).rows[0].role).toBe("administrator");
  await invite(page, collection, "relative@example.com");
  expect((await db.execute("SELECT * FROM schema_migrations")).rows).toHaveLength(7);
});

test("administrator permission is rechecked on submission and per-administrator invitations are throttled", async ({ page }) => {
  await signIn(page, "founder@example.com", true);
  const collection = await createCollection(page);
  for (let i=0; i<10; i++) expect((await post(page.request, collection + "/invitations", { email: `relative-${i}@example.com` })).headers().location).toContain("invite=sent");
  expect((await post(page.request, collection + "/invitations", { email: "over-limit@example.com" })).headers().location).toContain("invite=limited");
  await db.execute("UPDATE memberships SET role='member'");
  expect((await post(page.request, collection + "/invitations", { email: "no-longer-admin@example.com" })).status()).toBe(403);
  expect((await db.execute("SELECT * FROM invitations")).rows).toHaveLength(10);
});

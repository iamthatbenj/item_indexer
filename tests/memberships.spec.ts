import { test, expect, type Page, type Browser } from "@playwright/test";
import { createClient } from "@libsql/client";
import { readdir, rm } from "node:fs/promises";
import { familyJourney, dbUrl, outbox, origin, post } from "./support/family";

const db = createClient({ url: dbUrl });
const { signIn, createCollection, invite, accept, codeFor } = familyJourney(db);
const founderEmail = "founder@example.com";
const relativeEmail = "relative@example.com";

test.setTimeout(75_000);
test.beforeEach(async () => {
  await db.batch(["person_revisions", "item_revisions", "photo_uploads", "item_photos", "items", "people", "invitations", "memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { recursive: true, force: true });
});
test.afterAll(() => db.close());

async function accountId(email: string) {
  return String((await db.execute({ sql: "SELECT id FROM accounts WHERE email=?", args: [email] })).rows[0].id);
}

async function joinedRelative(page: Page, browser: Browser) {
  await signIn(page, founderEmail, true);
  const collection = await createCollection(page);
  const invitation = await invite(page, collection, relativeEmail);
  const context = await browser.newContext();
  const relative = await context.newPage();
  await signIn(relative, relativeEmail);
  await accept(relative, invitation);
  return { collection, invitation, context, relative, founderId: await accountId(founderEmail), relativeId: await accountId(relativeEmail) };
}

function roleForm(page: Page, email: string) {
  return page.getByRole("form", { name: `Change role for ${email}`, exact: true });
}
function removalForm(page: Page, email: string) {
  return page.getByRole("form", { name: `Remove access for ${email}`, exact: true });
}
async function removeThroughForm(page: Page, collection: string, email: string) {
  await page.goto(collection + "/members");
  const form = removalForm(page, email);
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Remove access", exact: true }).click();
}

async function administrators(collection: string) {
  return (await db.execute({ sql: "SELECT account_id FROM memberships WHERE collection_id=? AND role='administrator'", args: [collection.split("/").pop()!] })).rows;
}

test("administrators promote and demote current members through native forms; stale administrator actions fail", async ({ page, browser }) => {
  const family = await joinedRelative(page, browser);
  await page.goto(family.collection);
  await page.getByRole("link", { name: "Manage family members and administrators" }).click();
  await expect(page.getByRole("heading", { name: "Manage family members" })).toBeVisible();
  await expect(page.getByText("Administrators manage invitations and access, not editorial authority.", { exact: false })).toBeVisible();
  await roleForm(page, relativeEmail).getByRole("button", { name: "Make administrator", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Membership updated.");
  expect(await administrators(family.collection)).toHaveLength(2);
  await family.relative.goto(family.collection + "/members");
  await expect(family.relative.getByRole("heading", { name: "Manage family members" })).toBeVisible();
  // Founder demotes the relative while the relative still has an administrator form open.
  await roleForm(page, relativeEmail).getByRole("button", { name: "Make family member", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Membership updated.");
  expect((await post(family.relative.request, `${family.collection}/members/${family.founderId}`, { action: "demote" })).status()).toBe(403);
  expect((await post(family.relative.request, family.collection + "/invitations", { email: "blocked@example.com" })).status()).toBe(403);
  expect((await family.relative.goto(family.collection + "/members"))?.status()).toBe(404);
  await family.relative.goto(family.collection);
  await expect(family.relative.getByRole("link", { name: "Manage family members and administrators" })).toHaveCount(0);
  await expect(family.relative.getByText("You are a family member.", { exact: false })).toBeVisible();
  expect(await administrators(family.collection)).toHaveLength(1);
  await family.context.close();
});

test("member management rejects ordinary members, unrelated administrators, forged identities, and signed-out visitors", async ({ page, browser, request }) => {
  const family = await joinedRelative(page, browser);
  const foreignCollection = await createCollection(page, "Another family");
  const outsiderContext = await browser.newContext();
  const outsider = await outsiderContext.newPage();
  await signIn(outsider, "outsider@example.com", true);
  await createCollection(outsider, "Outsider family");
  for (const actor of [family.relative, outsider]) {
    const response = await actor.goto(family.collection + "/members");
    expect(response?.status()).toBe(404);
    const body = await actor.locator("body").innerText();
    expect(body).not.toContain(founderEmail);
    expect(body).not.toContain("Manage family members");
    for (const action of ["promote", "demote", "remove"]) {
      expect((await post(actor.request, `${family.collection}/members/${family.founderId}`, { action, confirm: "yes", actorId: family.founderId, role: "administrator" })).status()).toBe(403);
    }
  }
  expect((await post(family.relative.request, `${foreignCollection}/members/${family.founderId}`, { action: "remove", confirm: "yes" })).status()).toBe(403);
  expect((await post(page.request, `${foreignCollection}/members/${family.relativeId}`, { action: "promote" })).status()).toBe(404);
  const response = await request.get(family.collection + "/members", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers().location).toBe("/sign-in");
  expect((await post(request, `${family.collection}/members/${family.founderId}`, { action: "remove", confirm: "yes" })).headers().location).toBe(origin + "/sign-in");
  expect(await administrators(family.collection)).toHaveLength(1);
  expect((await db.execute("SELECT * FROM memberships WHERE role='member'")).rows).toHaveLength(1);
  await outsiderContext.close();
  await family.context.close();
});

test("the final administrator cannot demote or remove themselves, with clear browser feedback", async ({ page }) => {
  await signIn(page, founderEmail, true);
  const collection = await createCollection(page);
  await page.goto(collection + "/members");
  await roleForm(page, founderEmail).getByRole("button", { name: "Make family member", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Keep at least one family administrator");
  await removeThroughForm(page, collection, founderEmail);
  await expect(page.getByRole("alert")).toContainText("Promote another current member");
  expect(await administrators(collection)).toHaveLength(1);
  expect((await db.execute("SELECT * FROM accounts")).rows).toHaveLength(1);
});

test("self-demotion and self-removal work only after handing administration to another usable member", async ({ page, browser }) => {
  const family = await joinedRelative(page, browser);
  await page.goto(family.collection + "/members");
  await roleForm(page, relativeEmail).getByRole("button", { name: "Make administrator", exact: true }).click();
  await roleForm(page, founderEmail).getByRole("button", { name: "Make family member", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("membership=demoted$"));
  await expect(page.getByRole("status")).toContainText("your editing rights are unchanged");
  expect((await page.goto(family.collection + "/members"))?.status()).toBe(404);
  await family.relative.goto(family.collection + "/members");
  await roleForm(family.relative, founderEmail).getByRole("button", { name: "Make administrator", exact: true }).click();
  await removeThroughForm(page, family.collection, founderEmail);
  await expect(page).toHaveURL(origin + "/?membership=removed");
  await expect(page.getByRole("status")).toContainText("Your contributions remain attributed");
  expect((await page.goto(family.collection))?.status()).toBe(404);
  expect(await administrators(family.collection)).toHaveLength(1);
  // The remaining administrator has no founder approval and need not have a current session.
  await family.relative.goto(family.collection + "/members");
  await family.relative.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(family.relative, relativeEmail);
  await family.relative.goto(family.collection + "/members");
  await expect(family.relative.getByRole("heading", { name: "Manage family members" })).toBeVisible();
  expect((await db.execute({ sql: "SELECT 1 FROM approved_founders WHERE email=?", args: [relativeEmail] })).rows).toHaveLength(0);
  await family.context.close();
});

test("removal denies stale sessions and invitation replay, preserves durable content/editor identity, and leaves other collections alone", async ({ page, browser }) => {
  const family = await joinedRelative(page, browser);
  const otherCollection = await createCollection(page, "Family two");
  const secondInvitation = await invite(page, otherCollection, relativeEmail);
  await accept(family.relative, secondInvitation, "Family two");
  await post(page.request, `${family.collection}/members/${family.relativeId}`, { action: "promote" });
  // A real production record with historical recorder identity must also survive.
  await invite(family.relative, family.collection, "third-relative@example.com");
  const recordedInvitation = (await db.execute({ sql: "SELECT * FROM invitations WHERE email=?", args: ["third-relative@example.com"] })).rows[0];
  // Stories do not ship yet: this durable test-only fixture models their future
  // collection/account reference, without adding unused production tables/APIs.
  await db.execute("CREATE TABLE test_contributions (id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id), recorded_by TEXT NOT NULL REFERENCES accounts(id), text TEXT NOT NULL)");
  try {
    await db.execute({ sql: "INSERT INTO test_contributions VALUES ('recollection', ?, ?, ?)", args: [family.collection.split("/").pop()!, family.relativeId, "Grandmother kept this bowl on her kitchen shelf."] });
    const before = (await db.execute("SELECT c.*, a.email FROM test_contributions c JOIN accounts a ON a.id=c.recorded_by")).rows;
    const accountBefore = (await db.execute({ sql: "SELECT * FROM accounts WHERE id=?", args: [family.relativeId] })).rows;
    const copiedSession = await browser.newContext({ storageState: await family.context.storageState() });
    await family.relative.goto(family.collection + "/members");
    await removeThroughForm(page, family.collection, relativeEmail);
    await expect(page.getByRole("status")).toHaveText("Membership updated.");
    for (const client of [family.relative.request, copiedSession.request]) {
      expect((await client.get(family.collection)).status()).toBe(404);
      expect((await client.get(family.collection + "/members")).status()).toBe(404);
      expect((await post(client, `${family.collection}/members/${family.founderId}`, { action: "remove", confirm: "yes" })).status()).toBe(403);
      expect((await post(client, family.collection + "/invitations", { email: "blocked@example.com" })).status()).toBe(403);
      expect((await post(client, family.invitation + "/accept", { acknowledge: "yes" })).status()).toBe(404);
      expect((await client.get(otherCollection)).status()).toBe(200);
    }
    await family.relative.reload();
    await expect(family.relative.getByRole("heading", { name: "Manage family members" })).toHaveCount(0);
    await family.relative.goto("/");
    await expect(family.relative.getByRole("link", { name: "Family one", exact: false })).toHaveCount(0);
    await family.relative.getByRole("link", { name: "Family two", exact: false }).click();
    await expect(family.relative.getByRole("heading", { name: "Family two", exact: true })).toBeVisible();
    expect((await db.execute("SELECT c.*, a.email FROM test_contributions c JOIN accounts a ON a.id=c.recorded_by")).rows).toEqual(before);
    expect((await db.execute({ sql: "SELECT * FROM accounts WHERE id=?", args: [family.relativeId] })).rows).toEqual(accountBefore);
    expect((await db.execute({ sql: "SELECT * FROM invitations WHERE id=?", args: [recordedInvitation.id] })).rows[0]).toEqual(recordedInvitation);
    expect((await db.execute({ sql: "SELECT role FROM memberships WHERE collection_id=? AND account_id=?", args: [otherCollection.split("/").pop()!, family.relativeId] })).rows[0].role).toBe("member");
    // Rejoining requires a fresh administrator invitation and acknowledgement;
    // it reuses the historical account, but does not restore administrator status.
    const fresh = await invite(page, family.collection, relativeEmail);
    expect(fresh).not.toBe(family.invitation);
    await accept(family.relative, fresh);
    expect((await db.execute({ sql: "SELECT role FROM memberships WHERE collection_id=? AND account_id=?", args: [family.collection.split("/").pop()!, family.relativeId] })).rows[0].role).toBe("member");
    expect((await db.execute("SELECT c.*, a.email FROM test_contributions c JOIN accounts a ON a.id=c.recorded_by")).rows).toEqual(before);
    await copiedSession.close();
  } finally { await db.execute("DROP TABLE test_contributions"); }
  await family.context.close();
});

test("a removed sole-collection member cannot obtain new codes or redeem a pending code; their existing session grants no collection access", async ({ page, browser }) => {
  const family = await joinedRelative(page, browser);
  await post(family.relative.request, "/auth/request", { email: relativeEmail });
  const pendingCode = await codeFor(relativeEmail);
  const messagesBefore = (await readdir(outbox)).sort();
  const sessionCount = (await db.execute("SELECT * FROM sessions")).rows.length;
  await removeThroughForm(page, family.collection, relativeEmail);
  expect((await post(family.relative.request, "/auth/verify", { email: relativeEmail, code: pendingCode })).headers().location).toContain("error=code");
  await post(family.relative.request, "/auth/request", { email: relativeEmail });
  expect((await readdir(outbox)).sort()).toEqual(messagesBefore);
  expect((await db.execute("SELECT * FROM sessions")).rows).toHaveLength(sessionCount);
  expect((await family.relative.request.get(family.collection)).status()).toBe(404);
  await family.relative.goto(family.invitation);
  await expect(family.relative.getByRole("heading", { name: "Invitation unavailable" })).toBeVisible();
  await family.context.close();
});

for (const action of ["demote", "remove"] as const) {
  test(`competing self-${action} requests cannot eliminate the final administrator`, async ({ page, browser }) => {
    const family = await joinedRelative(page, browser);
    await post(page.request, `${family.collection}/members/${family.relativeId}`, { action: "promote" });
    const results = await Promise.all([
      post(page.request, `${family.collection}/members/${family.founderId}`, { action, confirm: "yes" }),
      post(family.relative.request, `${family.collection}/members/${family.relativeId}`, { action, confirm: "yes" }),
    ]);
    expect(results.map(result => result.status())).toEqual([303, 303]);
    expect(results.filter(result => result.headers().location.includes("change=last-administrator"))).toHaveLength(1);
    expect(await administrators(family.collection)).toHaveLength(1);
    expect((await db.execute("SELECT * FROM memberships")).rows).toHaveLength(action === "remove" ? 1 : 2);
    await family.context.close();
  });
}

test("reciprocal administrator changes recheck the actor after the competing removal/demotion", async ({ page, browser }) => {
  const family = await joinedRelative(page, browser);
  await post(page.request, `${family.collection}/members/${family.relativeId}`, { action: "promote" });
  const results = await Promise.all([
    post(page.request, `${family.collection}/members/${family.relativeId}`, { action: "remove", confirm: "yes" }),
    post(family.relative.request, `${family.collection}/members/${family.founderId}`, { action: "demote" }),
  ]);
  expect(results.map(result => result.status()).sort()).toEqual([303, 403]);
  expect(await administrators(family.collection)).toHaveLength(1);
  await family.context.close();
});

test("failed removal rolls back invitation invalidation as well as membership, then succeeds on retry", async ({ page, browser }) => {
  const family = await joinedRelative(page, browser);
  // Model an existing membership with a still-pending invitation (e.g. a later
  // restoration path). Removing access must not leave that route back open.
  await db.execute("UPDATE invitations SET accepted_at=NULL");
  await db.execute("CREATE TRIGGER fail_removal BEFORE DELETE ON memberships BEGIN SELECT RAISE(ABORT, 'test removal failure'); END");
  try {
    const response = await post(page.request, `${family.collection}/members/${family.relativeId}`, { action: "remove", confirm: "yes" });
    expect(response.status()).toBe(503);
    expect(await response.text()).not.toContain("test removal failure");
    expect((await db.execute("SELECT * FROM memberships WHERE role='member'")).rows).toHaveLength(1);
    expect((await db.execute("SELECT * FROM invitations WHERE accepted_at IS NULL")).rows).toHaveLength(1);
    expect((await family.relative.request.get(family.collection)).status()).toBe(200);
  } finally { await db.execute("DROP TRIGGER fail_removal"); }
  await removeThroughForm(page, family.collection, relativeEmail);
  expect((await db.execute("SELECT * FROM invitations")).rows).toHaveLength(0);
  expect((await post(family.relative.request, family.invitation + "/accept", { acknowledge: "yes" })).status()).toBe(404);
  expect((await family.relative.request.get(family.collection)).status()).toBe(404);
  await family.context.close();
});

test("membership writes enforce origin, bounded forms, valid actions, and explicit removal confirmation", async ({ page }) => {
  await signIn(page, founderEmail, true);
  const collection = await createCollection(page);
  const path = `${collection}/members/${await accountId(founderEmail)}`;
  expect((await page.request.post(path, { form: { action: "demote" }, headers: { Origin: "https://attacker.invalid" } })).status()).toBe(403);
  expect((await page.request.post(path, { form: { action: "demote" } })).status()).toBe(403);
  expect((await page.request.post(path, { data: { action: "demote" }, headers: { Origin: origin } })).status()).toBe(415);
  expect((await post(page.request, path, { action: "invalid" })).status()).toBe(400);
  expect((await post(page.request, path, { action: "remove" })).status()).toBe(400);
  expect((await post(page.request, path, { action: "remove", confirm: "yes", extra: "x".repeat(4096) })).status()).toBe(413);
  expect((await post(page.request, collection + "/members/nonexistent", { action: "promote" })).status()).toBe(404);
  expect((await post(page.request, path, { action: "promote" })).headers().location).toContain("change=unchanged");
  expect(await administrators(collection)).toHaveLength(1);
});

test("management copy explains irreversible copies and retention; controls remain labelled and usable on mobile", async ({ page }) => {
  // No hyphens or other natural wrap points in the maximum-length local part.
  const longEmail = `${"a".repeat(64)}@example.com`;
  await signIn(page, longEmail, true);
  const collection = await createCollection(page);
  await page.goto(collection + "/members");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByText("Removing access preserves contributions and historical attribution.", { exact: false })).toBeVisible();
  await expect(page.getByText("already issued file links may work until their bounded expiry", { exact: false })).toBeVisible();
  await expect(page.getByText("prior downloads and exported copies cannot be revoked", { exact: false })).toBeVisible();
  const form = removalForm(page, longEmail);
  await form.getByRole("checkbox").focus();
  await page.keyboard.press("Space");
  await expect(form.getByRole("checkbox")).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = "http://127.0.0.1:3100";
const dbUrl = `file:${resolve(".local/e2e/test.db")}`;
const outbox = resolve(".local/e2e/outbox");
const db = createClient({ url: dbUrl });
const operatorEnv = { ...process.env, TURSO_DATABASE_URL: dbUrl, TURSO_AUTH_TOKEN: "" };

function approve(email: string) {
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "approve", email], { env: operatorEnv });
}

async function messages(email: string): Promise<{ text: string }[]> {
  const files = await readdir(outbox).catch(() => [] as string[]);
  const all = await Promise.all(files.map(async name => JSON.parse(await readFile(`${outbox}/${name}`, "utf8")) as { to: string; text: string }));
  return all.filter(mail => mail.to === email);
}

async function deliveredCode(email: string): Promise<string> {
  await expect.poll(async () => (await messages(email)).length).toBeGreaterThan(0);
  // A challenge ID is only a test fixture lookup, not a public delivery/read API.
  const rows = await db.execute({ sql: "SELECT id FROM email_challenges WHERE email=?", args: [email] });
  const mail = JSON.parse(await readFile(`${outbox}/${rows.rows[0].id}.json`, "utf8")) as { text: string };
  const code = mail.text.match(/\b\d{6}\b/)?.[0];
  if (!code) throw new Error("Test delivery did not contain a code");
  return code;
}

async function post(request: APIRequestContext, path: string, form: Record<string, string>) {
  return request.post(path, { form, headers: { Origin: origin }, maxRedirects: 0 });
}

async function login(page: Page, email: string, trusted = true) {
  approve(email);
  await page.goto("/sign-in");
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email has access");
  await page.getByLabel("Email for this code").fill(email);
  await page.getByLabel("Six-digit code").fill(await deliveredCode(email));
  if (trusted) await page.getByLabel("Keep me signed in").check();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Family collections", exact: true })).toBeVisible();
}

test.beforeEach(async () => {
  await db.batch(["memberships", "collections", "sessions", "email_challenges", "accounts", "approved_founders", "rate_limits"].map(table => `DELETE FROM ${table}`), "write");
  await rm(outbox, { force: true, recursive: true });
});
test.afterAll(() => db.close());

test("approved founder creates a durable private collection and returns through a trusted session", async ({ page, browser }) => {
  // Re-running the operator command is safe, and mixed case is normalized.
  approve("Founder@Example.com");
  await login(page, "founder@example.com");
  await page.getByLabel("Collection name").fill("Our family memories");
  await page.getByRole("button", { name: "Create collection" }).click();
  await expect(page.getByRole("heading", { name: "Our family memories" })).toBeVisible();
  await expect(page.getByText("You are a family administrator.", { exact: false })).toBeVisible();
  const url = page.url();
  expect(url).toMatch(/\/collections\/[\w-]+$/);
  const membership = (await db.execute("SELECT role FROM memberships")).rows;
  expect(membership).toHaveLength(1);
  expect(membership[0].role).toBe("administrator");
  const state = await page.context().storageState();
  const cookie = state.cookies.find(cookie => cookie.name === "family_session")!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe("Lax");
  expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
  const returning = await browser.newContext({ storageState: state });
  const returnedPage = await returning.newPage();
  await returnedPage.goto(url);
  await expect(returnedPage.getByRole("heading", { name: "Our family memories" })).toBeVisible();
  await returnedPage.goto("/");
  await expect(returnedPage.getByRole("link", { name: "Our family memories" })).toBeVisible();
  await returning.close();
  const response = await page.request.get(url);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
});

test("unknown visitors cannot enroll themselves, obtain codes, or create collections", async ({ page, request }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email address", { exact: true }).fill("unknown@example.com");
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(page.getByRole("status")).toContainText("If this email has access");
  expect(await messages("unknown@example.com")).toHaveLength(0);
  const verify = await post(request, "/auth/verify", { email: "unknown@example.com", code: "123456" });
  expect(verify.headers().location).toContain("error=code");
  const create = await post(request, "/collections", { name: "Not permitted" });
  expect(create.headers().location).toBe(`${origin}/sign-in`);
  expect((await db.execute("SELECT * FROM collections")).rows).toHaveLength(0);
});

test("incorrect codes fail, a valid code is single-use even under concurrent redemption", async ({ request, browser }) => {
  const email = "one-use@example.com";
  approve(email);
  await post(request, "/auth/request", { email });
  const code = await deliveredCode(email);
  const wrong = code === "000000" ? "000001" : "000000";
  const incorrect = await post(request, "/auth/verify", { email, code: wrong });
  expect(incorrect.headers().location).toContain("error=code");
  const other = await browser.newContext();
  const results = await Promise.all([
    post(request, "/auth/verify", { email, code }),
    post(other.request, "/auth/verify", { email, code }),
  ]);
  expect(results.map(r => r.headers().location).filter(url => url === `${origin}/`)).toHaveLength(1);
  expect((await db.execute("SELECT * FROM sessions")).rows).toHaveLength(1);
  const reused = await post(request, "/auth/verify", { email, code });
  expect(reused.headers().location).toContain("error=code");
  await other.close();
});

test("expired codes fail through the sign-in journey without exposing secrets", async ({ page }) => {
  const email = "expired@example.com";
  approve(email);
  await page.goto("/sign-in");
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const code = await deliveredCode(email);
  await db.execute({ sql: "UPDATE email_challenges SET expires_at=? WHERE email=?", args: [Date.now() - 1, email] });
  await page.getByLabel("Email for this code").fill(email);
  await page.getByLabel("Six-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("That code could not be used");
  expect((await db.execute("SELECT * FROM sessions")).rows).toHaveLength(0);
  expect(await page.locator("body").innerText()).not.toContain(code);
});

test("code resends supersede old codes and email requests are throttled", async ({ request }) => {
  const email = "resend@example.com";
  approve(email);
  await post(request, "/auth/request", { email });
  const first = await deliveredCode(email);
  await post(request, "/auth/request", { email });
  const latest = await deliveredCode(email);
  if (first !== latest) {
    expect((await post(request, "/auth/verify", { email, code: first })).headers().location).toContain("error=code");
  }
  await post(request, "/auth/request", { email });
  await post(request, "/auth/request", { email });
  expect(await messages(email)).toHaveLength(3);
  const stored = (await db.execute({ sql: "SELECT digest FROM email_challenges WHERE email=?", args: [email] })).rows[0].digest;
  expect(String(stored)).toMatch(/^[a-f0-9]{64}$/);
});

test("five incorrect guesses exhaust a challenge and verification throttles persist across sessions", async ({ request, browser }) => {
  const email = "attempts@example.com";
  approve(email);
  await post(request, "/auth/request", { email });
  const code = await deliveredCode(email);
  const wrong = code === "000000" ? "000001" : "000000";
  for (let i = 0; i < 5; i++) await post(request, "/auth/verify", { email, code: wrong });
  expect((await post(request, "/auth/verify", { email, code })).headers().location).toContain("error=code");
  await post(request, "/auth/request", { email });
  const replacement = await deliveredCode(email);
  for (let i = 0; i < 4; i++) await post(request, "/auth/verify", { email, code: wrong });
  const other = await browser.newContext();
  expect((await post(other.request, "/auth/verify", { email, code: replacement })).headers().location).toContain("error=code");
  expect((await db.execute("SELECT * FROM sessions")).rows).toHaveLength(0);
  await other.close();
});

test("sign-out revokes the server session, including a copied old cookie", async ({ page, browser }) => {
  await login(page, "signout@example.com");
  const stolenState = await page.context().storageState();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status")).toContainText("signed out");
  expect((await db.execute("SELECT * FROM sessions")).rows).toHaveLength(0);
  const stale = await browser.newContext({ storageState: stolenState });
  const stalePage = await stale.newPage();
  await stalePage.goto("/");
  await expect(stalePage).toHaveURL(/\/sign-in$/);
  await stale.close();
});

test("untrusted sessions use a browser-session cookie and expire on the server", async ({ page }) => {
  await login(page, "short@example.com", false);
  const cookie = (await page.context().cookies()).find(cookie => cookie.name === "family_session")!;
  expect(cookie.expires).toBe(-1);
  const session = (await db.execute("SELECT created_at, expires_at FROM sessions")).rows[0];
  expect(Number(session.expires_at) - Number(session.created_at)).toBe(12 * 60 * 60 * 1000);
  await db.execute({ sql: "UPDATE sessions SET expires_at=?", args: [Date.now() - 1] });
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("a second founder cannot discover or retrieve the first collection by identifier", async ({ page, browser, request }) => {
  await login(page, "family-one@example.com");
  await page.getByLabel("Collection name").fill("A private family name");
  await page.getByRole("button", { name: "Create collection" }).click();
  await expect(page.getByRole("heading", { name: "A private family name" })).toBeVisible();
  const privateUrl = page.url();
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await login(secondPage, "family-two@example.com");
  await expect(secondPage.getByText("A private family name")).toHaveCount(0);
  const denied = await secondPage.goto(privateUrl);
  expect(denied?.status()).toBe(404);
  expect(await secondPage.locator("body").innerText()).not.toContain("A private family name");
  const signedOut = await request.get(privateUrl, { maxRedirects: 0 });
  expect(signedOut.headers().location).toContain("/sign-in");
  await second.close();
});

test("revoking founder approval prevents collection creation even from an existing session", async ({ page }) => {
  const email = "revoked@example.com";
  await login(page, email);
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "revoke", email], { env: operatorEnv });
  const denied = await post(page.request, "/collections", { name: "Not approved" });
  expect(denied.status()).toBe(403);
  expect((await db.execute("SELECT * FROM collections")).rows).toHaveLength(0);
  await page.reload();
  await expect(page.getByText("Founder approval is required")).toBeVisible();
});

test("writes reject cross-origin and missing-origin requests, oversized bodies, and invalid names", async ({ page, request }) => {
  expect((await request.post("/auth/request", { form: { email: "victim@example.com" }, headers: { Origin: "https://attacker.example" } })).status()).toBe(403);
  expect((await request.post("/auth/request", { form: { email: "victim@example.com" } })).status()).toBe(403);
  const tooLarge = await post(request, "/auth/request", { email: "x".repeat(5000) });
  expect(tooLarge.status()).toBe(413);
  await login(page, "names@example.com");
  for (const name of ["  ", "x".repeat(121)]) {
    const invalid = await post(page.request, "/collections", { name });
    expect(invalid.headers().location).toContain("error=name");
  }
  expect((await db.execute("SELECT * FROM collections")).rows).toHaveLength(0);
});

test("global request throttling bounds different email addresses and clears with a new window", async ({ request }) => {
  const email = "global-limit@example.com";
  approve(email);
  for (let i = 0; i < 30; i++) await post(request, "/auth/request", { email: `unknown-${i}@example.com` });
  const limited = await post(request, "/auth/request", { email });
  expect(limited.headers().location).toContain("sent=1");
  expect(await messages(email)).toHaveLength(0);
  await db.execute("UPDATE rate_limits SET window_start = window_start - 1800000");
  await post(request, "/auth/request", { email });
  expect(await deliveredCode(email)).toMatch(/^\d{6}$/);
});

test("failed email delivery leaves no usable challenge or secret in the public response", async ({ request }) => {
  const email = "delivery-failure@example.com";
  approve(email);
  // A file at the outbox directory path forces the real local delivery operation to fail.
  await writeFile(outbox, "not a directory", { mode: 0o600 });
  try {
    const response = await post(request, "/auth/request", { email });
    expect(response.headers().location).toContain("sent=1");
    expect((await db.execute("SELECT * FROM email_challenges")).rows).toHaveLength(0);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await response.text()).not.toContain("not a directory");
  } finally {
    await rm(outbox, { force: true });
  }
});

test("collection creation rolls back if assigning its administrator fails", async ({ page }) => {
  await login(page, "rollback@example.com");
  await db.execute("CREATE TRIGGER fail_membership BEFORE INSERT ON memberships BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  try {
    const failed = await post(page.request, "/collections", { name: "Must not be orphaned" });
    expect(failed.status()).toBe(503);
    expect(await failed.text()).not.toContain("test failure");
    expect((await db.execute("SELECT * FROM collections")).rows).toHaveLength(0);
    expect((await db.execute("SELECT * FROM memberships")).rows).toHaveLength(0);
  } finally {
    await db.execute("DROP TRIGGER fail_membership");
  }
});

test("migrations can be rerun without losing existing collections", async ({ page }) => {
  await login(page, "migration@example.com");
  await page.getByLabel("Collection name").fill("Preserved through migration");
  await page.getByRole("button", { name: "Create collection" }).click();
  await expect(page.getByRole("heading", { name: "Preserved through migration" })).toBeVisible();
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env: operatorEnv });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Preserved through migration" })).toBeVisible();
  expect((await db.execute("SELECT * FROM schema_migrations")).rows).toHaveLength(1);
});

test("mobile sign-in and collection creation remain usable without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page, "mobile@example.com");
  await page.getByLabel("Collection name").fill("Grandma’s collection");
  await page.getByRole("button", { name: "Create collection" }).click();
  await expect(page.getByRole("heading", { name: "Grandma’s collection" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

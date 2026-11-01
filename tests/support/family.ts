import { expect, type Page, type APIRequestContext } from "@playwright/test";
import type { Client } from "@libsql/client";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const origin = "http://127.0.0.1:3100";
export const dbUrl = `file:${resolve(".local/e2e/test.db")}`;
export const outbox = resolve(".local/e2e/outbox");
export const operatorEnv = { ...process.env, TURSO_DATABASE_URL: dbUrl, TURSO_AUTH_TOKEN: "" };

export async function post(request: APIRequestContext, path: string, form: Record<string, string>) {
  return request.post(path, { form, headers: { Origin: origin }, maxRedirects: 0 });
}

// Each spec owns its database client's lifecycle; helpers exercise the public UI
// and read captured local mail rather than injecting authenticated state.
export function familyJourney(db: Client) {
  async function codeFor(email: string) {
    const challenge = (await db.execute({ sql: "SELECT id FROM email_challenges WHERE email=?", args: [email] })).rows[0];
    const mail = JSON.parse(await readFile(`${outbox}/${challenge.id}.json`, "utf8"));
    return mail.text.match(/\b\d{6}\b/)[0] as string;
  }

  async function signIn(page: Page, email: string, founder = false) {
    if (founder) execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "approve", email], { env: operatorEnv });
    await page.goto("/sign-in");
    await page.getByLabel("Email address", { exact: true }).fill(email);
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(page.getByRole("status")).toContainText("If this email has access");
    await page.getByLabel("Email for this code").fill(email);
    await page.getByLabel("Six-digit code").fill(await codeFor(email));
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Family collections", exact: true })).toBeVisible();
  }

  async function createCollection(page: Page, name = "Family one") {
    await page.goto("/");
    await page.getByLabel("Collection name").fill(name);
    await page.getByRole("button", { name: "Create collection" }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    return new URL(page.url()).pathname;
  }

  async function invite(page: Page, collectionPath: string, email: string) {
    await page.goto(collectionPath);
    await page.getByLabel("Relative’s email address").fill(email);
    await page.getByRole("button", { name: "Send invitation", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Invitation sent");
    const row = (await db.execute({ sql: "SELECT id FROM invitations WHERE email=? AND collection_id=?", args: [email.toLowerCase(), collectionPath.split("/").pop()!] })).rows[0];
    const mail = JSON.parse(await readFile(`${outbox}/${row.id}.json`, "utf8"));
    expect(mail.to).toBe(email.toLowerCase());
    expect(mail.text).toContain("seven days");
    expect(mail.text).toContain("forwarded link does not grant access");
    const url = mail.text.match(/http:\/\/127\.0\.0\.1:3100\/invitations\/[\w-]+/)[0];
    return new URL(url).pathname;
  }

  async function accept(page: Page, path: string, name = "Family one") {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: `Join ${name}`, exact: true })).toBeVisible();
    await page.getByLabel("I understand these joining terms").check();
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }

  return { signIn, createCollection, invite, accept, codeFor };
}

import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createClient } from "@libsql/client";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dbUrl, familyJourney, post } from "./support/family";

const db = createClient({ url: dbUrl, timeout: 5000 });
const { signIn, createCollection, invite, accept } = familyJourney(db);
test.afterAll(() => db.close());

async function capture(request: APIRequestContext, collection: string) {
  const bytes = await readFile("tests/fixtures/photos/small.png"), id = randomUUID();
  const endpoint = `${collection}/photo-uploads`;
  const start = await post(request, endpoint, { id, size: String(bytes.length) });
  expect(start.status()).toBe(200);
  expect((await request.put((await start.json()).uploadUrl, { data: bytes, headers: { "Content-Type": "application/octet-stream" } })).status()).toBe(200);
  expect((await post(request, `${endpoint}/${id}/finish`, {})).status()).toBe(200);
  return `${collection}/items/${id}`;
}
const searchUrl = (collection: string, q: string, page?: number) => `${collection}/search?${new URLSearchParams(page ? { q, page: String(page) } : { q })}`;
const results = (page: Page) => page.getByRole("region", { name: "Search results" });
async function search(page: Page, q: string) {
  await page.getByRole("searchbox", { name: "Search this collection" }).fill(q);
  await page.getByRole("button", { name: "Search belongings" }).click();
  await expect(page.getByRole("heading", { name: "Search belongings", exact: true })).toBeVisible();
}

test("browser search finds current names, descriptions and stories, with private thumbnails and identifiable drafts", async ({ page }) => {
  await signIn(page, "search-founder@example.com", true);
  const collection = await createCollection(page, "Search family");
  const item = await capture(page.request, collection);
  const draft = await capture(page.request, collection);
  const teller = randomUUID(), story = randomUUID();
  expect((await post(page.request, `${collection}/people/records`, { id: teller, name: "Aunt Jo", note: "" })).status()).toBe(200);
  expect((await post(page.request, `${item}/details`, { version: "1", name: "Cedar trunk", description: "A silver clasp marked 100%." })).status()).toBe(200);
  expect((await post(page.request, `${draft}/stories`, { id: story, storyteller: teller, text: "At the pier we saw 星光 and <em>fireflies</em>." })).status()).toBe(200);
  expect((await post(page.request, `${draft}/stories`, { id: randomUUID(), storyteller: teller, text: "Another recollection of fireflies." })).status()).toBe(200);
  await page.goto(collection);
  await search(page, " CEDAR ");
  await expect(results(page).getByRole("link", { name: /Cedar trunk.*Complete item/ })).toHaveAttribute("href", item);
  const image = results(page).getByRole("img", { name: "Photo of Cedar trunk" });
  await expect(image).toHaveAttribute("src", `${item}/photo?size=thumbnail`);
  await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  await search(page, "100%");
  await expect(results(page)).toContainText("Match: Description");
  await expect(results(page)).toContainText("A silver clasp marked 100%.");
  await search(page, "fireflies");
  await expect(results(page).getByRole("link", { name: /Untitled belonging.*Draft item/ })).toHaveAttribute("href", draft);
  await expect(results(page).getByRole("listitem")).toHaveCount(1);
  await expect(results(page)).toContainText("Match: Story");
  await search(page, "<em>fireflies</em>");
  await expect(results(page)).toContainText("<em>fireflies</em>");
  await expect(results(page).locator("em")).toHaveCount(0);
  await search(page, "星光");
  await expect(results(page)).toContainText("Untitled belonging");
  expect((await post(page.request, `${draft}/stories/${story}/details`, { version: "1", text: "A new draft recollection about a lighthouse." })).status()).toBe(200);
  await page.reload();
  await expect(results(page)).toContainText("No belongings match that search.");
  await search(page, "lighthouse");
  await expect(results(page)).toContainText("A new draft recollection about a lighthouse.");
  expect((await post(page.request, `${item}/details`, { version: "2", name: "Maple chest", description: "A brass latch." })).status()).toBe(200);
  await search(page, "Cedar");
  await expect(results(page)).toContainText("No belongings match that search.");
  await search(page, "brass latch");
  await expect(results(page)).toContainText("Maple chest");
  await search(page, "   ");
  await expect(page.getByText("Enter a word or phrase to find a belonging.")).toBeVisible();
  await expect(results(page)).toHaveCount(0);
});

test("results and thumbnail grants are collection-scoped and stop after membership revocation", async ({ page, browser, request }) => {
  await signIn(page, "search-owner@example.com", true);
  const shared = await createCollection(page, "Shared search family");
  const item = await capture(page.request, shared);
  const other = await createCollection(page, "Hidden search family");
  const foreign = await capture(page.request, other);
  const foreignKeeper = randomUUID();
  expect((await post(page.request, `${other}/people/records`, { id: foreignKeeper, name: "Private keeper", note: "" })).status()).toBe(200);
  for (const [path, name] of [[item, "Shared needle"], [foreign, "Hidden needle"]]) {
    expect((await post(page.request, `${path}/details`, { version: "1", name, description: "Family object" })).status()).toBe(200);
  }
  const details = await post(page.request, `${foreign}/details`, { version: "2", name: "Hidden needle", description: "Family object", categoryName: "Private category", locationName: "Private location", currentKeeper: foreignKeeper });
  expect(details.status()).toBe(200);
  const foreignOptions = await (await page.request.get(`${foreign}/details?choices=1`)).json();
  const invitation = await invite(page, shared, "search-relative@example.com");
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await signIn(member, "search-relative@example.com"); await accept(member, invitation, "Shared search family");
    const response = await member.goto(searchUrl(shared, "needle"));
    expect(response?.headers()["cache-control"]).toContain("no-store");
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(results(member).getByRole("listitem")).toHaveCount(1);
    await expect(results(member)).toContainText("Shared needle");
    await expect(member.locator("main")).not.toContainText("Hidden needle");
    expect((await member.request.get(searchUrl(other, "needle"))).status()).toBe(404);
    for (const [key, id, label] of [["category", foreignOptions.category[0].id, "Category"], ["location", foreignOptions.location[0].id, "Location"], ["keeper", foreignKeeper, "Current keeper"]]) {
      const invalid = await member.goto(searchUrl(shared, "needle") + `&${key}=${id}`);
      expect(invalid?.status()).toBe(200);
      await expect(member.locator("main").getByRole("alert")).toContainText(`Unavailable filters: ${label}`);
      await expect(results(member)).toHaveCount(0);
      expect(await invalid?.text()).not.toMatch(/Private (keeper|category|location)|Hidden needle/);
    }
    await member.goto(searchUrl(shared, "needle") + "&status=draft&status=complete");
    await expect(member.locator("main").getByRole("alert")).toContainText("Unavailable filters: Draft status");
    await expect(results(member)).toHaveCount(0);
    await member.goto(searchUrl(shared, "needle"));
    expect((await member.request.get(`${foreign}/photo?size=thumbnail`, { maxRedirects: 0 })).status()).toBe(404);
    expect((await member.request.get(`${item}/photo?size=thumbnail`, { maxRedirects: 0 })).status()).toBe(307);
    expect((await request.get(`${item}/photo?size=thumbnail`, { maxRedirects: 0 })).status()).toBe(401);
    const memberId = String((await db.execute("SELECT id FROM accounts WHERE email='search-relative@example.com'")).rows[0].id);
    expect((await post(page.request, `${shared}/members/${memberId}`, { action: "remove", confirm: "yes" })).status()).toBe(303);
    expect((await member.reload())?.status()).toBe(404);
    await expect(member.locator("main")).not.toContainText("Shared needle");
    expect((await member.request.get(`${item}/photo?size=thumbnail`, { maxRedirects: 0 })).status()).toBe(404);
  } finally { await context.close(); }
});

test("members combine browse filters with search and can clear them", async ({ page }) => {
  await signIn(page, "filter-founder@example.com", true);
  const collection = await createCollection(page, "Filter family");
  const item = await capture(page.request, collection), other = await capture(page.request, collection);
  const keeper = randomUUID();
  expect((await post(page.request, `${collection}/people/records`, { id: keeper, name: "Jo", note: "" })).status()).toBe(200);
  expect((await post(page.request, `${item}/details`, { version: "1", name: "Cedar trunk", description: "With a clasp", currentKeeper: keeper, categoryName: "Furniture", locationName: "Attic" })).status()).toBe(200);
  expect((await post(page.request, `${other}/details`, { version: "1", name: "Cedar bowl", description: "", categoryName: "Furniture" })).status()).toBe(200);
  await page.goto(collection);
  await page.getByRole("link", { name: "Browse and filter belongings" }).click();
  await expect(results(page)).toContainText("2 belongings");
  await page.getByLabel("Category", { exact: true }).selectOption({ label: "Furniture" });
  await page.getByLabel("Current keeper", { exact: true }).selectOption(keeper);
  await page.getByLabel("Location", { exact: true }).selectOption({ label: "Attic" });
  await page.getByLabel("Draft status", { exact: true }).selectOption("complete");
  await search(page, "CEDAR");
  await expect(results(page)).toContainText("1 belonging");
  await expect(results(page).getByRole("link", { name: /Cedar trunk/ })).toHaveAttribute("href", item);
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(results(page)).toContainText("2 belongings");
  await expect(page.getByRole("searchbox")).toHaveValue("CEDAR");
  await page.getByLabel("Current keeper", { exact: true }).selectOption("unassigned");
  await page.getByLabel("Location", { exact: true }).selectOption("unassigned");
  await page.getByLabel("Draft status", { exact: true }).selectOption("draft");
  await search(page, "");
  await expect(results(page).getByRole("link", { name: /Cedar bowl.*Draft item/ })).toHaveAttribute("href", other);
  await expect(results(page).getByRole("listitem")).toHaveCount(1);
});

test("filters reflect renamed and merged labels and changed keeper assignments", async ({ page }) => {
  await signIn(page, "filter-updates@example.com", true);
  const collection = await createCollection(page, "Updated filters family");
  const first = await capture(page.request, collection), second = await capture(page.request, collection);
  const keeper = randomUUID();
  expect((await post(page.request, `${collection}/people/records`, { id: keeper, name: "Jo", note: "Dad’s side" })).status()).toBe(200);
  const save = (path: string, version: string, extra: Record<string, string>) => post(page.request, `${path}/details`, { version, name: path === first ? "Red cup" : "Blue cup", description: "Family ceramics", ...extra });
  expect((await save(first, "1", { categoryName: "Cups", currentKeeper: keeper })).status()).toBe(200);
  expect((await save(second, "1", { categoryName: "Mugs" })).status()).toBe(200);
  const options = (await (await page.request.get(`${first}/details?choices=1`)).json()).category as { id: string; name: string }[];
  const source = options.find(choice => choice.name === "Cups")!.id, target = options.find(choice => choice.name === "Mugs")!.id;
  const { id: accountId } = await (await page.request.get("/auth/account")).json();
  const operations = `${collection}/labels/operations`;
  async function changeLabel(fields: Record<string, string>) {
    const input = { accountId, kind: "category", ...fields };
    const preview = await post(page.request, operations, { ...input, phase: "preview" });
    expect(preview.status()).toBe(200);
    expect((await post(page.request, operations, { ...input, phase: "apply", token: (await preview.json()).token })).status()).toBe(200);
  }
  await changeLabel({ action: "rename", source: target, name: "Drinking vessels" });
  await page.goto(`${collection}/search?category=${target}&keeper=${keeper}`);
  await expect(page.getByLabel("Category", { exact: true }).locator("option:checked")).toHaveText("Drinking vessels");
  await expect(results(page)).toContainText("0 belongings");
  await expect(results(page)).toContainText("No belongings match these filters.");
  await changeLabel({ action: "merge", source, target });
  await page.reload();
  await expect(results(page).getByRole("link", { name: /Red cup/ })).toHaveAttribute("href", first);
  await expect(page.getByLabel("Category", { exact: true }).getByRole("option", { name: "Cups", exact: true })).toHaveCount(0);
  await page.goto(`${collection}/search?category=${source}`);
  await expect(page.locator("main").getByRole("alert")).toContainText("Unavailable filters: Category");
  await expect(results(page)).toHaveCount(0);
  expect((await save(first, "3", { currentKeeper: "" })).status()).toBe(200);
  await page.goto(`${collection}/search?category=${target}&keeper=${keeper}`);
  await expect(results(page)).toContainText("0 belongings");
  await page.goto(`${collection}/search?category=${target}&keeper=unassigned`);
  await expect(results(page)).toContainText("2 belongings");
});

test("search pages are bounded and stable for unchanged results", async ({ page }) => {
  await signIn(page, "search-pages@example.com", true);
  const collection = await createCollection(page, "Paged search family");
  const sample = (await capture(page.request, collection)).split("/").pop()!;
  await page.goto("/"); await page.waitForLoadState("networkidle");
  // Bulk fixture only; browsing and pagination run through the public page.
  const ids = Array.from({ length: 25 }, () => randomUUID());
  await db.batch(ids.flatMap((id, index) => [
    { sql: "INSERT INTO items(id, collection_id, name, description, created_at, created_by) SELECT ?, collection_id, ?, 'Fixture', ?, created_by FROM items WHERE id=?", args: [id, `Paged match ${index}`, index, sample] },
    { sql: "INSERT INTO item_photos(id, item_id, photo_key, thumbnail_key, width, height, photo_bytes, sha256, created_at, created_by) SELECT ?, ?, ?, ?, width, height, photo_bytes, sha256, created_at, created_by FROM item_photos WHERE item_id=?", args: [id, id, `test/${id}/main`, `test/${id}/thumb`, sample] },
  ]), "write");
  // These fixture entries have metadata but no backing blobs. The first test
  // checks real private thumbnail delivery independently.
  await page.route("**/photo?size=thumbnail", route => route.abort());
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(searchUrl(collection, "paged match") + "&status=complete&keeper=unassigned");
  await expect(results(page)).toContainText("25 belongings");
  await expect(results(page).getByRole("listitem")).toHaveCount(24);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expect(results(page).getByRole("link", { name: /Paged match 24.*Complete item/ })).toBeVisible();
  await page.getByRole("link", { name: "Next results" }).click();
  await expect(results(page).getByRole("listitem")).toHaveCount(1);
  await expect(results(page).getByRole("link", { name: /Paged match 0.*Complete item/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Next results" })).toHaveCount(0);
  await expect(page.getByLabel("Draft status", { exact: true })).toHaveValue("complete");
  await expect(page.getByLabel("Current keeper", { exact: true })).toHaveValue("unassigned");
  const filteredPage = page.url();
  await results(page).getByRole("link", { name: /Paged match 0.*Complete item/ }).click();
  await expect(page.getByRole("heading", { name: "Paged match 0", exact: true })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(filteredPage);
  await expect(page.getByRole("searchbox")).toHaveValue("paged match");
  await expect(results(page)).toContainText("25 belongings");
  await page.getByRole("link", { name: "Previous results" }).click();
  await expect(results(page).getByRole("listitem")).toHaveCount(24);
  await page.goto(searchUrl(collection, "paged match", 3));
  await expect(results(page)).toContainText("No results on this page.");
  await page.goto(searchUrl(collection, "paged match", 101));
  await expect(page.locator("main").getByRole("alert")).toContainText("results page is unavailable");
  await page.goto(searchUrl(collection, "x".repeat(121)));
  await expect(page.locator("main").getByRole("alert")).toContainText("up to 120 characters");
});

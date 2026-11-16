import { after } from "next/server";
import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { discardInventory, generateInventory, inventoryList, InventoryError, requestInventory } from "@/server/inventory-exports";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again to inspect inventories." }, { status: 401, headers });
    return Response.json({ jobs: await inventoryList(account.id, (await context.params).id) }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof InventoryError ? error.message : "Inventory status could not be loaded. Check access and service availability." }, { status: error instanceof InventoryError ? error.status : 503, headers });
  }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before requesting an inventory." }, { status: 401, headers });
    if (form.getAll("accountId").length > 1 || form.has("accountId") && form.get("accountId") !== account.id) return Response.json({ error: "The signed-in account changed. Reload before requesting an inventory." }, { status: 409, headers });
    if (form.getAll("id").length !== 1 || form.getAll("action").length !== 1 || !["create", "retry", "discard"].includes(form.get("action")!)) return Response.json({ error: "Choose a valid single inventory action and identifier." }, { status: 400, headers });
    const { id: collectionId } = await context.params;
    try {
      if (form.get("action") === "discard") {
        await discardInventory(account.id, collectionId, form.get("id")!);
        return Response.json({ discarded: true }, { headers });
      }
      const result = await requestInventory(account.id, collectionId, form.get("id")!, form.get("action") === "retry");
      if (result.work) after(() => generateInventory(result.work!));
      return Response.json({ job: result.job }, { status: result.work ? 202 : 200, headers });
    } catch (error) {
      return Response.json({ error: error instanceof InventoryError ? error.message : "Inventory request was not confirmed. Check status before retrying." }, { status: error instanceof InventoryError ? error.status : 503, headers });
    }
  });
}

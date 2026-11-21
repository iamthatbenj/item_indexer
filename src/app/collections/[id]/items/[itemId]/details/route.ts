import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { editItem, getItem, ItemEditError } from "@/server/items";
import { ItemLabelError, listItemLabels } from "@/server/item-labels";
import { itemLabelKinds, type ItemLabelInput } from "@/shared/item-labels";
import { personLabel } from "@/shared/people";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  const headers = { "Cache-Control": "private, no-store" };
  const account = await currentAccount();
  if (!account) return Response.json({ error: "Sign in to compare saved details." }, { status: 401, headers });
  const { id, itemId } = await params;
  const item = await getItem(account.id, id, itemId);
  if (!item) return Response.json({ error: "This item is unavailable." }, { status: 404, headers });
  if (new URL(_request.url).searchParams.get("choices") === "1") return Response.json(await listItemLabels(account.id, id), { headers });
  return Response.json({ current: { version: item.version, fields: [
    { label: "Name", value: item.name }, { label: "Short description", value: item.description },
    { label: "Current keeper", value: item.currentKeeper ? personLabel(item.currentKeeper) : "Not recorded" },
    { label: "Category", value: item.category?.name ?? "Not recorded" }, { label: "Location", value: item.location?.name ?? "Not recorded" },
  ] } }, { headers });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string; itemId: string }> }) {
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return Response.json({ error: "Sign in again before saving. Keep this page open to copy your text." }, { status: 401 });
    if (form.getAll("accountId").length > 1 || form.has("accountId") && form.get("accountId") !== account.id) return Response.json({ error: "The signed-in account changed. Sign in as the original contributor before saving pending text." }, { status: 409, headers: { "Cache-Control": "private, no-store" } });
    const { id, itemId } = await params;
    try {
      // Never accept a client-declared status, photo, revision, or editor identity.
      for (const field of ["version", "name", "description"]) {
        if (form.getAll(field).length !== 1) throw new ItemEditError("Submit one editing version, name, and description.");
      }
      if (form.getAll("currentKeeper").length > 1) throw new ItemEditError("Submit at most one current keeper.");
      const labels: ItemLabelInput = {};
      for (const kind of itemLabelKinds) {
        const ids = form.getAll(`${kind}Id`), names = form.getAll(`${kind}Name`);
        if (ids.length > 1 || names.length > 1) throw new ItemEditError(`Submit at most one ${kind}.`);
        if (ids.length || names.length) labels[kind] = { id: ids[0], name: names[0] };
      }
      await editItem(account.id, id, itemId, form.get("version")!, form.get("name")!, form.get("description")!, form.has("currentKeeper") ? form.get("currentKeeper")! : undefined, labels);
      return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof ItemLabelError) return Response.json({ error: error.message }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
      if (error instanceof ItemEditError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
      throw error;
    }
  }, 16 * 1024);
}

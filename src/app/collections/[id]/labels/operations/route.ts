import { currentAccount } from "@/server/auth";
import { formPost } from "@/server/http";
import { applyLabelOperation, previewLabelOperation, LabelManagementError, type LabelOperation } from "@/server/label-management";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "private, no-store" };
  const reply = (value: object, status = 200) => Response.json(value, { status, headers });
  return formPost(request, async form => {
    const account = await currentAccount();
    if (!account) return reply({ error: "Sign in again before managing labels." }, 401);
    if (form.getAll("accountId").length !== 1 || form.get("accountId") !== account.id) return reply({ error: "The signed-in account changed. Reload this page." }, 409);
    const kind = form.get("kind"), source = form.get("source"), action = form.get("action"), phase = form.get("phase");
    const target = form.get("target"), name = form.get("name"), token = form.get("token");
    const id = (value: string | null): value is string => !!value && /^[a-f0-9-]{36}$/i.test(value);
    if ([...new Set(form.keys())].some(key => form.getAll(key).length !== 1) || (kind !== "category" && kind !== "location") || !id(source) || (phase !== "preview" && phase !== "apply") || (phase === "apply" && !/^[0-9a-f]{64}$/.test(token ?? ""))) return reply({ error: "Review one valid label change before confirming." }, 400);
    let operation: LabelOperation;
    if (action === "rename" && name !== null && target === null) operation = { kind, source, action, name };
    else if (action === "merge" && id(target) && name === null) operation = { kind, source, action, target };
    else return reply({ error: "Choose a new name or two labels of the same kind." }, 400);
    const { id: collection } = await params;
    try {
      return reply(phase === "preview" ? await previewLabelOperation(account.id, collection, operation) : await applyLabelOperation(account.id, collection, operation, token!));
    } catch (error) {
      if (error instanceof LabelManagementError) return reply({ error: error.message }, error.status);
      throw error;
    }
  });
}

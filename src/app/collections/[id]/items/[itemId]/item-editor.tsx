"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ITEM_NAME_LIMIT, ITEM_DESCRIPTION_LIMIT } from "@/shared/item-details";

export default function ItemEditor({ path, initial }: { path: string; initial: { name: string; description: string; version: number } }) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  // Keep the version paired with these fields even if RSC props are refreshed.
  const [version] = useState(initial.version);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { setReady(true); }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict) return;
    inFlight.current = true; setBusy(true); setError(""); setProgress("Saving your item — please wait for confirmation.");
    try {
      const response = await fetch(`${path}/details`, {
        method: "POST", body: new URLSearchParams({ version: String(version), name, description }), signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.saved !== true) {
        if (response.status === 409) setConflict(true);
        throw new Error(result?.error || "Save was not confirmed. Your text remains here; check your connection or sign in again before retrying.");
      }
      // Navigate only AFTER confirmed success. Errors never reload this page,
      // refresh the editing version, or replace the contributor's input.
      window.location.assign(`${path}?saved=1`);
    } catch (error) {
      setError(error instanceof Error && error.name === "Error" ? error.message : "Save was interrupted. Your text remains here. A retry will check the original version, not overwrite a newer edit.");
      setProgress("");
    } finally { inFlight.current = false; setBusy(false); }
  }

  return <section className="card" aria-labelledby="item-editor-heading">
    <h2 id="item-editor-heading">Name and describe this belonging</h2>
    <p id="item-details-help">Describe one object or a set together; no component records are needed. A retained photo, name, and short description make the item complete. You can save either text field unfinished to keep a draft.</p>
    <p className="hint">Every member has equal editing rights. Previous versions and editing identities are retained. You are editing version {version}.</p>
    <form action={`${path}/details`} method="post" onSubmit={save} aria-describedby="item-details-help" aria-busy={busy}>
      <input type="hidden" name="version" value={version} />
      <fieldset className="item-fields" disabled={!ready || busy}>
        <legend className="hint">Shared item details</legend>
        <label htmlFor="item-name">Name</label>
        <input id="item-name" name="name" maxLength={ITEM_NAME_LIMIT} value={name} onChange={event => setName(event.target.value)} aria-describedby="item-name-help" />
        <p className="hint" id="item-name-help">Up to {ITEM_NAME_LIMIT} characters. Leave blank if you do not know it yet.</p>
        <label htmlFor="item-description">Short description</label>
        <textarea id="item-description" name="description" rows={5} maxLength={ITEM_DESCRIPTION_LIMIT} value={description} onChange={event => setDescription(event.target.value)} aria-describedby="item-description-help" />
        <p className="hint" id="item-description-help">Up to {ITEM_DESCRIPTION_LIMIT} characters. Stories, keeper, location, category, and financial information are not required.</p>
      </fieldset>
      <p role={progress ? "status" : undefined} aria-live="polite">{progress}</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      {conflict && <p><a href={path} target="_blank" rel="noopener">Open latest saved item in a new tab</a>. Keep this tab open to copy your attempted text; nothing is automatically merged.</p>}
      <button disabled={!ready || busy || conflict} type="submit">{busy ? "Saving…" : "Save item details"}</button>
    </form>
    <p className="hint">Online connection required. On errors, your text stays on this open page, not across closing or reloading it. History browsing and richer conflict reconciliation come later.</p>
    <noscript>Editing requires JavaScript so unsuccessful saves can keep your text on this page.</noscript>
  </section>;
}

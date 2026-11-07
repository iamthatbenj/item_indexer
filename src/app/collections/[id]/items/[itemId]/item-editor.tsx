"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ITEM_NAME_LIMIT, ITEM_DESCRIPTION_LIMIT } from "@/shared/item-details";
import { personLabel, type PersonSummary } from "@/shared/people";

export default function ItemEditor({ path, peoplePath, people, initial }: { path: string; peoplePath: string; people: PersonSummary[]; initial: { name: string; description: string; version: number; currentKeeperId: string } }) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [currentKeeper, setCurrentKeeper] = useState(initial.currentKeeperId);
  const [choices, setChoices] = useState(people);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // Keep the version paired with these fields even if RSC props are refreshed.
  const [version] = useState(initial.version);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => { setReady(true); }, []);

  async function refreshPeople() {
    setRefreshing(true); setError("");
    try {
      const response = await fetch(`${peoplePath}/records`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(result?.people)) throw new Error("People could not be refreshed. Check your access or connection; your item details remain here.");
      setChoices(result.people);
      setProgress("Current keeper choices refreshed. Your unsaved details and editing version are unchanged.");
    } catch (error) {
      setError(error instanceof Error && error.name === "Error" ? error.message : "People could not be refreshed. Your item details remain here.");
    } finally { setRefreshing(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict) return;
    inFlight.current = true; setBusy(true); setError(""); setProgress("Saving your item — please wait for confirmation.");
    try {
      const response = await fetch(`${path}/details`, {
        method: "POST", body: new URLSearchParams({ version: String(version), name, description, currentKeeper }), signal: AbortSignal.timeout(30_000),
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
        <p className="hint" id="item-description-help">Up to {ITEM_DESCRIPTION_LIMIT} characters. Stories, current keeper, location, category, and financial information are not required.</p>
        <label htmlFor="keeper-filter">Find a current keeper</label>
        <input id="keeper-filter" type="search" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} maxLength={200} aria-describedby="keeper-help" />
        <label htmlFor="current-keeper">Current keeper (optional)</label>
        <select id="current-keeper" name="currentKeeper" value={currentKeeper} onChange={event => setCurrentKeeper(event.target.value)} aria-describedby="keeper-help">
          <option value="">No current keeper recorded</option>
          {choices.filter(person => person.id === currentKeeper || personLabel(person).toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(person => <option key={person.id} value={person.id}>{personLabel(person)}</option>)}
        </select>
        <p id="keeper-help" className="hint">The current keeper cares for this item; this does not establish legal ownership. They do not need an app account. Missing keeper information does not prevent completion.</p>
        <p><a href={peoplePath} target="_blank" rel="noopener">Manage people in a new tab</a>. Then refresh choices here without losing your unsaved item details.</p>
        <button type="button" className="secondary" disabled={refreshing} onClick={refreshPeople}>{refreshing ? "Refreshing people…" : "Refresh keeper choices"}</button>
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

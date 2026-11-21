"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ITEM_NAME_LIMIT, ITEM_DESCRIPTION_LIMIT } from "@/shared/item-details";
import { personLabel, type PersonSummary } from "@/shared/people";
import ConflictReview from "@/app/components/conflict-review";
import PendingTextControls from "@/app/components/pending-text-controls";
import { usePendingText, type TextScope } from "@/client/use-pending-text";
import { ITEM_LABEL_LIMIT, itemLabelKinds, type ItemLabelKind, type ItemLabelChoices, type ItemLabelInput } from "@/shared/item-labels";
import type { ItemTextInput } from "@/client/pending-text";

export default function ItemEditor({ scope, path, peoplePath, people, labelChoices, initial }: { scope: TextScope; path: string; peoplePath: string; people: PersonSummary[]; labelChoices: ItemLabelChoices; initial: { name: string; description: string; version: number; currentKeeperId: string; labels: ItemLabelInput } }) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [currentKeeper, setCurrentKeeper] = useState(initial.currentKeeperId);
  const [labels, setLabels] = useState(initial.labels);
  const [availableLabels, setAvailableLabels] = useState(labelChoices);
  const [choices, setChoices] = useState(people);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  // Keep the version paired with these fields even if RSC props are refreshed.
  const [version, setVersion] = useState(initial.version);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => { setReady(true); }, []);
  const pending = usePendingText(scope, "item");
  const input = (): ItemTextInput => ({ kind: "item", name, description, currentKeeper, labels, version });
  function stage(changes: Partial<ItemTextInput>) { void pending.stage({ ...input(), ...changes }); }

  function setLabel(kind: ItemLabelKind, choice: { id?: string; name?: string }) {
    const next = { ...labels, [kind]: choice };
    setLabels(next); stage({ labels: next });
  }

  async function refreshLabels() {
    setRefreshing(true); setError("");
    try {
      const checked = await pending.verify();
      const response = await fetch(`${path}/details?choices=1`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const result = await response.json().catch(() => null);
      if (response.status === 401) await pending.verify();
      pending.assertCurrent(checked);
      if (!response.ok || !itemLabelKinds.every(kind => Array.isArray(result?.[kind]))) throw new Error();
      setAvailableLabels(result);
      setProgress("Category and location choices refreshed without replacing your unsaved edits.");
    } catch { setError("Label choices could not be refreshed. Check your access or connection, then retry."); }
    finally { setRefreshing(false); }
  }

  async function refreshPeople() {
    setRefreshing(true); setError("");
    try {
      const checked = await pending.verify();
      const response = await fetch(`${peoplePath}/records`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const result = await response.json().catch(() => null);
      pending.assertCurrent(checked);
      if (!response.ok || !Array.isArray(result?.people)) throw new Error("People could not be refreshed. Check your access or connection; your item details remain here.");
      setChoices(result.people);
      setProgress("Current keeper choices refreshed. Your unsaved details and editing version are unchanged.");
    } catch (error) {
      setError(error instanceof Error && error.name === "Error" ? error.message : "People could not be refreshed. Your item details remain here.");
    } finally { setRefreshing(false); }
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict || pending.busy || !pending.authorized) return;
    inFlight.current = true; setBusy(true); setError(""); setProgress("Saving your item — please wait for confirmation.");
    try {
      const local = await pending.prepare(input());
      const body = new URLSearchParams({ accountId: scope.accountId, version: String(version), name, description, currentKeeper });
      for (const kind of itemLabelKinds) {
        const choice = labels[kind];
        if (choice) { body.set(`${kind}Id`, choice.id ?? ""); body.set(`${kind}Name`, choice.name ?? ""); }
      }
      const response = await fetch(`${path}/details`, {
        method: "POST", body, signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json().catch(() => null);
      pending.checkResponse(local, response.status, result?.error);
      if (!response.ok || result?.saved !== true) {
        if (response.status === 409) setConflict(true);
        throw new Error(result?.error || "Save was not confirmed. Your text remains here; check your connection or sign in again before retrying.");
      }
      // Navigate only AFTER confirmed success. Errors never reload this page,
      // refresh the editing version, or replace the contributor's input.
      if (await pending.confirmed(local)) window.location.assign(`${path}?saved=1`);
      else setProgress("Server confirmed the item save. Local cleanup was not confirmed; check the saved item before discarding pending copies.");
    } catch (error) {
      setError(error instanceof Error && error.name === "Error" ? error.message : "Save was interrupted. Your text remains here. A retry will check the original version, not overwrite a newer edit.");
      setProgress("");
    } finally { inFlight.current = false; setBusy(false); }
  }

  const selectedKeeper = choices.find(person => person.id === currentKeeper);
  return <section className="card" aria-labelledby="item-editor-heading">
    <h2 id="item-editor-heading">Name and describe this belonging</h2>
    <p id="item-details-help">Describe one object or a set together; no component records are needed. A retained photo, name, and short description make the item complete. You can save either text field unfinished to keep a draft.</p>
    <p className="hint">Every member has equal editing rights. Previous versions and editing identities are retained. You are editing version {version}.</p>
    <PendingTextControls pending={pending} disabled={busy} onResume={restored => {
      if (restored.kind !== "item") return;
      setName(restored.name); setDescription(restored.description); setCurrentKeeper(restored.currentKeeper); setLabels(restored.labels ?? {}); setVersion(restored.version);
      setConflict(true); setError(""); setProgress("Recovered pending local item details. Compare with current saved content before deliberately revising and saving.");
    }} onDiscardCurrent={() => { setName(initial.name); setDescription(initial.description); setCurrentKeeper(initial.currentKeeperId); setLabels(initial.labels); setVersion(initial.version); setConflict(false); setError(""); setProgress(""); }} />
    {pending.authorized && <form action={`${path}/details`} method="post" onSubmit={save} aria-describedby="item-details-help" aria-busy={busy}>
      <input type="hidden" name="version" value={version} />
      <fieldset className="item-fields" disabled={!ready || busy || pending.busy}>
        <legend className="hint">Shared item details</legend>
        <label htmlFor="item-name">Name</label>
        <input ref={nameField} id="item-name" name="name" maxLength={ITEM_NAME_LIMIT} value={name} onChange={event => { setName(event.target.value); stage({ name: event.target.value }); }} aria-describedby="item-name-help" />
        <p className="hint" id="item-name-help">Up to {ITEM_NAME_LIMIT} characters. Leave blank if you do not know it yet.</p>
        <label htmlFor="item-description">Short description</label>
        <textarea id="item-description" name="description" rows={5} maxLength={ITEM_DESCRIPTION_LIMIT} value={description} onChange={event => { setDescription(event.target.value); stage({ description: event.target.value }); }} aria-describedby="item-description-help" />
        <p className="hint" id="item-description-help">Up to {ITEM_DESCRIPTION_LIMIT} characters. Stories, current keeper, location, category, and financial information are not required.</p>
        <label htmlFor="keeper-filter">Find a current keeper</label>
        <input id="keeper-filter" type="search" value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === "Enter") event.preventDefault(); }} maxLength={200} aria-describedby="keeper-help" />
        <label htmlFor="current-keeper">Current keeper (optional)</label>
        <select id="current-keeper" name="currentKeeper" value={currentKeeper} onChange={event => { setCurrentKeeper(event.target.value); stage({ currentKeeper: event.target.value }); }} aria-describedby="keeper-help">
          <option value="">No current keeper recorded</option>
          {choices.filter(person => person.id === currentKeeper || personLabel(person).toLocaleLowerCase().includes(filter.toLocaleLowerCase())).map(person => <option key={person.id} value={person.id}>{personLabel(person)}</option>)}
        </select>
        <p id="keeper-help" className="hint">The current keeper cares for this item; this does not establish legal ownership. They do not need an app account. Missing keeper information does not prevent completion.</p>
        <p><a href={peoplePath} target="_blank" rel="noopener">Manage people in a new tab</a>. Then refresh choices here without losing your unsaved item details.</p>
        <button type="button" className="secondary" disabled={refreshing} onClick={refreshPeople}>{refreshing ? "Refreshing people…" : "Refresh keeper choices"}</button>
        {itemLabelKinds.map(kind => {
          const title = kind === "category" ? "Category" : "Location";
          const choice = labels[kind];
          const selected = choice === undefined ? "__keep" : choice.id ?? "";
          return <div className="item-fields" key={kind}>
            <label htmlFor={`item-${kind}`}>{title} (optional)</label>
            <select id={`item-${kind}`} value={selected} onChange={event => setLabel(kind, { id: event.target.value })}>
              {selected === "__keep" && <option value="__keep">Keep the saved {kind}</option>}
              <option value="">No {kind} selected</option>
              {selected && selected !== "__keep" && !availableLabels[kind].some(label => label.id === selected) && <option value={selected}>Selected {kind} (refresh choices to view)</option>}
              {availableLabels[kind].map(label => <option key={label.id} value={label.id}>{label.name}</option>)}
            </select>
            <label htmlFor={`new-item-${kind}`}>New {kind} label</label>
            <input id={`new-item-${kind}`} maxLength={ITEM_LABEL_LIMIT} value={choice?.name ?? ""} onChange={event => setLabel(kind, { name: event.target.value })} />
          </div>;
        })}
        <p className="hint">Choose a shared label or enter a new one. Labels describe the item and do not affect who can see it.</p>
        <button type="button" className="secondary" disabled={refreshing} onClick={refreshLabels}>Refresh label choices</button>
      </fieldset>
      <p role={progress ? "status" : undefined} aria-live="polite">{progress}</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      {conflict && !pending.busy && <>
        <p><a href={path} target="_blank" rel="noopener">Open latest saved item in a new tab</a>. Keep this tab open to copy your attempted text; nothing is automatically merged.</p>
        <ConflictReview kind="item" url={`${path}/details`} attempted={[
          { label: "Name", value: name }, { label: "Short description", value: description },
          { label: "Current keeper", value: currentKeeper ? selectedKeeper ? personLabel(selectedKeeper) : "Selected person (refresh choices to view their name)" : "Not recorded" },
          ...itemLabelKinds.map(kind => ({
            label: kind === "category" ? "Category" : "Location",
            value: labels[kind] === undefined ? "Keep the saved label" : labels[kind]?.name || (labels[kind]?.id ? availableLabels[kind].find(label => label.id === labels[kind]?.id)?.name ?? "Selected label" : "Not recorded"),
          })),
        ]} onReviewed={reviewed => { setVersion(reviewed); stage({ version: reviewed }); setConflict(false); setError(""); setProgress(`You reviewed version ${reviewed}. Revise your fields, then save deliberately; your input is unchanged.`); nameField.current?.focus(); }} />
      </>}
      <button disabled={!ready || busy || pending.busy || conflict} type="submit">{busy ? "Saving…" : "Save item details"}</button>
    </form>}
    <p className="hint">Online connection required for account checks, comparison and saving. Locally retained pending text can be resumed after interruption while signed in as the original contributor, subject to browser storage limits. Recovered edits must be compared before saving; no automatic merge or stale overwrite is performed.</p>
    <noscript>Editing requires JavaScript so unsuccessful saves can keep your text on this page.</noscript>
  </section>;
}

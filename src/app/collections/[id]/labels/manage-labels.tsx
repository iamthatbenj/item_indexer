"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ITEM_LABEL_LIMIT, itemLabelKinds, type ItemLabelChoices, type ItemLabelKind } from "@/shared/item-labels";

type Review = { token: string; count: number; source: string; destination: string; done: boolean };

export default function ManageLabels({ accountId, endpoint, choices }: { accountId: string; endpoint: string; choices: ItemLabelChoices }) {
  const [kind, setKind] = useState<ItemLabelKind>("category");
  const [action, setAction] = useState<"rename" | "merge">("rename");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const inFlight = useRef(false);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !source || (action === "merge" ? !target : !name.trim())) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const form = new URLSearchParams({ accountId, kind, action, source, phase: review ? "apply" : "preview" });
      form.set(action === "merge" ? "target" : "name", action === "merge" ? target : name);
      if (review) form.set("token", review.token);
      const response = await fetch(endpoint, { method: "POST", body: form, cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (!review) setReview(result);
      else { setSaved(result.changed ? (action === "merge" ? "Labels merged." : "Label renamed.") : "This change is already reflected in the collection."); setReview(null); }
    } catch (error) {
      setReview(null);
      setError(error instanceof Error && error.name === "Error" && error.message ? error.message : "The result was not confirmed. Review the change again or reload the collection before retrying.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  if (saved) return <section className="card"><p role="status">{saved}</p><button type="button" onClick={() => window.location.reload()}>Reload active labels</button></section>;
  return <form className="card edit-history" onSubmit={submit}>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={!ready || busy || review !== null}>
      <legend>Choose a shared label change</legend>
      <label htmlFor="label-kind">Label kind</label>
      <select id="label-kind" value={kind} onChange={e => { setKind(e.target.value as ItemLabelKind); setSource(""); setTarget(""); setName(""); }}>
        {itemLabelKinds.map(value => <option key={value} value={value}>{value === "category" ? "Category" : "Location"}</option>)}
      </select>
      <label htmlFor="label-action">Change type</label>
      <select id="label-action" value={action} onChange={e => setAction(e.target.value as "rename" | "merge")}><option value="rename">Rename</option><option value="merge">Merge duplicates</option></select>
      <label htmlFor="source-label">{action === "merge" ? "Source label to retire" : "Label to rename"}</label>
      <select id="source-label" value={source} required onChange={e => { setSource(e.target.value); setTarget(""); }}>
        <option value="">Choose a label</option>{choices[kind].map(label => <option key={label.id} value={label.id}>{label.name}</option>)}
      </select>
      {action === "rename" ? <><label htmlFor="new-label-name">New label name</label><input id="new-label-name" value={name} required maxLength={ITEM_LABEL_LIMIT} onChange={e => setName(e.target.value)} /></> : <>
        <label htmlFor="target-label">Destination label to keep</label><select id="target-label" value={target} required onChange={e => setTarget(e.target.value)}>
          <option value="">Choose a destination</option>{choices[kind].filter(label => label.id !== source).map(label => <option key={label.id} value={label.id}>{label.name}</option>)}
        </select>
      </>}
    </fieldset>
    {review && <section aria-label="Review affected items" aria-live="polite">
      <h2>{action === "merge" ? "Confirm merge" : "Confirm rename"}</h2>
      {review.done ? <p>This change is already reflected in the collection.</p> : <><p>{action === "merge" ? "Merge" : "Rename"} <strong>{review.source}</strong> {action === "merge" ? "into" : "to"} <strong>{review.destination}</strong>. {review.count} {review.count === 1 ? "item" : "items"} affected.</p>
      <p>{action === "merge" ? "Current assignments move to the destination. The source is retired, but earlier item versions still show it." : "The same label will have a new name everywhere it is used."}</p></>}
      <button type="button" className="secondary" disabled={busy} onClick={() => setReview(null)}>Cancel review</button>
    </section>}
    <button type="submit" disabled={!ready || busy || !source || (action === "merge" ? !target : !name.trim())}>{review ? "Confirm label change" : "Review label change"}</button>
    <p><a href="">Reload active labels</a></p>
  </form>;
}

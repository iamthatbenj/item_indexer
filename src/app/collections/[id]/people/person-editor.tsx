"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PERSON_NAME_LIMIT, PERSON_NOTE_LIMIT, type PersonSummary } from "@/shared/people";

export default function PersonEditor({ path, initial }: { path: string; initial?: PersonSummary }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [note, setNote] = useState(initial?.note ?? "");
  const [version] = useState(initial?.version);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const operation = useRef(""); const inFlight = useRef(false);
  useEffect(() => { setReady(true); }, []);
  const personPath = initial ? `${path}/${initial.id}` : operation.current ? `${path}/${operation.current}` : path;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict) return;
    inFlight.current = true; setBusy(true); setError("");
    if (!operation.current) operation.current = crypto.randomUUID();
    try {
      const response = await fetch(initial ? `${path}/${initial.id}/details` : `${path}/records`, {
        method: "POST", body: new URLSearchParams(initial ? { version: String(version), name, note } : { id: operation.current, name, note }), signal: AbortSignal.timeout(30_000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.saved !== true) {
        if (response.status === 409) setConflict(true);
        throw new Error(result?.error || "Save was not confirmed. Your details remain here; check your connection or sign in again before retrying.");
      }
      window.location.assign(`${initial ? personPath : result.personUrl}?saved=1`);
    } catch (error) {
      setError(error instanceof Error && error.name === "Error" ? error.message : "Save was interrupted. Keep this page open; retrying checks the same request rather than silently replacing another contribution.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="card" aria-labelledby="person-editor-heading">
    <h2 id="person-editor-heading">{initial ? "Edit identifying details" : "Add a person"}</h2>
    <p>A person belongs to this collection, not to an app account. No email, invitation, or membership is needed. Add an identifying note to distinguish people with the same name.</p>
    <p className="hint">All collection members can edit these details. Earlier names, notes, and editing identities are retained.{initial ? ` You are editing version ${version}.` : " Same-name people remain separate records."}</p>
    <form onSubmit={save} aria-busy={busy}>
      <fieldset className="item-fields" disabled={!ready || busy}>
        <legend className="hint">Person identifying details</legend>
        <label htmlFor="person-name">Person name</label>
        <input id="person-name" name="name" value={name} onChange={event => setName(event.target.value)} maxLength={PERSON_NAME_LIMIT} required autoComplete="off" />
        <label htmlFor="person-note">Identifying note (optional)</label>
        <textarea id="person-note" name="note" rows={3} value={note} onChange={event => setNote(event.target.value)} maxLength={PERSON_NOTE_LIMIT} aria-describedby="person-note-help" />
        <p id="person-note-help" className="hint">Up to {PERSON_NOTE_LIMIT} characters. For example, “Aunt on Dad’s side”. Avoid unnecessary private information.</p>
      </fieldset>
      {busy && <p role="status">Saving person — please wait for confirmation.</p>}
      {error && <p role="alert" className="notice error">{error}</p>}
      {conflict && <p><a href={personPath} target="_blank" rel="noopener">Open latest saved person in a new tab</a>. Keep this tab open to copy your attempted details; nothing is automatically merged.</p>}
      <button type="submit" disabled={!ready || busy || conflict}>{busy ? "Saving…" : initial ? "Save person details" : "Save person"}</button>
    </form>
    <p className="hint">Online connection required. Unsuccessful saves keep your details only while this page stays open. History browsing, merging and deletion of people are not included yet.</p>
    <noscript>Editing requires JavaScript so unsuccessful saves can preserve your attempted details.</noscript>
  </section>;
}

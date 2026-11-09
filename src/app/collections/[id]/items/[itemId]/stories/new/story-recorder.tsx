"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { personLabel, type PersonSummary } from "@/shared/people";
import { STORY_PROMPTS, STORY_TEXT_LIMIT } from "@/shared/stories";

export default function StoryRecorder({ path, peoplePath, people }: { path: string; peoplePath: string; people: PersonSummary[] }) {
  const [choices, setChoices] = useState(people);
  const [storyteller, setStoryteller] = useState(""); const [text, setText] = useState("");
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false); const [conflict, setConflict] = useState(false);
  const [error, setError] = useState(""); const [progress, setProgress] = useState("");
  const operation = useRef(""); const inFlight = useRef(false);
  useEffect(() => { setReady(true); }, []);
  async function refreshPeople() {
    setRefreshing(true); setError("");
    try {
      const response = await fetch(`${peoplePath}/records`, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(result?.people)) throw new Error("People could not be refreshed. Check your access or connection; your story remains here.");
      setChoices(result.people); setProgress("Storyteller choices refreshed. Your story and selection are unchanged.");
    } catch (error) {
      setError(error instanceof Error && error.name === "Error" ? error.message : "People could not be refreshed. Your story remains here.");
    } finally { setRefreshing(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict) return;
    inFlight.current = true; setBusy(true); setError(""); setProgress("Recording story — please wait for confirmation.");
    if (!operation.current) operation.current = crypto.randomUUID();
    try {
      const response = await fetch(`${path}/stories`, { method: "POST", body: new URLSearchParams({ id: operation.current, storyteller, text }), signal: AbortSignal.timeout(30_000) });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.saved !== true) {
        if (response.status === 409) setConflict(true);
        throw new Error(result?.error || "Save was not confirmed. Your story remains here; check your connection or sign in again before retrying.");
      }
      window.location.assign(`${path}?storySaved=1#story-${operation.current}`);
    } catch (error) {
      setError(error instanceof Error && error.name === "Error" ? error.message : "Recording was interrupted. Keep this page open; retrying uses the same request to avoid duplicate stories.");
      setProgress("");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="card" aria-label="New story">
    <p>Different recollections can coexist. Recording a story does not establish it as verified history. Your recording identity is retained separately from storyteller credit.</p>
    <details><summary>Optional ideas for your story</summary><ul>{STORY_PROMPTS.map(prompt => <li key={prompt}>{prompt}</li>)}</ul><p>Use any, all, or none of these ideas. Write naturally in the single story field below.</p></details>
    <form onSubmit={save} aria-busy={busy}>
      <fieldset className="item-fields" disabled={!ready || busy}>
        <legend className="hint">Story and attribution</legend>
        <label htmlFor="storyteller">Storyteller</label>
        <select id="storyteller" name="storyteller" required value={storyteller} onChange={event => setStoryteller(event.target.value)} aria-describedby="storyteller-help">
          <option value="">Choose the person whose recollection this is</option>
          {choices.map(person => <option key={person.id} value={person.id}>{personLabel(person)}</option>)}
        </select>
        <p id="storyteller-help" className="hint">They do not need an app account. Identifying notes distinguish people with the same name.</p>
        <p><a href={`${peoplePath}/new`} target="_blank" rel="noopener">Add a person in a new tab</a>, then refresh choices without losing your story.</p>
        <button type="button" className="secondary" disabled={refreshing} onClick={refreshPeople}>{refreshing ? "Refreshing people…" : "Refresh storyteller choices"}</button>
        <label htmlFor="story-text">Story</label>
        <textarea id="story-text" name="text" rows={10} required maxLength={STORY_TEXT_LIMIT} value={text} onChange={event => setText(event.target.value)} aria-describedby="story-help" />
        <p id="story-help" className="hint">Up to 10,000 characters. Stories are optional for item completion. Do not add unnecessary private information.</p>
      </fieldset>
      <p role={progress ? "status" : undefined} aria-live="polite">{progress}</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      {conflict && <p><a href={path} target="_blank" rel="noopener">Open saved stories in a new tab</a>. Keep this tab to copy your attempted story; nothing is automatically replaced.</p>}
      <button type="submit" disabled={!ready || busy || conflict}>{busy ? "Recording…" : "Record story"}</button>
    </form>
    <p className="hint">Online connection required. Unsuccessful saves preserve your story only while this page stays open. Existing stories can be edited from the item, preserving earlier versions and attribution.</p>
    <noscript>Recording requires JavaScript so unsuccessful saves can preserve your attempted story.</noscript>
  </section>;
}

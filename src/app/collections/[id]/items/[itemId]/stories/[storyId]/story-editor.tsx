"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import ConflictReview from "@/app/components/conflict-review";
import { STORY_TEXT_LIMIT } from "@/shared/stories";
import PendingTextControls from "@/app/components/pending-text-controls";
import { usePendingText, type TextScope } from "@/client/use-pending-text";

export default function StoryEditor({ scope, storyId, path, initial }: { scope: TextScope; storyId: string; path: string; initial: { text: string; version: number } }) {
  const [text, setText] = useState(initial.text);
  // Props/refreshes cannot silently rebase this draft; only deliberate review can.
  const [version, setVersion] = useState(initial.version);
  const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false); const [error, setError] = useState(""); const [progress, setProgress] = useState("");
  const inFlight = useRef(false);
  const textField = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setReady(true); }, []);
  const pending = usePendingText(scope, "story", storyId);
  function stage(nextText = text, nextVersion = version) { void pending.stage({ kind: "story", storyId, text: nextText, version: nextVersion }); }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || conflict || pending.busy || !pending.authorized) return;
    inFlight.current = true; setBusy(true); setError(""); setProgress("Saving story changes — please wait for confirmation.");
    try {
      const local = await pending.prepare({ kind: "story", storyId, text, version });
      const response = await fetch(`${path}/details`, { method: "POST", body: new URLSearchParams({ accountId: scope.accountId, version: String(version), text }), signal: AbortSignal.timeout(30_000) });
      const result = await response.json().catch(() => null);
      pending.checkResponse(local, response.status, result?.error);
      if (!response.ok || result?.saved !== true) {
        if (response.status === 409) setConflict(true);
        throw new Error(result?.error || "Save was not confirmed. Your attempted story remains here; check your connection or sign in again before retrying.");
      }
      if (await pending.confirmed(local)) window.location.assign(`${path}?saved=1`);
      else setProgress("Server confirmed the story save. Local cleanup was not confirmed; check the saved story before discarding pending copies.");
    } catch (error) {
      setError(error instanceof Error && error.name === "Error" ? error.message : "Save was interrupted. Your attempted story and editing version remain here."); setProgress("");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="card" aria-labelledby="story-editor-heading">
    <h2 id="story-editor-heading">Edit this recollection</h2>
    <p>All collection members can edit. Earlier versions are retained, with storyteller, original recording and editing credit kept separate. You are editing version {version}.</p>
    <PendingTextControls pending={pending} disabled={busy} onResume={restored => {
      if (restored.kind !== "story" || restored.storyId !== storyId) return;
      setText(restored.text); setVersion(restored.version); setConflict(true); setError("");
      setProgress("Recovered pending local story changes. Compare with current saved content before deliberately revising and saving.");
    }} onDiscardCurrent={() => { setText(initial.text); setVersion(initial.version); setConflict(false); setError(""); setProgress(""); }} />
    {pending.authorized && <form onSubmit={save} aria-busy={busy}>
      <fieldset className="item-fields" disabled={!ready || busy || pending.busy}>
        <legend className="hint">Shared story text</legend>
        <label htmlFor="story-text">Story</label>
        <textarea ref={textField} id="story-text" name="text" rows={10} required maxLength={STORY_TEXT_LIMIT} value={text} onChange={event => { setText(event.target.value); stage(event.target.value); }} aria-describedby="story-edit-help" />
        <p id="story-edit-help" className="hint">Up to 10,000 characters. Conflicting recollections can remain separate stories; editing does not establish a verified account.</p>
      </fieldset>
      <p role={progress ? "status" : undefined} aria-live="polite">{progress}</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      {conflict && !pending.busy && <>
        <p><a href={path} target="_blank" rel="noopener">Open latest saved story in a new tab</a>. Your attempted text stays here.</p>
        <ConflictReview kind="story" url={`${path}/details`} attempted={[{ label: "Story", value: text }]} onReviewed={reviewed => { setVersion(reviewed); stage(text, reviewed); setConflict(false); setError(""); setProgress(`You reviewed version ${reviewed}. Revise your text, then save deliberately; your input is unchanged.`); textField.current?.focus(); }} />
      </>}
      <button type="submit" disabled={!ready || busy || pending.busy || conflict}>{busy ? "Saving…" : "Save story changes"}</button>
    </form>}
    <p className="hint">Online connection required for account checks, comparison and saving. Locally retained pending story changes can be resumed after interruption subject to browser limits. Recovery retains the original editing version and requires deliberate comparison; it cannot recreate a missing story.</p>
    <noscript>Editing requires JavaScript so unsuccessful saves can preserve your attempted story.</noscript>
  </section>;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccountScope } from "@/client/use-account-scope";
import { discardTextDraft, textDrafts, type TextDraft } from "@/client/pending-text";

function destination(draft: TextDraft) {
  const item = `/collections/${encodeURIComponent(draft.collectionId)}/items/${encodeURIComponent(draft.itemId)}`;
  return draft.input.kind === "item" ? item : draft.input.kind === "new-story" ? `${item}/stories/new` : `${item}/stories/${encodeURIComponent(draft.input.storyId)}`;
}
export default function PendingText({ accountId }: { accountId: string }) {
  const identity = useAccountScope(accountId);
  const [drafts, setDrafts] = useState<TextDraft[]>([]);
  const [selected, setSelected] = useState<TextDraft | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const load = useCallback(async (version: number) => {
    const rows = await textDrafts(accountId, null, () => identity.assertCurrent(version));
    identity.assertCurrent(version); setDrafts(rows);
  }, [accountId, identity.assertCurrent]);
  useEffect(() => {
    if (!identity.authorized) { setDrafts([]); setSelected(null); return; }
    const version = identity.current();
    void load(version).catch(() => {
      try { identity.assertCurrent(version); setMessage("Local text could not be read. Enable browser storage and retry; keep separate copies before clearing site data."); } catch { /* Hide superseded results. */ }
    });
  }, [identity.authorized, identity.current, identity.assertCurrent, load]);
  async function act(draft: TextDraft, discard: boolean) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setMessage("");
    try {
      const version = await identity.verify();
      if (discard) {
        const removed = await discardTextDraft(draft, () => identity.assertCurrent(version));
        identity.assertCurrent(version);
        setSelected(null);
        setMessage(removed ? "Selected local copy discarded. Saved records and unrelated pending text are unchanged." : "A newer local copy exists; nothing was discarded. Review the refreshed list.");
        await load(version);
      } else {
        const rows = await textDrafts(accountId, null, () => identity.assertCurrent(version));
        identity.assertCurrent(version);
        const current = rows.find(row => row.id === draft.id && row.revision === draft.revision && row.collectionId === draft.collectionId);
        if (!current) { setMessage("This local copy changed or was discarded. Review the refreshed list."); setDrafts(rows); return; }
        setSelected(current);
      }
    } catch {
      setMessage("Action not confirmed. Check the original account and browser storage, then retry. No saved content is changed here.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="card pending-text" aria-label="All pending text on this device">
    {identity.message && <p role="alert">{identity.message}</p>}
    {!identity.authorized ? <button type="button" disabled={busy} onClick={() => void identity.verify().catch(() => {})}>Check account and pending text</button> : <>
      {message && <p aria-live="polite">{message}</p>}
      {!drafts.length ? <p>No retained pending text for this account on this device.</p> : <ul>{drafts.map(draft => <li key={`${draft.collectionId}:${draft.id}`}>
        <p>{draft.input.kind === "item" ? "Item details" : draft.input.kind === "story" ? "Story changes" : "New story"} — collection {draft.collectionId} — <time dateTime={new Date(draft.updatedAt).toISOString()}>{new Date(draft.updatedAt).toISOString()}</time> — save not confirmed</p>
        <button type="button" disabled={busy} onClick={() => void act(draft, false)}>Inspect pending copy</button>{" "}
        <button type="button" className="secondary" disabled={busy} onClick={() => void act(draft, true)}>Discard pending copy</button>{" "}
        <a href={destination(draft)}>Open original editor</a>
      </li>)}</ul>}
      {selected && <section aria-label="Selected local pending text" className="edit-history">
        <h2>Pending local input — save not confirmed</h2>
        <p>Copy this text manually if needed. A missing original record cannot be recreated through this viewer.</p>
        {selected.input.kind === "item" ? <><h3>Name</h3><p className="story-text">{selected.input.name || "(blank)"}</p><h3>Short description</h3><p className="story-text">{selected.input.description || "(blank)"}</p><p>Original editing version: {selected.input.version}. Current keeper reference: {selected.input.currentKeeper || "Not recorded"}.</p></> : <><h3>Story</h3><p className="story-text">{selected.input.text || "(blank)"}</p>{selected.input.kind === "story" ? <p>Original editing version: {selected.input.version}.</p> : <p>Storyteller reference: {selected.input.storyteller || "Not selected"}. Original recording request: {selected.input.operation}.</p>}</>}
      </section>}
    </>}
    <p className="hint">Local storage is not a backup or encrypted protection from someone controlling this browser profile. Use separate profiles on shared devices. Browser eviction, private browsing, clearing site data or losing a device can remove pending text. No background sync or full offline editing is promised.</p>
  </section>;
}

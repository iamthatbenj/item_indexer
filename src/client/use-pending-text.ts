"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccountScope } from "./use-account-scope";
import { discardTextDraft, retainTextDraft, textDrafts, type TextDraft, type TextInput } from "./pending-text";

export type TextScope = { accountId: string; collectionId: string; itemId: string };
export type TextSave = { version: number; draft: TextDraft | null; source: TextDraft | null };
const storageFailure = "This browser could not retain pending text. Copy your input before leaving or reloading; enable/free browser storage or discard unneeded drafts. Local copies are not backups or server saves.";

export function usePendingText({ accountId, collectionId, itemId }: TextScope, kind: TextInput["kind"], storyId = "") {
  const identity = useAccountScope(accountId);
  const [drafts, setDrafts] = useState<TextDraft[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const workingId = useRef("");
  const last = useRef<TextDraft | null>(null);
  const latestRevision = useRef("");
  const source = useRef<TextDraft | null>(null);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const reads = useRef(0);
  const matches = useCallback((draft: TextDraft) => draft.itemId === itemId && draft.input.kind === kind && (draft.input.kind !== "story" || draft.input.storyId === storyId), [itemId, kind, storyId]);

  const refresh = useCallback(async (version: number) => {
    const read = ++reads.current;
    const records = await textDrafts(accountId, collectionId, () => identity.assertCurrent(version));
    identity.assertCurrent(version);
    if (read === reads.current) setDrafts(records.filter(matches));
  }, [accountId, collectionId, identity.assertCurrent, matches]);

  const stage = useCallback((input: TextInput) => {
    let version: number;
    try { version = identity.current(); }
    catch { return Promise.resolve<TextDraft | null>(null); }
    if (!workingId.current) workingId.current = crypto.randomUUID();
    const draft: TextDraft = { id: workingId.current, revision: crypto.randomUUID(), accountId, collectionId, itemId, updatedAt: Date.now(), input };
    latestRevision.current = draft.revision;
    setNotice("Retaining the latest input on this device — save not confirmed. Keep this page open or copy your input until local retention completes.");
    const write = writes.current.catch(() => {}).then(async () => {
      try {
        identity.assertCurrent(version);
        await retainTextDraft(draft, () => identity.assertCurrent(version));
        identity.assertCurrent(version);
        reads.current++;
        last.current = draft;
        setDrafts(records => [draft, ...records.filter(record => record.id !== draft.id)]);
        if (latestRevision.current === draft.revision) setNotice("Pending text retained on this device — save not confirmed. Resume or discard deliberately after interruption.");
        return draft;
      } catch {
        try { identity.assertCurrent(version); if (latestRevision.current === draft.revision) setNotice(storageFailure); } catch { /* Superseded results cannot change local UI. */ }
        return null;
      }
    });
    writes.current = write;
    return write;
  }, [accountId, collectionId, itemId, identity.current, identity.assertCurrent]);

  useEffect(() => {
    if (!identity.authorized) { reads.current++; setDrafts([]); return; }
    const version = identity.current();
    void refresh(version).catch(() => {
      try { identity.assertCurrent(version); setNotice(storageFailure); } catch { /* Hidden until freshly verified. */ }
    });
  }, [identity.authorized, identity.current, identity.assertCurrent, refresh]);

  async function restore(draft: TextDraft) {
    setBusy(true);
    try {
      await writes.current;
      const version = await identity.verify();
      const records = await textDrafts(accountId, collectionId, () => identity.assertCurrent(version));
      identity.assertCurrent(version);
      const current = records.find(record => record.id === draft.id && record.revision === draft.revision && matches(record));
      if (!current) throw new Error("This pending copy changed or was discarded in another tab. Check pending text again before resuming.");
      // Each editor gets its own working copy. Two tabs resuming one draft must
      // not overwrite each other's subsequent local text.
      workingId.current = crypto.randomUUID(); last.current = null; source.current = current;
      await stage(current.input);
      identity.assertCurrent(version);
      setNotice("Recovered pending local input — not a server save. Existing records require comparison with current saved content before saving.");
      return current.input;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : storageFailure);
      return null;
    } finally { setBusy(false); }
  }
  async function discard(draft: TextDraft) {
    setBusy(true);
    try {
      await writes.current;
      const version = await identity.verify();
      const removed = await discardTextDraft(draft, () => identity.assertCurrent(version));
      identity.assertCurrent(version);
      if (!removed) { await refresh(version); setNotice("A newer local copy exists. Nothing was discarded; review the refreshed list."); return false; }
      const active = draft.id === workingId.current;
      // Discarding the working copy ends its lineage; a later independent
      // save must not clear the retained original that was only resumed.
      if (active) { workingId.current = ""; last.current = null; latestRevision.current = ""; source.current = null; }
      if (source.current?.id === draft.id) source.current = null;
      await refresh(version);
      identity.assertCurrent(version);
      setNotice("Pending text discarded from this device only. Saved records and other local drafts are unchanged.");
      return active;
    } catch {
      setNotice("Local discard was not confirmed. Check the original account and browser storage, then retry.");
      return false;
    } finally { setBusy(false); }
  }
  async function prepare(input: TextInput): Promise<TextSave> {
    const version = await identity.verify();
    const draft = await stage(input);
    identity.assertCurrent(version);
    return { version, draft: draft ?? last.current, source: source.current };
  }
  function checkResponse(save: TextSave, status: number, error: unknown) {
    identity.assertCurrent(save.version);
    if (status === 401 || typeof error === "string" && error.includes("signed-in account changed")) {
      identity.invalidate(true);
      throw new Error("Sign in again as the original contributor before saving pending text.");
    }
  }
  async function confirmed(save: TextSave) {
    identity.assertCurrent(save.version);
    const version = await identity.verify();
    try {
      for (const draft of [save.draft, save.source]) {
        if (draft && !await discardTextDraft(draft, () => identity.assertCurrent(version))) throw new Error("A newer local copy exists.");
      }
      identity.assertCurrent(version);
      last.current = null; source.current = null; workingId.current = ""; latestRevision.current = "";
      await refresh(version);
      identity.assertCurrent(version);
      setNotice("Server confirmed the save. Matching local pending copies cleared.");
      return true;
    } catch {
      identity.assertCurrent(version);
      setNotice("Server confirmed the save, but matching local cleanup was not confirmed. Check the saved record; retained copies must not be mistaken for unsaved server work.");
      return false;
    }
  }
  return { authorized: identity.authorized, identityMessage: identity.message, verify: identity.verify, assertCurrent: identity.assertCurrent, drafts, notice, busy, stage, restore, discard, prepare, checkResponse, confirmed };
}

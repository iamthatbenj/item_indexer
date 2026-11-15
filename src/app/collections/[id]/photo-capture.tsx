"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { discardPhoto, pendingPhotos, retainPhoto, type PendingPhoto } from "@/client/pending-photos";

const localFailure = "This browser could not retain the pending photo. Keep your original, free browser storage or discard unneeded pending copies, then retry. No new upload was started. Local limits: 10 photos / 80 MiB per collection.";

export default function PhotoCapture({ accountId, collectionId, itemId, itemName = "", onSaved }: { accountId: string; collectionId: string; itemId?: string; itemName?: string; onSaved?: () => void }) {
  const [active, setActive] = useState<PendingPhoto | null>(null);
  const [queue, setQueue] = useState<PendingPhoto[]>([]);
  const [preview, setPreview] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [verified, setVerified] = useState(false);
  const [retry, setRetry] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const identityChannel = useRef<BroadcastChannel | null>(null);

  function assertCurrent(version: number) {
    if (version !== generation.current) throw new Error("Sign in as the original contributor and check pending photos again. Account verification was interrupted.");
  }
  function invalidate() {
    generation.current++;
    setVerified(false); setActive(null); setQueue([]);
  }
  async function identity(version: number) {
    assertCurrent(version);
    const response = await fetch("/auth/account", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const result = await response.json();
    // A response describes the session when it was requested, not necessarily
    // the session now. Never broadcast or authorize a superseded check.
    assertCurrent(version);
    identityChannel.current?.postMessage(response.ok ? result?.id : null);
    if (!response.ok || result?.id !== accountId) {
      setVerified(false); setActive(null); setQueue([]);
      throw new Error("Sign in as the original contributor to view or resume these pending photos. The target collection has not changed.");
    }
  }
  async function loadQueue(version: number) {
    assertCurrent(version);
    const rows = await pendingPhotos(accountId, collectionId);
    assertCurrent(version);
    setQueue(itemId ? rows.filter(row => row.itemId === itemId) : rows);
  }
  useEffect(() => {
    setReady(true);
    const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("family-belongings-photo-identity") : null;
    identityChannel.current = channel;
    if (channel) channel.onmessage = event => {
      // Messages may only hide, never authorize local reads or server work.
      if (event.data !== accountId) {
        invalidate();
        setError("The signed-in account changed. Sign in as the original contributor to view or resume pending photos.");
      }
    };
    async function check() {
      // Focus invalidates even an in-flight operation. It must not be able to
      // reauthorize the UI with a response captured before this focus change.
      const version = ++generation.current;
      setVerified(false);
      if (inFlight.current) return;
      try {
        await identity(version);
        await loadQueue(version);
        assertCurrent(version);
        setVerified(true);
      } catch {
        if (version === generation.current) setError("Reconnect and sign in as the original contributor to view pending photos. If local storage is unavailable, keep your originals and enable browser storage.");
      }
    }
    function visibility() {
      if (document.visibilityState === "hidden") { generation.current++; setVerified(false); }
      else void check();
    }
    void check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      generation.current++;
      identityChannel.current = null; channel?.close();
      window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", visibility);
    };
    // The parent keys this component by account/collection/item. These checks
    // deliberately run on focus, not on every progress/state update.
  }, [accountId, collectionId, itemId]);
  useEffect(() => {
    if (!active || !verified) { setPreview(""); return; }
    const url = URL.createObjectURL(active.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [active, verified]);

  async function select(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file || inFlight.current) return;
    if (file.size < 1 || file.size > 20 * 1024 * 1024) { setError("Choose a non-empty photo no larger than 20 MiB."); return; }
    const photo: PendingPhoto = { id: crypto.randomUUID(), accountId, collectionId, itemId: itemId ?? null, itemName, file, createdAt: Date.now() };
    const version = ++generation.current;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await identity(version);
      setVerified(true); setActive(photo); setRetry(false);
      setProgress("Selected on this device — not saved yet. Retaining a local pending copy…");
      await retainPhoto(photo, () => assertCurrent(version));
      await loadQueue(version);
      assertCurrent(version);
      setProgress("Pending on this device — not saved yet. You can reload and explicitly resume while signed in to this account.");
    } catch (error) {
      if (version !== generation.current) return;
      setError(error instanceof Error && error.message.startsWith("Sign in") ? error.message : localFailure);
      setProgress("Save not confirmed. Keep your original photo.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function reconnect() {
    if (inFlight.current) return;
    const version = ++generation.current;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await identity(version); await loadQueue(version); assertCurrent(version);
      setVerified(true);
      setProgress("Account and local pending photos checked. No upload was started; choose Resume and save deliberately.");
    } catch {
      if (version !== generation.current) return;
      setVerified(false);
      setError("Reconnect and sign in as the original contributor, and enable browser storage before checking pending photos again.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function resume(photo: PendingPhoto) {
    if (inFlight.current) return;
    const version = ++generation.current;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await identity(version); assertCurrent(version);
      setVerified(true); setActive(photo); setRetry(true);
      setProgress("Pending photo loaded — save not confirmed. Retry checks the original operation before uploading; it does not choose a new target.");
    } catch (error) {
      if (version === generation.current) setError(error instanceof Error ? error.message : "Reconnect and sign in before resuming.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function discard(photo: PendingPhoto) {
    if (inFlight.current) return;
    const version = ++generation.current;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await identity(version);
      await discardPhoto(photo, () => assertCurrent(version));
      assertCurrent(version);
      if (active?.id === photo.id) setActive(null);
      await loadQueue(version); assertCurrent(version);
      setProgress("Pending copy discarded from this device only. Any already-saved item or photo is unchanged; check the saved belongings.");
    } catch {
      if (version === generation.current) setError("Could not discard the local copy. Reconnect, sign in as the original contributor and retry; browser storage must be available.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  async function call(path: string, values: Record<string, string>, version: number) {
    assertCurrent(version);
    const response = await fetch(path, { method: "POST", body: new URLSearchParams({ ...values, accountId }), signal: AbortSignal.timeout(70_000) });
    const result = await response.json().catch(() => null);
    assertCurrent(version);
    if (response.status === 401 || result?.error?.includes("signed-in account changed")) { setVerified(false); setActive(null); setQueue([]); }
    if (!response.ok || !result) throw new Error(result?.error || "The photo was not confirmed saved. Check your connection or sign in again, then retry.");
    return result as { uploadUrl?: string; itemUrl?: string };
  }
  async function saved(photo: PendingPhoto, itemUrl: string, version: number) {
    // Accept only the fixed destination, not an arbitrary/redirected response.
    const expected = `/collections/${photo.collectionId}/items/${photo.itemId ?? photo.id}`;
    if (itemUrl !== expected) throw new Error("Save confirmation was invalid. Retry to check the original operation.");
    await identity(version);
    try { await discardPhoto(photo, () => assertCurrent(version)); }
    catch {
      assertCurrent(version);
      setProgress("Server confirmed this photo saved. The local pending copy could not be cleared; retry checks the same operation without creating a duplicate.");
      setError("Local cleanup failed. Keep the original target and retry, or check the saved belongings before discarding the pending copy.");
      return;
    }
    assertCurrent(version);
    if (!onSaved || photo.itemId !== itemId) { window.location.assign(itemUrl); return; }
    setActive(null); await loadQueue(version); assertCurrent(version);
    setProgress("Photo request completed. The current views will refresh above.");
    onSaved();
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !active) return;
    const photo = active;
    const version = ++generation.current;
    inFlight.current = true; setBusy(true); setError(""); setRetry(true);
    try {
      await identity(version); assertCurrent(version); setVerified(true);
      // A storage failure must not start an upload with an operation that would
      // be lost on reload. Stable ID + file + target commit together first.
      try { await retainPhoto(photo, () => assertCurrent(version)); } catch { assertCurrent(version); throw new Error(localFailure); }
      await loadQueue(version); assertCurrent(version);
      setProgress("Preparing a private upload — not saved yet.");
      const endpoint = photo.itemId ? `/collections/${photo.collectionId}/items/${photo.itemId}/photo-uploads` : `/collections/${photo.collectionId}/photo-uploads`;
      const upload = await call(endpoint, { id: photo.id, size: String(photo.file.size) }, version);
      assertCurrent(version);
      if (upload.itemUrl) { await saved(photo, upload.itemUrl, version); return; }
      if (!upload.uploadUrl) throw new Error("Private upload unavailable. Please retry.");
      setProgress("Uploading photo — not saved yet.");
      const response = await fetch(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: photo.file, signal: AbortSignal.timeout(120_000) });
      assertCurrent(version);
      if (!response.ok) throw new Error("The upload did not complete. Check your connection and retry; this photo is not saved yet.");
      setProgress("Processing and saving your photo — please wait for confirmation.");
      const result = await call(`${endpoint}/${photo.id}/finish`, {}, version);
      assertCurrent(version);
      if (!result.itemUrl) throw new Error("Save was not confirmed. Retry to check without creating a duplicate.");
      await saved(photo, result.itemUrl, version);
    } catch (error) {
      if (version !== generation.current) return;
      setError(error instanceof Error && error.name !== "TimeoutError" && error.name !== "TypeError" ? error.message : "The save was interrupted. Reconnect and retry to check without creating a duplicate.");
      setProgress("Save not confirmed. Pending copies retained by this browser can be resumed after reload. Keep your original separately.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="card" aria-labelledby="photo-heading">
    <h2 id="photo-heading">{itemId ? "Add another photo" : "Capture a belonging"}</h2>
    <p id="photo-retention">We retain high-quality optimized photos, not necessarily camera originals: at most 3,200 pixels on the long edge, without enlarging smaller photos. Hidden location, device, and timestamp metadata is removed. Keep your original separately if you need it.</p>
    <p id="photo-formats" className="hint">One JPEG, PNG, or WebP, up to 20 MiB and 60 megapixels. HEIC/HEIF is not supported: export a JPEG or use your camera’s Most Compatible setting. Transparent images are placed on white.</p>
    <form onSubmit={save} aria-describedby="photo-retention photo-formats" aria-busy={busy}>
      <fieldset disabled={busy || !ready} className="photo-picker">
        <legend>Choose one photo</legend>
        <label htmlFor="camera-photo">Take a photo</label>
        <input id="camera-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={select} />
        <label htmlFor="library-photo">Choose from your photo library</label>
        <input id="library-photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={select} />
      </fieldset>
      {active && verified && <>
        <p className="selected-photo">Selected: {active.file.name}</p>
        <p className="hint">Target: {active.itemId ? `Another photo of ${active.itemName || "Untitled belonging"}` : "New draft item"} in this collection.</p>
        {preview && <img className="photo-preview" src={preview} alt="Selected photo preview; save not confirmed" />}
      </>}
      <p role={progress ? "status" : undefined} aria-live="polite">{progress}</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      <button type="submit" disabled={busy || !ready || !active || !verified}>{busy ? "Saving…" : retry || error ? "Retry save" : active?.itemId ? "Add photo" : "Save photo draft"}</button>
    </form>
    <section aria-label="Pending photos on this device">
      <h3>Pending photos on this device</h3>
      <p className="hint">Pending means save not confirmed, not necessarily unsaved. Retry checks the same operation first. Discard removes only the local copy, not a server save. Saved items appear in the collection’s belongings.</p>
      {!verified ? <><p>Reconnect and <a href="/sign-in" target="_blank" rel="noopener noreferrer">sign in as the original contributor in a new tab</a> to view pending photos.</p><button type="button" disabled={busy || !ready} onClick={() => void reconnect()}>Check account and pending photos</button></> : queue.length === 0 ? <p>No retained pending photos for this {itemId ? "item" : "collection"} on this device.</p> : <ul className="pending-photos">{queue.map(photo => <li key={photo.id}>
        <p>{photo.file.name} — {photo.itemId ? `Another photo of ${photo.itemName || "Untitled belonging"}` : "New draft item"} — save not confirmed</p>
        <button type="button" disabled={busy} onClick={() => void resume(photo)}>Resume pending photo {photo.file.name}</button>{" "}
        <button type="button" className="secondary" disabled={busy} onClick={() => void discard(photo)}>Discard pending photo {photo.file.name}</button>
      </li>)}</ul>}
    </section>
    <p className="hint">Online connection and the original signed-in account are required to resume. Local photos may contain original hidden metadata until discarded or saved. Browser storage is not a backup: private browsing, storage pressure, browser eviction, clearing site data or device loss can remove pending copies. No background sync, full offline capture or offline browsing is promised. On shared devices, use a separate browser profile and discard unneeded copies.</p>
    <noscript>Photo upload requires JavaScript. Enable it to select and save a photo.</noscript>
  </section>;
}

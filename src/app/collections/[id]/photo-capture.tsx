"use client";

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";

export default function PhotoCapture({ collectionId, itemId, onSaved }: { collectionId: string; itemId?: string; onSaved?: () => void }) {
  function saved(itemUrl: string) {
    if (!onSaved) { window.location.assign(itemUrl); return; }
    setFile(null);
    operation.current = "";
    setProgress("Photo request completed. The current views will refresh above.");
    onSaved();
  }
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const operation = useRef("");
  const inFlight = useRef(false);
  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function select(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0];
    if (!next) return;
    // Allow selecting the same file again to start a fresh intent after expiry.
    event.currentTarget.value = "";
    setFile(next);
    operation.current = crypto.randomUUID();
    setProgress("Selected on this device — not saved yet.");
    setError("");
  }
  async function call(path: string, values: Record<string, string>) {
    const response = await fetch(path, { method: "POST", body: new URLSearchParams(values), signal: AbortSignal.timeout(70_000) });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.error || "The photo was not confirmed saved. Check your connection or sign in again, then retry.");
    return result as { uploadUrl?: string; itemUrl?: string };
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !file) return;
    if (file.size < 1 || file.size > 20 * 1024 * 1024) { setError("Choose a non-empty photo no larger than 20 MiB."); return; }
    inFlight.current = true;
    setBusy(true); setError("");
    try {
      setProgress("Preparing a private upload — not saved yet.");
      const endpoint = itemId ? `/collections/${collectionId}/items/${itemId}/photo-uploads` : `/collections/${collectionId}/photo-uploads`;
      const upload = await call(endpoint, { id: operation.current, size: String(file.size) });
      if (upload.itemUrl) { saved(upload.itemUrl); return; }
      if (!upload.uploadUrl) throw new Error("Private upload unavailable. Please retry.");
      setProgress("Uploading photo — not saved yet.");
      const response = await fetch(upload.uploadUrl, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file, signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error("The upload did not complete. Check your connection and retry; this photo is not saved yet.");
      setProgress("Processing and saving your photo — please wait for confirmation.");
      const result = await call(`${endpoint}/${operation.current}/finish`, {});
      if (!result.itemUrl) throw new Error("Save was not confirmed. Retry to check without creating a duplicate.");
      saved(result.itemUrl);
    } catch (error) {
      setError(error instanceof Error && error.name !== "TimeoutError" && error.name !== "TypeError" ? error.message : "The save was interrupted. Keep this page open and retry to check without creating a duplicate.");
      setProgress("Save not confirmed. Your selected file remains on this page for retry.");
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
      {file && <p className="selected-photo">Selected: {file.name}</p>}
      {preview && <img className="photo-preview" src={preview} alt="Selected photo preview; not yet saved" />}
      <p role={progress ? "status" : undefined} aria-live="polite">{progress}</p>
      {error && <p role="alert" className="notice error">{error}</p>}
      <button type="submit" disabled={busy || !ready || !file}>{busy ? "Saving…" : error ? "Retry save" : itemId ? "Add photo" : "Save photo draft"}</button>
    </form>
    <p className="hint">Online connection required. Keep this page open until saved; selected photos are not recovered after closing or reloading it yet.</p>
    <noscript>Photo upload requires JavaScript. Enable it to select and save a photo.</noscript>
  </section>;
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import PhotoCapture from "../../photo-capture";

type Photo = { id: string; width: number; height: number };
export default function ItemPhotos({ collectionId, itemId, name, photos }: { collectionId: string; itemId: string; name: string; photos: Photo[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refreshing, startTransition] = useTransition();
  const [error, setError] = useState("");
  const refresh = () => startTransition(() => router.refresh());
  const path = `/collections/${collectionId}/items/${itemId}`;
  async function remove(id: string) {
    if (busy || refreshing) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`${path}/photos/${id}`, { method: "POST", body: new URLSearchParams({ confirm: "yes" }), signal: AbortSignal.timeout(20_000) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.removed) throw new Error(result?.error || "Removal was not confirmed. Keep this page open and retry to check the current views.");
      refresh();
    } catch (error) {
      setError(error instanceof Error && error.name !== "TimeoutError" && error.name !== "TypeError" ? error.message : "Removal was interrupted. Keep this page open and retry to check without removing another view.");
    } finally { setBusy(false); }
  }
  return <section aria-labelledby="item-photos-heading">
    <h2 id="item-photos-heading">Item photos</h2>
    <p id="photo-removal-note" className="hint">Keep at least one photo. Removing a view hides it here; its retained files remain for recovery. Downloaded copies and briefly valid private links cannot be recalled.</p>
    {error && <p role="alert" className="notice error">{error}</p>}
    <div className="item-photos" aria-busy={busy || refreshing}>
      {photos.map((photo, index) => <figure key={photo.id} className="card item-view" data-photo-id={photo.id}>
        <img className="item-photo" src={`${path}/photos/${photo.id}`} width={photo.width} height={photo.height} alt={`Retained photo ${index + 1} of ${name || "this belonging"}`} />
        <figcaption>
          <p>Photo {index + 1} of {photos.length}</p>
          <p><a href={`${path}/photos/${photo.id}`}>Open retained photo {index + 1} at full size</a></p>
          <button type="button" aria-describedby="photo-removal-note" disabled={busy || refreshing || photos.length <= 1} onClick={() => void remove(photo.id)}>Remove photo {index + 1}</button>
        </figcaption>
      </figure>)}
    </div>
    <PhotoCapture collectionId={collectionId} itemId={itemId} onSaved={refresh} />
  </section>;
}

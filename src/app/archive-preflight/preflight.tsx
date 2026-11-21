"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ARCHIVE_UPLOAD_LIMIT, type ArchivePreview } from "@/archive-preview";

type Notice = { outcome: "rejected" | "failed"; message: string };
class CheckError extends Error { constructor(readonly notice: Notice) { super(notice.message); } }

export function Preflight({ accountId }: { accountId: string }) {
  const [file, setFile] = useState<File>();
  const [phase, setPhase] = useState("");
  const [notice, setNotice] = useState<Notice>();
  const [preview, setPreview] = useState<ArchivePreview>();
  const [restoreMode, setRestoreMode] = useState(false);
  const [review, setReview] = useState<{ ticket: string; proof: string }>();
  const [restored, setRestored] = useState<string>();
  const [restoreNotice, setRestoreNotice] = useState("");
  const running = useRef<AbortController | null>(null);
  const [blocked, setBlocked] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("family-belongings-photo-identity");
    const invalidate = () => {
      running.current?.abort(); running.current = null;
      setFile(undefined); if (input.current) input.current.value = "";
      setPreview(undefined); setReview(undefined); setRestored(undefined); setRestoreNotice(""); setPhase(""); setBlocked(true);
      setNotice({ outcome: "failed", message: "The signed-in account may have changed. Reload and sign in as an approved founder." });
    };
    if (channel) channel.onmessage = event => { if (event.data !== accountId) invalidate(); };
    // Drop an existing preview on leaving the tab; don't abort a private upload just because a file picker changed focus.
    const hide = () => { if (document.hidden) { setPreview(undefined); setReview(undefined); setRestored(undefined); } };
    document.addEventListener("visibilitychange", hide);
    return () => { running.current?.abort(); running.current = null; channel?.close(); document.removeEventListener("visibilitychange", hide); };
  }, [accountId]);

  async function check(event: FormEvent) {
    event.preventDefault();
    if (!file || running.current || blocked) return;
    setPreview(undefined); setReview(undefined); setRestored(undefined); setRestoreNotice(""); setNotice(undefined);
    if (file.size < 1 || file.size > ARCHIVE_UPLOAD_LIMIT) {
      setNotice({ outcome: "rejected", message: "Choose a nonempty ZIP no larger than 256 MiB." }); return;
    }
    const controller = new AbortController(); running.current = controller;
    const active = () => { controller.signal.throwIfAborted(); };
    const call = async (fields: Record<string, string>, timeout: number) => {
      const response = await fetch("/archive-preflight/check", { method: "POST", body: new URLSearchParams({ ...fields, accountId }), cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]) });
      const body = await response.json().catch(() => null); active();
      if (!response.ok || !body) throw new CheckError({ outcome: body?.outcome === "rejected" ? "rejected" : "failed", message: typeof body?.error === "string" ? body.error : "The check did not complete. Try uploading the ZIP again." });
      return body;
    };
    try {
      setPhase("Preparing private upload…");
      const { uploadUrl, ticket } = await call({ action: "prepare", size: String(file.size) }, 15_000);
      if (typeof uploadUrl !== "string" || typeof ticket !== "string") throw new Error();
      setPhase("Uploading to private storage…");
      const upload = await fetch(uploadUrl, { method: "PUT", body: file, headers: { "Content-Type": "application/octet-stream" }, credentials: "omit", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(540_000)]) });
      active();
      if (!upload.ok) throw new CheckError({ outcome: "failed", message: "The private upload did not complete. Check your connection and try again." });
      setPhase("Validating the archive and its files…");
      const output = await call({ action: restoreMode ? "review" : "validate", ticket }, 62_000);
      if (output.outcome !== "supported" || !output.preview || restoreMode && typeof output.review !== "string") throw new Error();
      if (!document.hidden) {
        setPreview(output.preview);
        if (restoreMode) setReview({ ticket, proof: output.review });
      }
      else setNotice({ outcome: "failed", message: "The tab was hidden when the check finished. Check the ZIP again to see a preview." });
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof CheckError ? error.notice : { outcome: "failed", message: "The check was interrupted or timed out. Try uploading the ZIP again." });
    } finally {
      if (running.current === controller) { running.current = null; setPhase(""); }
    }
  }
  async function restore() {
    if (!review || running.current || blocked) return;
    const controller = new AbortController(); running.current = controller;
    setPhase("Revalidating the ZIP and restoring the new private collection…"); setRestoreNotice("");
    try {
      const response = await fetch("/archive-preflight/check", { method: "POST", body: new URLSearchParams({ action: "restore", accountId, ticket: review.ticket, review: review.proof }), cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(62_000)]) });
      const output = await response.json().catch(() => null);
      controller.signal.throwIfAborted();
      if (!response.ok || output?.outcome !== "restored" || typeof output.collectionUrl !== "string" || !/^\/collections\/[0-9a-f-]{36}$/.test(output.collectionUrl)) {
        setRestoreNotice(typeof output?.error === "string" ? output.error : "The restore was not confirmed. Retry with the same ZIP to check the result.");
        return;
      }
      setReview(undefined); setPreview(undefined); setFile(undefined);
      if (input.current) input.current.value = "";
      if (!document.hidden) setRestored(output.collectionUrl);
    } catch {
      if (!controller.signal.aborted) setRestoreNotice("The restore was not confirmed. Retry with the same ZIP to check the result without creating a duplicate.");
    } finally {
      if (running.current === controller) { running.current = null; setPhase(""); }
    }
  }
  function cancel() {
    running.current?.abort(); running.current = null; setPhase("");
    setNotice({ outcome: "failed", message: "Check stopped. Try uploading the ZIP again when ready." });
  }
  return <>
    <form className="card" onSubmit={check}>
      <label htmlFor="archive-file">Portable archive ZIP</label>
      <p id="archive-file-help">Up to 256 MiB. Keep the original ZIP. Preview-only checks discard the uploaded copy; a restore review expires ten minutes after its upload was prepared.</p>
      <input ref={input} id="archive-file" type="file" accept=".zip,application/zip" aria-describedby="archive-file-help" disabled={!!phase || blocked} onChange={event => { setFile(event.target.files?.[0]); setPreview(undefined); setReview(undefined); setRestored(undefined); setRestoreNotice(""); setNotice(undefined); }} />
      <label><input type="checkbox" checked={restoreMode} disabled={!!phase || blocked} onChange={event => { setRestoreMode(event.target.checked); setPreview(undefined); setReview(undefined); setRestoreNotice(""); }} /> Review for restoration into a new private collection</label>
      <button disabled={!file || !!phase || blocked}>Upload and validate</button>
      {phase && !phase.startsWith("Revalidating") && <button type="button" className="secondary" onClick={cancel}>Stop check</button>}
      {phase && <p role="status">{phase}</p>}
    </form>
    {notice && <p className="notice" role="alert"><strong>{notice.outcome === "rejected" ? "Archive rejected. " : "Check not completed. "}</strong>{notice.message} No collection was created.</p>}
    {restoreNotice && <p className="notice" role="alert">{restoreNotice}</p>}
    {restored && <section className="card"><p role="status">Restored to a new private collection. No old access was reinstated.</p><p><a href={restored}>Open the restored collection</a> and send fresh invitations to anyone who should have access.</p></section>}
    {preview && <section className="card" aria-labelledby="preview-heading" style={{ overflowWrap: "anywhere" }}>
      <h2 id="preview-heading">Supported archive</h2>
      <p role="status">Validation passed for format {preview.version}. No collection was created.</p>
      <p>Source collection label: <strong>{preview.collection}</strong></p>
      <dl>{Object.entries({ Items: preview.items, People: preview.people, Stories: preview.stories, "Retained photos": preview.photos, "Removed photo records": preview.removedPhotos, "Edit history entries": preview.revisions, "Retained files (photos and thumbnails)": preview.files }).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
      {review && <><p>Restoring creates a new collection with you, the signed-in founder, as its only administrator and member. Historical credits are kept, but old accounts receive no access. Send fresh invitations after reviewing the restored collection.</p><button type="button" disabled={!!phase || blocked} onClick={restore}>Confirm restore as current administrator</button></>}
    </section>}
  </>;
}

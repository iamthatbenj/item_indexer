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
  const running = useRef<AbortController | null>(null);
  const [blocked, setBlocked] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("family-belongings-photo-identity");
    const invalidate = () => {
      running.current?.abort(); running.current = null;
      setFile(undefined); if (input.current) input.current.value = "";
      setPreview(undefined); setPhase(""); setBlocked(true);
      setNotice({ outcome: "failed", message: "The signed-in account may have changed. Reload and sign in as an approved founder." });
    };
    if (channel) channel.onmessage = event => { if (event.data !== accountId) invalidate(); };
    // Drop an existing preview on leaving the tab; don't abort a private upload just because a file picker changed focus.
    const hide = () => { if (document.hidden) setPreview(undefined); };
    document.addEventListener("visibilitychange", hide);
    return () => { running.current?.abort(); running.current = null; channel?.close(); document.removeEventListener("visibilitychange", hide); };
  }, [accountId]);

  async function check(event: FormEvent) {
    event.preventDefault();
    if (!file || running.current || blocked) return;
    setPreview(undefined); setNotice(undefined);
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
      const output = await call({ action: "validate", ticket }, 62_000);
      if (output.outcome !== "supported" || !output.preview) throw new Error();
      if (!document.hidden) setPreview(output.preview);
      else setNotice({ outcome: "failed", message: "The tab was hidden when the check finished. Check the ZIP again to see a preview." });
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof CheckError ? error.notice : { outcome: "failed", message: "The check was interrupted or timed out. Try uploading the ZIP again." });
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
      <p id="archive-file-help">Up to 256 MiB. Keep the original file; the app does not retain a usable copy for restoration.</p>
      <input ref={input} id="archive-file" type="file" accept=".zip,application/zip" aria-describedby="archive-file-help" disabled={!!phase || blocked} onChange={event => { setFile(event.target.files?.[0]); setPreview(undefined); setNotice(undefined); }} />
      <button disabled={!file || !!phase || blocked}>Upload and validate</button>
      {phase && <button type="button" className="secondary" onClick={cancel}>Stop check</button>}
      {phase && <p role="status">{phase}</p>}
    </form>
    {notice && <p className="notice" role="alert"><strong>{notice.outcome === "rejected" ? "Archive rejected. " : "Check not completed. "}</strong>{notice.message} No collection was created.</p>}
    {preview && <section className="card" aria-labelledby="preview-heading" style={{ overflowWrap: "anywhere" }}>
      <h2 id="preview-heading">Supported archive</h2>
      <p role="status">Validation passed for format {preview.version}. No collection was created.</p>
      <p>Source collection label: <strong>{preview.collection}</strong></p>
      <dl>{Object.entries({ Items: preview.items, People: preview.people, Stories: preview.stories, "Retained photos": preview.photos, "Removed photo records": preview.removedPhotos, "Edit history entries": preview.revisions, "Retained files (photos and thumbnails)": preview.files }).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>
    </section>}
  </>;
}

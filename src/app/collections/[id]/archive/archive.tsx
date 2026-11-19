"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ArchiveStatus as InventoryStatus } from "@/shared/archive-exports";

function valid(job: InventoryStatus) {
  return job && typeof job.id === "string" && ["processing", "interrupted", "ready", "failed", "expired", "deleting"].includes(job.status)
    && (job.status !== "ready" || Number.isSafeInteger(job.bytes) && job.bytes! > 0);
}
export default function ArchiveRequests({ accountId, collectionId, initialJobs }: { accountId: string; collectionId: string; initialJobs: InventoryStatus[] }) {
  const kind = "archive"; const title = "Archive";
  const path = `/collections/${collectionId}/${kind}/requests`;
  const [jobs, setJobs] = useState(initialJobs);
  const [busy, setBusy] = useState(false);
  const [available, setAvailable] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const working = useRef(false); const mounted = useRef(false); const reads = useRef(0); const operation = useRef("");
  useEffect(() => { mounted.current = true; setReady(true); return () => { mounted.current = false; reads.current++; }; }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    const read = ++reads.current;
    let response: Response;
    try { response = await fetch(path, { cache: "no-store", signal: signal ?? AbortSignal.timeout(15_000) }); }
    catch { throw new Error("archive status was not confirmed. Check access and connection, then check again later."); }
    const result = await response.json().catch(() => null);
    if (!mounted.current || read !== reads.current) return;
    if (response.status === 401 || response.status === 404) { setAvailable(false); setJobs([]); }
    if (!response.ok || !Array.isArray(result?.jobs) || !result.jobs.every(valid)) throw new Error(result?.error || "archive status was not confirmed. Check access and connection, then retry.");
    setJobs(result.jobs); setAvailable(true);
  }, [path]);
  const active = jobs.filter(job => job.status === "processing").map(job => job.id).sort().join(",");
  useEffect(() => {
    if (!active || !available) return;
    let cancelled = false;
    const controller = new AbortController();
    const deadline = Date.now() + 30_000;
    // Do not restart this wall-clock budget on progress, and include time spent
    // awaiting a status response rather than only counting timer intervals.
    void (async () => {
      for (let check = 0; check < 20 && Date.now() < deadline; check++) {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, Math.min(1500, Math.max(1, deadline - Date.now())));
          controller.signal.addEventListener("abort", done, { once: true });
        });
        if (cancelled) return;
        if (Date.now() >= deadline) break;
        try { await load(AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(15_000, Math.max(1, deadline - Date.now())))])); } catch (error) {
          if (Date.now() >= deadline) break;
          if (!cancelled && mounted.current) setError(error instanceof Error ? error.message : "Check generation status again later.");
          return;
        }
      }
      if (!cancelled && mounted.current) setNotice("Automatic status checking paused after 30 seconds. Generation does not need this page open. Check again later; an interrupted attempt becomes retryable after its 90-second lease.");
    })();
    return () => { cancelled = true; controller.abort(); };
  }, [active, available, load]);
  async function action(action: "create" | "retry" | "discard", id?: string) {
    if (working.current || !available) return;
    working.current = true; setBusy(true); setError(""); setNotice(""); reads.current++;
    if (action === "create" && !operation.current) operation.current = crypto.randomUUID();
    const requestId = id || operation.current;
    try {
      const response = await fetch(path, { method: "POST", body: new URLSearchParams({ action, id: requestId, accountId }), signal: AbortSignal.timeout(20_000) });
      const result = await response.json().catch(() => null);
      if (!mounted.current) return;
      if (response.status === 401 || response.status === 404 || typeof result?.error === "string" && result.error.includes("signed-in account changed")) { setAvailable(false); setJobs([]); }
      if (!response.ok || (action === "discard" ? result?.discarded !== true : !valid(result?.job) || result.job.id !== requestId)) throw new Error(result?.error || "archive request was not confirmed. Check status before retrying; the same create request is retained on this page.");
      if (action === "create") operation.current = "";
      setNotice(action === "discard" ? "Generated archive discarded. Saved items, stories, photos and downloaded copies are unchanged." : result.job.status === "ready" ? "The existing complete archive is ready. No duplicate generation was started." : "archive request accepted — not yet a confirmed archive. You may leave this page and return to check status.");
      await load();
    } catch (error) { if (mounted.current) setError(error instanceof Error && error.name === "Error" ? error.message : "archive request was interrupted. Check status before retrying; this page keeps the same create request to avoid duplicate generations."); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  return <section className="card" aria-label={`Private portable archives`}>
    <h2>Generate a saved {kind}</h2>
    <p>Structured records, attribution, supported history and retained photo files are included. The ZIP includes a readable format guide and an offline Python integrity verifier. A downloaded copy works after signing out and without the app; keep it private on your device. A fresh download requires current collection membership. Already-issued download links can remain valid for up to 60 seconds.</p>
    <p className="hint">Pilot limits: 200 items, 2000 people, 1000 stories, 500 active photos, 10000 total records including history, 200 contributor identities, 8 MiB structured data and 256 MiB ZIP. Two archive requests are retained per collection (separate from the PDF limit), three attempts per request, seven-day download availability. Each attempt has a cooperative 45-second deadline and a 60-second platform duration limit; large collections may need operator support. Retries keep the original saved snapshot; generate a new {kind} to include later edits. Discard old generated copies to free capacity; family source records are never removed.</p>
    <button type="button" disabled={!ready || busy || !available} onClick={() => void action("create")}>Generate portable archive</button>{" "}
    <button type="button" className="secondary" disabled={!ready || busy} onClick={() => { setError(""); setNotice(""); void load().catch(error => { if (mounted.current) setError(error instanceof Error ? error.message : "Status unavailable."); }); }}>Check {kind} status</button>
    {!available && <p role="alert">Access or the signed-in account changed. <a href={`/collections/${collectionId}/${kind}`}>Reload this page</a> or sign in again before requesting or downloading a archive.</p>}
    {error && <p role="alert" className="notice error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!jobs.length ? <p>No retained {kind} requests for this family collection.</p> : <ul className="inventory-list">{jobs.map(job => <li className="card" key={job.id} aria-label={`${title} ${job.id}`}>
      <h3>{title} requested <time dateTime={new Date(job.createdAt).toISOString()}>{new Date(job.createdAt).toISOString()}</time></h3>
      <p>{job.total} required files (plus the manifest). Attempt {job.attempts} of 3.</p>
      {job.status === "ready" ? <><p>archive ready — {job.bytes!.toLocaleString()} bytes. Available until {new Date(job.expiresAt).toISOString()}.</p><p><a href={`${path}/${job.id}/download`}>Download private archive ZIP</a></p></> : job.status === "processing" ? <p>Generation not yet confirmed. Stage: {job.phase}. Files prepared: {job.progress} of {job.total}.</p> : <p>{job.status === "interrupted" ? "Generation was interrupted or its completion was not confirmed. Check status or retry." : job.status === "expired" ? `This generated ${kind} expired. Request a fresh saved snapshot.` : job.status === "deleting" ? "Discard is not yet confirmed. Retry discarding to finish storage cleanup." : job.error || "Generation failed. No partial archive is available."}</p>}
      {(job.status === "failed" || job.status === "interrupted") && job.attempts < 3 && <button type="button" disabled={busy || !available} onClick={() => void action("retry", job.id)}>Retry {kind} generation</button>}{" "}
      {job.status !== "processing" && <button type="button" className="secondary" disabled={busy || !available} onClick={() => void action("discard", job.id)}>Discard generated {kind}</button>}
    </li>)}</ul>}
    <noscript>Generation and status checking require JavaScript. Existing archives remain downloadable through their authorized download links.</noscript>
  </section>;
}

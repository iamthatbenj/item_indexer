"use client";

import { useRef, useState } from "react";

type Field = { label: string; value: string };
type Snapshot = { version: number; fields: Field[] };
function snapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Snapshot;
  return Number.isSafeInteger(candidate.version) && candidate.version >= 1 && candidate.version < Number.MAX_SAFE_INTEGER && Array.isArray(candidate.fields) && candidate.fields.length > 0 && candidate.fields.every(field => field && typeof field.label === "string" && typeof field.value === "string");
}
function Fields({ fields }: { fields: Field[] }) {
  return <dl>{fields.map(field => <div key={field.label}><dt>{field.label}</dt><dd>{field.value || "(blank)"}</dd></div>)}</dl>;
}

// Only an explicit review advances the editing version. Loading/closing this
// comparison never changes the parent editor's draft or its version.
export default function ConflictReview({ kind, url, attempted, onReviewed }: { kind: "item" | "story"; url: string; attempted: Field[]; onReviewed: (version: number) => void }) {
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const inFlight = useRef(false);
  async function compare() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setLatest(null);
    try {
      const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
      const result = await response.json().catch(() => null);
      if (!response.ok || !snapshot(result?.current)) throw new Error("The latest saved content could not be loaded. Check your access or connection; your draft and editing version are unchanged.");
      setLatest(result.current);
    } catch {
      setError("The latest saved content could not be loaded. Check your access or connection; your draft and editing version are unchanged.");
    } finally { inFlight.current = false; setBusy(false); }
  }
  return <section className="conflict-review" aria-label={`Compare ${kind} edits`}>
    <p>Your draft stays in the editable fields above. Compare the saved content before deliberately revising; nothing is automatically merged.</p>
    <button type="button" className="secondary" disabled={busy} onClick={compare}>{busy ? "Loading comparison…" : `Compare with latest saved ${kind}`}</button>
    {busy && <p role="status">Loading saved content without replacing your draft…</p>}
    {error && <p role="alert">{error}</p>}
    {latest && <>
      <div className="comparison-panels">
        <section aria-label={`Latest saved ${kind}`}><h3>Latest saved {kind} — version {latest.version}</h3><Fields fields={latest.fields} /></section>
        <section aria-label="Your current draft"><h3>Your current draft</h3><Fields fields={attempted} /></section>
      </div>
      <p>After reviewing both, keep or change your fields above, then save deliberately. Reviewing does not save, replace your input, or reserve the version; another edit will require comparison again.</p>
      <button type="button" onClick={() => onReviewed(latest.version)}>Revise against version {latest.version}</button>{" "}
      <button type="button" className="secondary" onClick={() => { setLatest(null); setError(""); }}>Close comparison</button>
    </>}
  </section>;
}

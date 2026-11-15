"use client";

import type { TextInput } from "@/client/pending-text";
import type { usePendingText } from "@/client/use-pending-text";

export default function PendingTextControls({ pending, disabled = false, onResume, onDiscardCurrent }: {
  pending: ReturnType<typeof usePendingText>;
  disabled?: boolean;
  onResume: (input: TextInput) => void;
  onDiscardCurrent: () => void;
}) {
  return <section className="pending-text" aria-label="Pending text on this device">
    <h3>Pending text on this device</h3>
    {pending.identityMessage && <p role="alert">{pending.identityMessage}</p>}
    {!pending.authorized ? <>
      <p>Local text is hidden until the original signed-in account is checked. <a href="/sign-in" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a>.</p>
      <button type="button" disabled={disabled || pending.busy} onClick={() => void pending.verify().catch(() => {})}>Check account and pending text</button>
    </> : <>
      {pending.notice && <p className="hint" aria-live="polite">{pending.notice}</p>}
      <p className="hint">Pending means save not confirmed. Resume replaces the editable fields below, not saved records; copy any unretained input first. Existing edits require comparison before saving. Discard removes only the selected local copy.</p>
      {!pending.drafts.length ? <p>No retained pending text for this editor on this device.</p> : <ul>{pending.drafts.map(draft => <li key={draft.id}>
        <p>{draft.input.kind === "item" ? "Item details" : draft.input.kind === "story" ? "Story changes" : "New story"} — locally retained <time dateTime={new Date(draft.updatedAt).toISOString()}>{new Date(draft.updatedAt).toISOString()}</time> — save not confirmed</p>
        <button type="button" disabled={disabled || pending.busy} onClick={() => void pending.restore(draft).then(input => { if (input) onResume(input); })}>Resume pending text</button>{" "}
        <button type="button" className="secondary" disabled={disabled || pending.busy} onClick={() => void pending.discard(draft).then(active => { if (active) onDiscardCurrent(); })}>Discard pending text</button>
      </li>)}</ul>}
      <p><a href="/pending-text">Inspect all your locally retained text</a>, including copies whose target is no longer accessible.</p>
    </>}
    <p className="hint">Local text may be sensitive and is not encrypted from someone controlling this browser profile. Use separate profiles on shared devices. Limits: 25 drafts / 1 MiB per account and collection, with no application eviction. Browser eviction, private browsing, clearing site data or losing a device can remove copies. Keep important originals separately; no full offline editing or background sync is promised.</p>
  </section>;
}

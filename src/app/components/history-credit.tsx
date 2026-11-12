export default function HistoryCredit({ version, editorEmail, editedAt, current }: { version: number; editorEmail: string; editedAt: number; current: boolean }) {
  const date = new Date(editedAt).toISOString();
  return <>
    <h2>Version {version}{current ? " — current" : ""}</h2>
    <p className="hint">Edited by {editorEmail} on <time dateTime={date}>{date}</time>.</p>
  </>;
}

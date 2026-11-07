export const PERSON_NAME_LIMIT = 200;
export const PERSON_NOTE_LIMIT = 400;
export type PersonSummary = { id: string; name: string; note: string; version: number };
export const personLabel = (person: PersonSummary) => `${person.name} — ${person.note || "No identifying note"}`;

import { createClient, type Client, type Transaction } from "@libsql/client";

let client: Client | undefined;

export function database(): Client {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error("TURSO_DATABASE_URL is required. See .env.example.");
  client ??= createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN || undefined });
  return client;
}

export async function writeTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await database().transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } finally {
    // Closing an uncommitted transaction rolls it back, including exceptions.
    tx.close();
  }
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  // Deliberately modest validation: no provider-specific alias or dot rewriting.
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

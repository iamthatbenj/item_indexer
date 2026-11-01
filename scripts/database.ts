import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { database, normalizeEmail, writeTransaction } from "../src/server/database";

async function main() {
  const [command, input] = process.argv.slice(2);
  const url = process.env.TURSO_DATABASE_URL;
  if (url?.startsWith("file:")) await mkdir(dirname(resolve(url.slice(5))), { recursive: true });
  const db = database();
  try {
    if (command === "migrate") {
      await db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, digest TEXT NOT NULL, applied_at INTEGER NOT NULL)");
      for (const name of (await readdir("migrations")).filter(name => name.endsWith(".sql")).sort()) {
        const sql = await readFile(`migrations/${name}`, "utf8");
        const digest = createHash("sha256").update(sql).digest("hex");
        await writeTransaction(async tx => {
          const applied = await tx.execute({ sql: "SELECT digest FROM schema_migrations WHERE name = ?", args: [name] });
          if (applied.rows.length) {
            if (applied.rows[0].digest !== digest) throw new Error(`Applied migration changed: ${name}`);
            return;
          }
          // These deliberately simple, checked-in migrations contain no semicolons in literals/triggers.
          for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await tx.execute(statement);
          await tx.execute({ sql: "INSERT INTO schema_migrations VALUES (?, ?, ?)", args: [name, digest, Date.now()] });
        });
        console.log(`Migration ready: ${name}`);
      }
      return;
    }
    const email = normalizeEmail(input);
    if (!email || !["approve", "revoke"].includes(command)) {
      throw new Error("Usage: npm run db:migrate | npm run founder:approve -- email@example.com | npm run founder:revoke -- email@example.com");
    }
    if (command === "approve") {
      await db.execute({ sql: "INSERT INTO approved_founders VALUES (?, ?) ON CONFLICT(email) DO NOTHING", args: [email, Date.now()] });
      console.log(`Founder approval recorded for ${email}.`);
    } else {
      await db.batch([
        { sql: "DELETE FROM approved_founders WHERE email = ?", args: [email] },
        { sql: "DELETE FROM email_challenges WHERE email = ?", args: [email] },
      ], "write");
      console.log(`Founder approval revoked for ${email}. Existing collection membership is unchanged.`);
    }
  } finally {
    db.close();
  }
}

main().catch(() => {
  // Driver errors may contain connection credentials or SQL arguments; do not print them.
  console.error("Database operation failed. Check command arguments, configuration, migration consistency, and database availability.");
  process.exitCode = 1;
});

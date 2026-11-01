import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";

// This directory is exclusively disposable test data, never .env.local or a remote database.
const root = resolve(".local/e2e");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "development",
  TURSO_DATABASE_URL: `file:${root}/test.db`,
  TURSO_AUTH_TOKEN: "",
  APP_ORIGIN: "http://127.0.0.1:3100",
  AUTH_SECRET: randomBytes(32).toString("hex"),
  MAIL_TRANSPORT: "file",
  MAIL_OUTBOX_DIR: `${root}/outbox`,
  NEXT_TELEMETRY_DISABLED: "1",
};
execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env, stdio: "inherit" });
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3100"], { env, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.kill(signal));
server.on("exit", code => process.exit(code ?? 0));

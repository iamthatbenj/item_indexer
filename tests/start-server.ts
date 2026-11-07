import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { S3Client, HeadBucketCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";

// This directory is exclusively disposable test data, never .env.local or a remote database.
const root = resolve(".local/e2e");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true, mode: 0o700 });
const image = "docker.io/chrislusf/seaweedfs@sha256:b2e51562743be5637381a82eeeee4872eb2f86994b723d25a1bbd171855fe18d";
const container = `family-belongings-e2e-${randomBytes(6).toString("hex")}`;
const endpoint = "http://127.0.0.1:9100";
const bucket = "family-test";
const accessKeyId = randomBytes(12).toString("hex");
const secretAccessKey = randomBytes(24).toString("hex");
writeFileSync(`${root}/storage.json`, JSON.stringify({ endpoint, bucket, accessKeyId, secretAccessKey, container }), { mode: 0o600 });
writeFileSync(`${root}/s3-config.json`, JSON.stringify({ identities: [{ name: "isolated-test-operator", credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }], actions: ["Admin", "Read", "Write", "List", "Tagging"] }] }), { mode: 0o644 }); // Container's unprivileged user must read this; parent directory is 0700.
const log = openSync(`${root}/storage.log`, "w", 0o600);
const storage = spawn("podman", ["run", "--rm", "--name", container, "-p", "127.0.0.1:9100:8333", "-v", `${root}/s3-config.json:/etc/test-s3.json:ro,Z`, image,
  "mini", "-dir=/data", "-ip=127.0.0.1", "-master.telemetry=false", "-s3.config=/etc/test-s3.json", "-s3.allowedOrigins=http://127.0.0.1:3100", `-bucket=${bucket}`, "-webdav=false", "-admin.ui=false", "-s3.port.iceberg=0", "-s3.port.lance=0"], { stdio: ["ignore", log, log] });
closeSync(log);
let stopping = false;
let server: ReturnType<typeof spawn> | undefined;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  server?.kill("SIGTERM");
  try { execFileSync("podman", ["rm", "--force", container], { stdio: "ignore", timeout: 15_000 }); } catch { /* May already have exited. */ }
  process.exit(code);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(0));
storage.on("error", () => { console.error("Test storage could not start. Install/configure Podman; see the photo-draft runbook."); stop(1); });
storage.on("exit", () => { if (!stopping) { console.error("Test storage exited; inspect .local/e2e/storage.log."); stop(1); } });
const env: NodeJS.ProcessEnv = {
  ...process.env, NODE_ENV: "development", TURSO_DATABASE_URL: `file:${root}/test.db`, TURSO_AUTH_TOKEN: "", APP_ORIGIN: "http://127.0.0.1:3100",
  AUTH_SECRET: randomBytes(32).toString("hex"), MAIL_TRANSPORT: "file", MAIL_OUTBOX_DIR: `${root}/outbox`, NEXT_TELEMETRY_DISABLED: "1",
  OBJECT_STORAGE_ENDPOINT: endpoint, OBJECT_STORAGE_BUCKET: bucket, OBJECT_STORAGE_ACCESS_KEY_ID: accessKeyId, OBJECT_STORAGE_SECRET_ACCESS_KEY: secretAccessKey,
};
async function main() {
  const client = new S3Client({ endpoint, region: "auto", forcePathStyle: true, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1, requestHandler: { connectionTimeout: 500, requestTimeout: 1_000 } });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try { await client.send(new HeadBucketCommand({ Bucket: bucket })); ready = true; break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!ready) throw new Error("Test object storage did not become ready.");
  await client.send(new PutBucketCorsCommand({ Bucket: bucket, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [env.APP_ORIGIN!], AllowedMethods: ["GET", "PUT"], AllowedHeaders: ["content-type"], MaxAgeSeconds: 60 }] } }));
  client.destroy();
  execFileSync(process.execPath, ["--import", "tsx", "scripts/database.ts", "migrate"], { env, stdio: "inherit" });
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--webpack", "--hostname", "127.0.0.1", "--port", "3100"], { env, stdio: "inherit" });
  server.on("exit", code => stop(code ?? 1));
}
main().catch(() => { console.error("Test setup failed. Check Podman and .local/e2e/storage.log; no production resources are used."); stop(1); });

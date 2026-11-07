import { S3Client } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Created afresh by tests/start-server.ts; never load operator/.env.local secrets.
export function testStorage() {
  const config = JSON.parse(readFileSync(resolve(".local/e2e/storage.json"), "utf8")) as { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; container: string };
  return { bucket: config.bucket, endpoint: config.endpoint, container: config.container, client: new S3Client({ endpoint: config.endpoint, region: "auto", forcePathStyle: true, credentials: config, maxAttempts: 1 }) };
}

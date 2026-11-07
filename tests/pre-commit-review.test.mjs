import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/pre-commit-review.mjs");
const hook = resolve(".githooks/pre-commit");

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-precommit-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  await mkdir(join(cwd, "scripts"));
  await mkdir(join(cwd, ".githooks"));
  await mkdir(join(cwd, "bin"));
  await copyFile(script, join(cwd, "scripts/pre-commit-review.mjs"));
  await copyFile(hook, join(cwd, ".githooks/pre-commit"));
  await chmod(join(cwd, ".githooks/pre-commit"), 0o755);
  git("config", "core.hooksPath", ".githooks");
  await writeFile(join(cwd, "bin/pi"), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[args.indexOf('--tools') + 1] !== 'read,grep,find,ls') process.exit(9);
if (!args.includes('--no-extensions') || !args.includes('--no-mcp')) process.exit(9);
fs.writeFileSync(process.env.REVIEW_CAPTURE, fs.readFileSync(path.join(process.cwd(), 'file.txt'), 'utf8'));
if (process.env.REVIEW_CRASH) process.exit(1);
if (process.env.REVIEW_MUTATE) {
  fs.writeFileSync(process.env.REVIEW_MUTATE, 'changed during review');
  require('node:child_process').execFileSync('git', ['-C', path.dirname(process.env.REVIEW_MUTATE), 'add', 'file.txt']);
}
process.stdout.write(process.env.REVIEW_RESPONSE);
`);
  await chmod(join(cwd, "bin/pi"), 0o755);
  await writeFile(join(cwd, "file.txt"), "staged content\n");
  git("add", "file.txt");
  const capture = join(cwd, "capture");
  const commit = (response, extra = {}, args = []) => spawnSync("git", ["commit", "-m", "tranche", ...args], {
    cwd, encoding: "utf8",
    env: { ...process.env, PATH: `${join(cwd, "bin")}:${process.env.PATH}`, REVIEW_CAPTURE: capture, REVIEW_RESPONSE: response, ...extra },
  });
  return { cwd, git, commit, capture };
}

const pass = JSON.stringify({ verdict: "pass", findings: [] });
const fail = JSON.stringify({ verdict: "fail", findings: [{ severity: "high", file: "file.txt", line: 1, message: "Incorrect behavior", fix: "Correct it" }] });

test("findings block the actual commit; a clean re-review allows it", async (t) => {
  const f = await fixture(t);
  const rejected = f.commit(fail);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Incorrect behavior/);
  assert.throws(() => f.git("rev-parse", "--verify", "HEAD"));
  assert.equal(f.git("diff", "--cached", "--name-only"), "file.txt");
  const accepted = f.commit(pass);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(f.git("log", "-1", "--format=%s"), "tranche");
});

test("reviews staged contents, not unstaged edits", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "file.txt"), "unstaged content\n");
  const result = f.commit(pass);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(f.capture, "utf8"), "staged content\n");
  assert.equal(f.git("show", "HEAD:file.txt"), "staged content");
  assert.equal(await readFile(join(f.cwd, "file.txt"), "utf8"), "unstaged content\n");
});

test("checkout smudge filters cannot substitute content in the staged review", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, ".gitattributes"), "file.txt filter=review-substitution\n");
  f.git("config", "filter.review-substitution.smudge", "printf 'filtered replacement\\n'");
  f.git("add", ".gitattributes");
  const result = f.commit(pass);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(f.capture, "utf8"), "staged content\n");
  assert.equal(f.git("show", "HEAD:file.txt"), "staged content");
});

test("staged symlink targets are reviewed as text without reading their external contents", async (t) => {
  const f = await fixture(t);
  const external = join(f.cwd, "private-unstaged.txt");
  await writeFile(external, "must not enter the review snapshot\n");
  await rm(join(f.cwd, "file.txt"));
  await symlink(external, join(f.cwd, "file.txt"));
  f.git("add", "file.txt");
  const result = f.commit(pass);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(f.capture, "utf8"), external);
  assert.equal(f.git("show", "HEAD:file.txt"), external);
});

test("malformed, contradictory, and failed reviews all block", async (t) => {
  const f = await fixture(t);
  for (const response of ["", "Looks good", "{}", JSON.stringify({ verdict: "pass", findings: JSON.parse(fail).findings })]) {
    assert.notEqual(f.commit(response).status, 0);
  }
  assert.notEqual(f.commit(pass, { REVIEW_CRASH: "1" }).status, 0);
  assert.throws(() => f.git("rev-parse", "--verify", "HEAD"));
});

test("ordinary subsequent commits are gated too", async (t) => {
  const f = await fixture(t);
  assert.equal(f.commit(pass).status, 0);
  const before = f.git("rev-parse", "HEAD");
  await writeFile(join(f.cwd, "file.txt"), "second tranche\n");
  f.git("add", "file.txt");
  assert.notEqual(f.commit(fail).status, 0);
  assert.equal(f.git("rev-parse", "HEAD"), before);
});

test("index changes during review invalidate approval", async (t) => {
  const f = await fixture(t);
  const result = f.commit(pass, { REVIEW_MUTATE: join(f.cwd, "file.txt") });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /index or HEAD changed during review/);
  assert.throws(() => f.git("rev-parse", "--verify", "HEAD"));
});

test("commit -a reviews its temporary index", async (t) => {
  const f = await fixture(t);
  assert.equal(f.commit(pass).status, 0);
  await writeFile(join(f.cwd, "file.txt"), "auto-staged content\n");
  const result = f.commit(pass, {}, ["-a"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(f.capture, "utf8"), "auto-staged content\n");
});

test("path-specific commits review only the selected content", async (t) => {
  const f = await fixture(t);
  assert.equal(f.commit(pass).status, 0);
  await writeFile(join(f.cwd, "file.txt"), "selected content\n");
  await writeFile(join(f.cwd, "other.txt"), "not in this commit\n");
  f.git("add", "other.txt");
  const result = f.commit(pass, {}, ["--only", "file.txt"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(f.capture, "utf8"), "selected content\n");
  assert.equal(f.git("diff", "--cached", "--name-only"), "other.txt");
});

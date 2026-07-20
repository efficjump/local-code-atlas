import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  getGitFileSnapshots,
  getGitMetadata,
} from "../../src/core/index";

const execFileAsync = promisify(execFile);

async function runGit(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], {
    env: { ...process.env, LC_ALL: "C" },
  });
}

test("Git snapshots use working tree, index, and merge-base content consistently", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-code-atlas-snapshots-"),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "db", "migrations"), { recursive: true });
  const migrationPath = path.join(root, "db", "migrations", "001_users.sql");
  const baseline = "CREATE TABLE users (id UUID PRIMARY KEY);\n";
  const staged = `${baseline}ALTER TABLE users DROP COLUMN legacy_name;\n`;
  const working = `${staged}ALTER TABLE users RENAME COLUMN id TO user_id;\n`;
  await fs.writeFile(migrationPath, baseline);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  await runGit(root, ["config", "user.name", "Fixture User"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "--quiet", "-m", "baseline"]);

  await fs.writeFile(migrationPath, staged);
  await runGit(root, ["add", "db/migrations/001_users.sql"]);
  await fs.writeFile(migrationPath, working);

  const stagedMetadata = await getGitMetadata(root, {
    includeStaged: true,
    includeUnstaged: false,
    includeUntracked: false,
  });
  const stagedResult = await getGitFileSnapshots(
    root,
    stagedMetadata.changedFiles,
    { mode: "staged" },
  );
  assert.deepEqual(stagedResult.diagnostics, []);
  assert.equal(stagedResult.snapshots[0]?.before, baseline);
  assert.equal(stagedResult.snapshots[0]?.after, staged);
  assert.equal(stagedResult.snapshots[0]?.afterSource, "index");

  const workingMetadata = await getGitMetadata(root);
  const workingResult = await getGitFileSnapshots(
    root,
    workingMetadata.changedFiles,
    { mode: "working-tree" },
  );
  assert.deepEqual(workingResult.diagnostics, []);
  assert.equal(workingResult.snapshots[0]?.before, baseline);
  assert.equal(workingResult.snapshots[0]?.after, working);
  assert.equal(workingResult.snapshots[0]?.afterSource, "working-tree");

  await runGit(root, ["restore", "db/migrations/001_users.sql"]);
  await runGit(root, ["commit", "--quiet", "-m", "migration risk"]);
  const baseMetadata = await getGitMetadata(root, {
    base: "HEAD^",
    includeWorkingTree: false,
  });
  const baseResult = await getGitFileSnapshots(
    root,
    baseMetadata.changedFiles,
    { mode: "base", base: "HEAD^" },
  );
  assert.deepEqual(baseResult.diagnostics, []);
  assert.equal(baseResult.snapshots[0]?.before, baseline);
  assert.equal(baseResult.snapshots[0]?.after, staged);
  assert.equal(baseResult.snapshots[0]?.beforeSource, "merge-base");
  assert.equal(baseResult.snapshots[0]?.afterSource, "HEAD");
});

test("staged snapshots derive file status only from the index", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-code-atlas-staged-surface-"),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "db", "migrations"), { recursive: true });
  const migrationPath = path.join(root, "db", "migrations", "001_users.sql");
  const baseline = "CREATE TABLE users (id UUID PRIMARY KEY);\n";
  const staged = `${baseline}ALTER TABLE users DROP COLUMN legacy_name;\n`;
  await fs.writeFile(migrationPath, baseline);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  await runGit(root, ["config", "user.name", "Fixture User"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "--quiet", "-m", "baseline"]);

  await fs.writeFile(migrationPath, staged);
  await runGit(root, ["add", "db/migrations/001_users.sql"]);
  await fs.unlink(migrationPath);

  const metadata = await getGitMetadata(root, {
    includeStaged: true,
    includeUnstaged: false,
    includeUntracked: false,
  });
  assert.equal(metadata.changedFiles[0]?.status, "modified");
  assert.equal(metadata.changedFiles[0]?.staged, true);
  assert.equal(metadata.changedFiles[0]?.unstaged, false);

  const result = await getGitFileSnapshots(
    root,
    metadata.changedFiles,
    { mode: "staged" },
  );
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.snapshots[0]?.status, "modified");
  assert.equal(result.snapshots[0]?.before, baseline);
  assert.equal(result.snapshots[0]?.after, staged);
  assert.equal(result.snapshots[0]?.afterSource, "index");
});

test("working-tree snapshots reject oversized files before materializing them", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-code-atlas-snapshot-budget-"),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "db"), { recursive: true });
  const schemaPath = path.join(root, "db", "schema.sql");
  const baseline = "CREATE TABLE users (id UUID);\n";
  await fs.writeFile(schemaPath, baseline);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  await runGit(root, ["config", "user.name", "Fixture User"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "--quiet", "-m", "baseline"]);
  await fs.writeFile(
    schemaPath,
    `${baseline}${"ALTER TABLE users ADD COLUMN value TEXT;\n".repeat(20)}`,
  );

  const metadata = await getGitMetadata(root);
  const result = await getGitFileSnapshots(
    root,
    metadata.changedFiles,
    { mode: "working-tree" },
    { maxFileBytes: 128 },
  );

  assert.equal(result.snapshots[0]?.before, baseline);
  assert.equal(result.snapshots[0]?.after, undefined);
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.includes("configured snapshot byte limit"),
    ),
  );
});

test("snapshot byte limits accept exact-size working-tree and Git blob content", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-code-atlas-snapshot-exact-limit-"),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "db"), { recursive: true });
  const schemaPath = path.join(root, "db", "schema.sql");
  const baseline = `-- ${"a".repeat(60)}\n`;
  const staged = `-- ${"b".repeat(60)}\n`;
  const exactBytes = Buffer.byteLength(baseline, "utf8");
  assert.equal(Buffer.byteLength(staged, "utf8"), exactBytes);
  await fs.writeFile(schemaPath, baseline);
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  await runGit(root, ["config", "user.name", "Fixture User"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "--quiet", "-m", "baseline"]);
  await fs.writeFile(schemaPath, staged);
  await runGit(root, ["add", "db/schema.sql"]);

  const stagedMetadata = await getGitMetadata(root, {
    includeStaged: true,
    includeUnstaged: false,
    includeUntracked: false,
  });
  const stagedResult = await getGitFileSnapshots(
    root,
    stagedMetadata.changedFiles,
    { mode: "staged" },
    { maxFileBytes: exactBytes },
  );
  assert.deepEqual(stagedResult.diagnostics, []);
  assert.equal(stagedResult.snapshots[0]?.before, baseline);
  assert.equal(stagedResult.snapshots[0]?.after, staged);

  const workingMetadata = await getGitMetadata(root);
  const workingResult = await getGitFileSnapshots(
    root,
    workingMetadata.changedFiles,
    { mode: "working-tree" },
    { maxFileBytes: exactBytes },
  );
  assert.deepEqual(workingResult.diagnostics, []);
  assert.equal(workingResult.snapshots[0]?.before, baseline);
  assert.equal(workingResult.snapshots[0]?.after, staged);
});

test("working-tree snapshots do not follow changed symlinks outside the project", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-code-atlas-snapshot-boundary-"),
  );
  const outside = await fs.mkdtemp(
    path.join(os.tmpdir(), "local-code-atlas-snapshot-outside-"),
  );
  context.after(async () => {
    await Promise.all([
      fs.rm(root, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });
  await fs.mkdir(path.join(root, "db"), { recursive: true });
  const projectFile = path.join(root, "db", "schema.sql");
  await fs.writeFile(projectFile, "CREATE TABLE users (id UUID);\n");
  await runGit(root, ["init", "--quiet"]);
  await runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  await runGit(root, ["config", "user.name", "Fixture User"]);
  await runGit(root, ["add", "."]);
  await runGit(root, ["commit", "--quiet", "-m", "baseline"]);

  const outsideFile = path.join(outside, "private.sql");
  await fs.writeFile(outsideFile, "PRIVATE CONTENT MUST NOT BE READ\n");
  await fs.unlink(projectFile);
  await fs.symlink(outsideFile, projectFile);

  const metadata = await getGitMetadata(root);
  const result = await getGitFileSnapshots(
    root,
    metadata.changedFiles,
    { mode: "working-tree" },
  );

  assert.equal(result.snapshots[0]?.after, undefined);
  assert.ok(
    result.diagnostics.some((diagnostic) =>
      diagnostic.includes("after-version content was unavailable"),
    ),
  );
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE CONTENT MUST NOT BE READ/u);
});

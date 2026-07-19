import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { GitComparisonError, getGitMetadata } from "../../src/core/index";

const execFileAsync = promisify(execFile);
const fixtureRoot = fileURLToPath(new URL("./fixtures/sample-project", import.meta.url));

async function runGit(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], {
    env: { ...process.env, LC_ALL: "C" },
  });
}

test("Git metadata reports staged, unstaged, and untracked files", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-atlas-git-"));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.cp(fixtureRoot, temporaryRoot, { recursive: true });
  await runGit(temporaryRoot, ["init", "--quiet"]);
  await runGit(temporaryRoot, ["config", "user.email", "fixture@example.invalid"]);
  await runGit(temporaryRoot, ["config", "user.name", "Fixture User"]);
  await runGit(temporaryRoot, ["add", "."]);
  await runGit(temporaryRoot, ["commit", "--quiet", "-m", "fixture"]);

  await fs.appendFile(path.join(temporaryRoot, "src/user/service.cts"), "\n// local change\n");
  await fs.writeFile(path.join(temporaryRoot, "note.txt"), "untracked fixture\n");
  await fs.appendFile(path.join(temporaryRoot, "src/api.cts"), "\n// staged change\n");
  await runGit(temporaryRoot, ["add", "src/api.cts"]);

  const metadata = await getGitMetadata(temporaryRoot, { executable: "git" });
  const changes = new Map(metadata.changedFiles.map((file) => [file.path, file]));

  assert.equal(metadata.isRepository, true);
  assert.equal(metadata.dirty, true);
  assert.equal(changes.get("src/api.cts")?.staged, true);
  assert.equal(changes.get("src/user/service.cts")?.unstaged, true);
  assert.equal(changes.get("note.txt")?.status, "untracked");
  assert.ok((changes.get("src/api.cts")?.additions ?? 0) >= 1);

  const stagedOnly = await getGitMetadata(temporaryRoot, {
    executable: "git",
    includeStaged: true,
    includeUnstaged: false,
    includeUntracked: false,
  });
  assert.deepEqual(
    stagedOnly.changedFiles.map((file) => file.path),
    ["src/api.cts"],
  );
  assert.equal(stagedOnly.changedFiles[0]?.staged, true);
  assert.equal(stagedOnly.changedFiles[0]?.unstaged, false);

  await runGit(temporaryRoot, ["add", "."]);
  await runGit(temporaryRoot, ["commit", "--quiet", "-m", "fixture changes"]);
  const compared = await getGitMetadata(temporaryRoot, {
    executable: "git",
    base: "HEAD^",
    includeWorkingTree: false,
  });
  assert.equal(compared.dirty, false);
  assert.equal(
    compared.changedFiles.find((file) => file.path === "note.txt")?.status,
    "added",
  );

  await runGit(temporaryRoot, ["mv", "note.txt", "renamed-note.txt"]);
  const renamed = await getGitMetadata(temporaryRoot, { executable: "git" });
  const rename = renamed.changedFiles.find((file) => file.path === "renamed-note.txt");
  assert.equal(rename?.status, "renamed");
  assert.equal(rename?.previousPath, "note.txt");
});

test("Git inspection disables optional locks, fsmonitor, external diffs, and textconv", {
  skip: process.platform === "win32" ? "fake executable fixture uses a POSIX shebang" : false,
}, async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-atlas-fake-git-"));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const recordsDirectory = path.join(temporaryRoot, "records");
  const fakeGit = path.join(temporaryRoot, "fake-git.mjs");
  await fs.mkdir(recordsDirectory);
  await fs.writeFile(
    fakeGit,
    [
      `#!${process.execPath}`,
      'import { writeFileSync } from "node:fs";',
      "const args = process.argv.slice(2);",
      'const recordUrl = new URL(`./records/${process.pid}.json`, import.meta.url);',
      "writeFileSync(recordUrl, JSON.stringify({ args, optionalLocks: process.env.GIT_OPTIONAL_LOCKS }));",
      'const commands = new Set(["rev-parse", "symbolic-ref", "status", "diff"]);',
      "const command = args.find((argument) => commands.has(argument));",
      'const rootIndex = args.indexOf("-C");',
      'const root = rootIndex >= 0 ? args[rootIndex + 1] : ".";',
      'if (command === "rev-parse" && args.includes("--show-toplevel")) {',
      '  process.stdout.write(root + "\\n");',
      '} else if (command === "rev-parse" && args.includes("--abbrev-ref")) {',
      '  process.stdout.write("origin/main\\n");',
      '} else if (command === "rev-parse" && args.includes("--verify")) {',
      '  process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");',
      '} else if (command === "symbolic-ref") {',
      '  process.stdout.write("main\\n");',
      "}",
      "",
    ].join("\n"),
  );
  await fs.chmod(fakeGit, 0o755);

  await getGitMetadata(temporaryRoot, { executable: fakeGit });
  await getGitMetadata(temporaryRoot, {
    executable: fakeGit,
    base: "main",
    includeWorkingTree: false,
  });

  const recordFiles = await fs.readdir(recordsDirectory);
  const invocations = await Promise.all(
    recordFiles.map(async (fileName) =>
      JSON.parse(await fs.readFile(path.join(recordsDirectory, fileName), "utf8")) as {
        args: string[];
        optionalLocks?: string;
      },
    ),
  );
  assert.ok(invocations.length > 0);
  for (const invocation of invocations) {
    assert.equal(invocation.optionalLocks, "0");
    const commandIndex = invocation.args.findIndex((argument) =>
      ["rev-parse", "symbolic-ref", "status", "diff"].includes(argument),
    );
    const configIndex = invocation.args.indexOf("-c");
    assert.ok(configIndex >= 0 && configIndex < commandIndex);
    assert.equal(invocation.args[configIndex + 1], "core.fsmonitor=false");
  }
  const diffInvocations = invocations.filter((invocation) =>
    invocation.args.includes("diff"),
  );
  assert.equal(diffInvocations.length, 4);
  assert.ok(
    diffInvocations.every(
      (invocation) =>
        invocation.args.includes("--no-ext-diff") &&
        invocation.args.includes("--no-textconv"),
    ),
  );
});

test("only base verification failures are mapped to GitComparisonError", {
  skip: process.platform === "win32" ? "fake executable fixture uses a POSIX shebang" : false,
}, async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-atlas-failing-git-"));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const fakeGit = path.join(temporaryRoot, "fake-git.mjs");
  await fs.writeFile(
    fakeGit,
    [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      'const commands = new Set(["rev-parse", "symbolic-ref", "status", "diff"]);',
      "const command = args.find((argument) => commands.has(argument));",
      'const rootIndex = args.indexOf("-C");',
      'const root = rootIndex >= 0 ? args[rootIndex + 1] : ".";',
      'if (command === "rev-parse" && args.includes("--show-toplevel")) {',
      '  process.stdout.write(root + "\\n");',
      '} else if (command === "rev-parse" && args.includes("--abbrev-ref")) {',
      '  process.stdout.write("origin/main\\n");',
      '} else if (command === "rev-parse" && args.includes("--verify")) {',
      '  const target = args.at(-1) ?? "";',
      '  if (target.startsWith("missing")) process.exit(2);',
      '  process.stdout.write("0123456789abcdef0123456789abcdef01234567\\n");',
      '} else if (command === "symbolic-ref") {',
      '  process.stdout.write("main\\n");',
      '} else if (command === "diff") {',
      '  process.stderr.write("synthetic diff failure\\n");',
      "  process.exit(73);",
      "}",
      "",
    ].join("\n"),
  );
  await fs.chmod(fakeGit, 0o755);

  await assert.rejects(
    getGitMetadata(temporaryRoot, {
      executable: fakeGit,
      base: "missing",
      includeWorkingTree: false,
    }),
    (error: unknown) =>
      error instanceof GitComparisonError && error.code === "BASE_NOT_FOUND",
  );
  await assert.rejects(
    getGitMetadata(temporaryRoot, {
      executable: fakeGit,
      base: "main",
      includeWorkingTree: false,
    }),
    (error: unknown) => error instanceof Error && !(error instanceof GitComparisonError),
  );

  const controller = new AbortController();
  const cancellation = new Error("cancelled by caller");
  controller.abort(cancellation);
  await assert.rejects(
    getGitMetadata(temporaryRoot, {
      executable: fakeGit,
      base: "main",
      signal: controller.signal,
    }),
    (error: unknown) => error === cancellation,
  );
});

test("Git discovery preserves executable failures instead of calling them non-repositories", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-atlas-missing-git-"));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await assert.rejects(
    getGitMetadata(temporaryRoot, {
      executable: path.join(temporaryRoot, "missing-git-executable"),
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

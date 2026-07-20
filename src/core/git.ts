import { execFile } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { comparePaths, normalizeRelativePath } from "./path-utils";
import type { GitChangedFile, GitChangeStatus, GitMetadata } from "./types";

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_BUFFER_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_READ_CHUNK_BYTES = 64 * 1024;
const READ_ONLY_GIT_CONFIG = ["-c", "core.fsmonitor=false"] as const;
const SAFE_DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv"] as const;

export interface GitOptions {
  signal?: AbortSignal;
  executable?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ChangedFilesOptions extends GitOptions {
  /** Include committed changes from the merge-base with this validated revision. */
  base?: string;
  includeWorkingTree?: boolean;
  /** Include changes already added to the Git index. Defaults to true. */
  includeStaged?: boolean;
  /** Include changes present only in the working directory. Defaults to true. */
  includeUnstaged?: boolean;
  includeUntracked?: boolean;
}

export interface GitFileSnapshotOptions extends GitOptions {
  /** Maximum working-tree bytes read for one snapshot. */
  maxFileBytes?: number;
}

export type GitSnapshotComparison =
  | { mode: "working-tree" }
  | { mode: "staged" }
  | { mode: "base"; base: string };

export interface GitFileSnapshot {
  path: string;
  previousPath?: string;
  status: GitChangeStatus;
  before?: string;
  after?: string;
  beforeSource: "HEAD" | "merge-base";
  afterSource: "working-tree" | "index" | "HEAD";
}

export interface GitFileSnapshotResult {
  snapshots: GitFileSnapshot[];
  diagnostics: string[];
}

export class GitComparisonError extends Error {
  readonly code: "INVALID_BASE" | "NOT_REPOSITORY" | "BASE_NOT_FOUND";

  constructor(
    code: GitComparisonError["code"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitComparisonError";
    this.code = code;
  }
}

async function git(
  directory: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string> {
  const { stdout } = await execFileAsync(options.executable ?? "git", [
    "-C",
    directory,
    ...READ_ONLY_GIT_CONFIG,
    ...args,
  ], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 10_000,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_GIT_BUFFER_BYTES,
    signal: options.signal,
    env: {
      ...process.env,
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  return stdout;
}

async function tryGit(
  directory: string,
  args: readonly string[],
  options: GitOptions = {},
): Promise<string | undefined> {
  try {
    return await git(directory, args, options);
  } catch (error) {
    rethrowCancellation(error, options.signal);
    return undefined;
  }
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : error;
  }
  if (error instanceof Error && error.name === "AbortError") throw error;
}

function statusFromCode(code: string): GitChangeStatus {
  if (code.includes("U") || ["AA", "DD"].includes(code)) return "conflicted";
  const meaningful = code.replace(/[ ?!]/g, "");
  if (code === "??") return "untracked";
  if (meaningful.includes("R")) return "renamed";
  if (meaningful.includes("C")) return "copied";
  if (meaningful.includes("A")) return "added";
  if (meaningful.includes("D")) return "deleted";
  if (meaningful.includes("M") || meaningful.includes("T")) return "modified";
  return "unknown";
}

interface PorcelainEntry extends GitChangedFile {
  stagedStatus?: GitChangeStatus;
  unstagedStatus?: GitChangeStatus;
}

function porcelainSurfaceStatus(
  code: string,
  surface: "staged" | "unstaged",
): GitChangeStatus | undefined {
  if (code === "??") return surface === "unstaged" ? "untracked" : undefined;
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  const index = surface === "staged" ? 0 : 1;
  const surfaceCode = code[index];
  if (
    !surfaceCode ||
    surfaceCode === " " ||
    surfaceCode === "?" ||
    surfaceCode === "!"
  ) {
    return undefined;
  }
  return statusFromCode(
    surface === "staged" ? `${surfaceCode} ` : ` ${surfaceCode}`,
  );
}

function parsePorcelainV1(
  output: string,
  includeUntracked: boolean,
): PorcelainEntry[] {
  const fields = output.split("\0");
  const changed: PorcelainEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field || field.length < 3) continue;
    const code = field.slice(0, 2);
    if (code === "!!" || (code === "??" && !includeUntracked)) continue;
    const currentPath = normalizeRelativePath(field.slice(3));
    let previousPath: string | undefined;
    if (code.includes("R") || code.includes("C")) {
      previousPath = normalizeRelativePath(fields[index + 1] ?? "");
      index += 1;
    }
    const staged = code[0] !== " " && code[0] !== "?" && code[0] !== "!";
    const unstaged = code[1] !== " " && code[1] !== "!";
    changed.push({
      path: currentPath,
      previousPath: previousPath || undefined,
      status: statusFromCode(code),
      staged,
      unstaged,
      stagedStatus: porcelainSurfaceStatus(code, "staged"),
      unstagedStatus: porcelainSurfaceStatus(code, "unstaged"),
    });
  }
  return changed;
}

interface DiffEntry {
  path: string;
  previousPath?: string;
  status: GitChangeStatus;
}

function parseNameStatus(output: string): DiffEntry[] {
  const fields = output.split("\0");
  const entries: DiffEntry[] = [];
  for (let index = 0; index < fields.length; ) {
    const rawStatus = fields[index++];
    if (!rawStatus) continue;
    const code = rawStatus[0] ?? "";
    if (code === "R" || code === "C") {
      const previousPath = normalizeRelativePath(fields[index++] ?? "");
      const currentPath = normalizeRelativePath(fields[index++] ?? "");
      if (currentPath) {
        entries.push({
          path: currentPath,
          previousPath: previousPath || undefined,
          status: code === "R" ? "renamed" : "copied",
        });
      }
      continue;
    }
    const currentPath = normalizeRelativePath(fields[index++] ?? "");
    if (!currentPath) continue;
    entries.push({ path: currentPath, status: statusFromCode(`${code} `) });
  }
  return entries;
}

function parseNumstat(output: string): Map<string, { additions?: number; deletions?: number }> {
  const values = output.split("\0");
  const result = new Map<string, { additions?: number; deletions?: number }>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value) continue;
    const firstTab = value.indexOf("\t");
    const secondTab = value.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsText = value.slice(0, firstTab);
    const deletionsText = value.slice(firstTab + 1, secondTab);
    let targetPath = value.slice(secondTab + 1);
    if (!targetPath) {
      index += 1; // previous name
      targetPath = values[++index] ?? ""; // current name
    }
    targetPath = normalizeRelativePath(targetPath);
    if (!targetPath) continue;
    result.set(targetPath, {
      additions: additionsText === "-" ? undefined : Number.parseInt(additionsText, 10),
      deletions: deletionsText === "-" ? undefined : Number.parseInt(deletionsText, 10),
    });
  }
  return result;
}

function mergeEntry(
  entries: Map<string, GitChangedFile>,
  incoming: GitChangedFile,
): void {
  const current = entries.get(incoming.path);
  if (!current) {
    entries.set(incoming.path, incoming);
    return;
  }
  const precedence: GitChangeStatus[] = [
    "conflicted",
    "deleted",
    "renamed",
    "copied",
    "added",
    "modified",
    "untracked",
    "unknown",
  ];
  entries.set(incoming.path, {
    ...current,
    ...incoming,
    previousPath: incoming.previousPath ?? current.previousPath,
    status:
      precedence.indexOf(incoming.status) < precedence.indexOf(current.status)
        ? incoming.status
        : current.status,
    staged: current.staged || incoming.staged,
    unstaged: current.unstaged || incoming.unstaged,
    additions: incoming.additions ?? current.additions,
    deletions: incoming.deletions ?? current.deletions,
  });
}

function assertSafeRevision(revision: string): void {
  if (
    !revision ||
    revision.startsWith("-") ||
    !/^[A-Za-z0-9_./@{}^~:+-]+$/u.test(revision)
  ) {
    throw new GitComparisonError(
      "INVALID_BASE",
      "Git base revision contains unsupported characters.",
    );
  }
}

function safeRepositoryPath(
  repositoryRoot: string,
  projectRoot: string,
  relativePath: string,
): string | undefined {
  const normalized = normalizeRelativePath(relativePath);
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  const rawPrefix = path.relative(repositoryRoot, projectRoot);
  if (
    path.isAbsolute(rawPrefix) ||
    rawPrefix === ".." ||
    rawPrefix.startsWith(`..${path.sep}`)
  ) {
    return undefined;
  }
  const prefix = normalizeRelativePath(rawPrefix);
  return prefix ? `${prefix}/${normalized}` : normalized;
}

async function tryGitBlob(
  root: string,
  revision: string,
  repositoryPath: string,
  options: GitOptions,
  maxBytes: number,
): Promise<{ content?: string; oversized: boolean }> {
  try {
    const objectName = revision
      ? `${revision}:${repositoryPath}`
      : `:${repositoryPath}`;
    const sizeText = await git(root, ["cat-file", "-s", objectName], options);
    const size = Number.parseInt(sizeText.trim(), 10);
    if (!Number.isSafeInteger(size) || size < 0) return { oversized: false };
    if (size > maxBytes) return { oversized: true };
    const content = await git(root, ["cat-file", "blob", objectName], {
      ...options,
      maxBufferBytes: maxBytes,
    });
    return { content, oversized: false };
  } catch (error) {
    rethrowCancellation(error, options.signal);
    return { oversized: false };
  }
}

function snapshotByteLimit(options: GitFileSnapshotOptions): number {
  const positiveLimit = (value: number | undefined) =>
    Number.isSafeInteger(value) && (value as number) > 0
      ? (value as number)
      : undefined;
  const fileLimit = positiveLimit(options.maxFileBytes);
  const bufferLimit = positiveLimit(options.maxBufferBytes);
  if (fileLimit !== undefined && bufferLimit !== undefined) {
    return Math.min(fileLimit, bufferLimit);
  }
  return fileLimit ?? bufferLimit ?? DEFAULT_GIT_BUFFER_BYTES;
}

async function readWorkingTreeSnapshot(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ content?: string; oversized: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return { oversized: false };
    if (metadata.size > maxBytes) return { oversized: true };

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes < maxBytes) {
      signal?.throwIfAborted();
      const remaining = maxBytes - totalBytes;
      const buffer = Buffer.allocUnsafe(
        Math.min(SNAPSHOT_READ_CHUNK_BYTES, remaining),
      );
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        totalBytes,
      );
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }
    if (totalBytes === maxBytes) {
      signal?.throwIfAborted();
      const sentinel = Buffer.allocUnsafe(1);
      const { bytesRead } = await handle.read(sentinel, 0, 1, totalBytes);
      if (bytesRead > 0) return { oversized: true };
    }
    return {
      content: Buffer.concat(chunks, totalBytes).toString("utf8"),
      oversized: false,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read before/after file contents from the exact Git comparison surface.
 * This prevents staged and base analyses from accidentally inspecting an
 * unrelated working-tree version of the same file.
 */
export async function getGitFileSnapshots(
  projectPath: string,
  changes: readonly GitChangedFile[],
  comparison: GitSnapshotComparison,
  options: GitFileSnapshotOptions = {},
): Promise<GitFileSnapshotResult> {
  const repositoryRoot = await findGitRoot(projectPath, options);
  if (!repositoryRoot) {
    throw new GitComparisonError(
      "NOT_REPOSITORY",
      "Git file snapshots require a Git repository.",
    );
  }
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const canonicalProjectRoot = await realpath(projectPath);
  let beforeRevision = "HEAD";
  let beforeSource: GitFileSnapshot["beforeSource"] = "HEAD";
  if (comparison.mode === "base") {
    assertSafeRevision(comparison.base);
    try {
      const baseHash = (
        await git(
          canonicalRepositoryRoot,
          ["rev-parse", "--verify", `${comparison.base}^{commit}`],
          options,
        )
      ).trim();
      beforeRevision = (
        await git(canonicalRepositoryRoot, ["merge-base", baseHash, "HEAD"], options)
      ).trim();
      if (!beforeRevision) throw new Error("Git returned an empty merge base.");
      beforeSource = "merge-base";
    } catch (error) {
      rethrowCancellation(error, options.signal);
      throw new GitComparisonError(
        "BASE_NOT_FOUND",
        `Git could not resolve the merge base for ${comparison.base}.`,
        { cause: error },
      );
    }
  }

  const diagnostics: string[] = [];
  const snapshots: GitFileSnapshot[] = [];
  const maxSnapshotBytes = snapshotByteLimit(options);
  for (const change of changes) {
    options.signal?.throwIfAborted();
    const repositoryPath = safeRepositoryPath(
      canonicalRepositoryRoot,
      canonicalProjectRoot,
      change.path,
    );
    const previousRepositoryPath = safeRepositoryPath(
      canonicalRepositoryRoot,
      canonicalProjectRoot,
      change.previousPath ?? change.path,
    );
    if (!repositoryPath || !previousRepositoryPath) {
      diagnostics.push(`${change.path}: Git snapshot path was outside the selected project.`);
      continue;
    }

    const expectsBefore = change.status !== "added" && change.status !== "untracked";
    const expectsAfter = change.status !== "deleted";
    const beforeResult = expectsBefore
      ? await tryGitBlob(
          canonicalRepositoryRoot,
          beforeRevision,
          previousRepositoryPath,
          options,
          maxSnapshotBytes,
        )
      : { oversized: false };
    const before = beforeResult.content;
    let after: string | undefined;
    let beforeDiagnosticRecorded = false;
    let afterDiagnosticRecorded = false;
    if (beforeResult.oversized) {
      diagnostics.push(
        `${change.path}: before-version content exceeded the configured snapshot byte limit.`,
      );
      beforeDiagnosticRecorded = true;
    }
    if (expectsAfter && comparison.mode === "working-tree") {
      const absolutePath = path.resolve(canonicalProjectRoot, change.path);
      const relativeCheck = path.relative(canonicalProjectRoot, absolutePath);
      if (
        relativeCheck !== "" &&
        relativeCheck !== ".." &&
        !relativeCheck.startsWith(`..${path.sep}`)
      ) {
        try {
          const canonicalFile = await realpath(absolutePath);
          const canonicalCheck = path.relative(canonicalProjectRoot, canonicalFile);
          if (
            canonicalCheck !== ".." &&
            !canonicalCheck.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(canonicalCheck)
          ) {
            const result = await readWorkingTreeSnapshot(
              canonicalFile,
              maxSnapshotBytes,
              options.signal,
            );
            after = result.content;
            if (result.oversized) {
              diagnostics.push(
                `${change.path}: working-tree content exceeded the configured snapshot byte limit.`,
              );
              afterDiagnosticRecorded = true;
            }
          }
        } catch (error) {
          rethrowCancellation(error, options.signal);
        }
      }
    } else if (expectsAfter) {
      const result = await tryGitBlob(
        canonicalRepositoryRoot,
        comparison.mode === "staged" ? "" : "HEAD",
        repositoryPath,
        options,
        maxSnapshotBytes,
      );
      after = result.content;
      if (result.oversized) {
        diagnostics.push(
          `${change.path}: after-version content exceeded the configured snapshot byte limit.`,
        );
        afterDiagnosticRecorded = true;
      }
    }

    if (expectsBefore && before === undefined && !beforeDiagnosticRecorded) {
      diagnostics.push(`${change.path}: before-version content was unavailable.`);
    }
    if (expectsAfter && after === undefined && !afterDiagnosticRecorded) {
      diagnostics.push(`${change.path}: after-version content was unavailable.`);
    }
    snapshots.push({
      path: change.path,
      previousPath: change.previousPath,
      status: change.status,
      before,
      after,
      beforeSource,
      afterSource:
        comparison.mode === "working-tree"
          ? "working-tree"
          : comparison.mode === "staged"
            ? "index"
            : "HEAD",
    });
  }
  return { snapshots, diagnostics };
}

export async function findGitRoot(
  projectPath: string,
  options: GitOptions = {},
): Promise<string | undefined> {
  try {
    const output = await git(projectPath, ["rev-parse", "--show-toplevel"], options);
    return output.trim() ? path.resolve(output.trim()) : undefined;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    const stderr = (error as { stderr?: unknown })?.stderr;
    if (
      typeof stderr === "string" &&
      /not a git repository|not a git directory/iu.test(stderr)
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function getChangedFiles(
  projectPath: string,
  options: ChangedFilesOptions = {},
): Promise<GitChangedFile[]> {
  const root = await findGitRoot(projectPath, options);
  if (!root) {
    if (options.base) {
      throw new GitComparisonError(
        "NOT_REPOSITORY",
        "A base revision comparison requires a Git repository.",
      );
    }
    return [];
  }
  const entries = new Map<string, GitChangedFile>();

  if (options.base) {
    assertSafeRevision(options.base);
    let baseHash: string;
    try {
      baseHash = (await git(
        root,
        ["rev-parse", "--verify", `${options.base}^{commit}`],
        options,
      )).trim();
    } catch (error) {
      if (error instanceof GitComparisonError) throw error;
      rethrowCancellation(error, options.signal);
      throw new GitComparisonError(
        "BASE_NOT_FOUND",
        `Git could not compare ${options.base} to HEAD.`,
        { cause: error },
      );
    }
    const range = `${baseHash}...HEAD`;
    const [nameStatus, numstat] = await Promise.all([
      git(root, ["diff", ...SAFE_DIFF_OPTIONS, "--name-status", "-z", "--find-renames", range], options),
      git(root, ["diff", ...SAFE_DIFF_OPTIONS, "--numstat", "-z", "--find-renames", range], options),
    ]);
    const counts = parseNumstat(numstat);
    for (const entry of parseNameStatus(nameStatus)) {
      mergeEntry(entries, {
        ...entry,
        staged: false,
        unstaged: false,
        ...counts.get(entry.path),
      });
    }
  }

  if (options.includeWorkingTree !== false) {
    const includeStaged = options.includeStaged !== false;
    const includeUnstaged = options.includeUnstaged !== false;
    const status = await git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      options.includeUntracked === false ? "--untracked-files=no" : "--untracked-files=all",
    ], options);
    const [unstagedStats, stagedStats] = await Promise.all([
      includeUnstaged
        ? tryGit(root, ["diff", ...SAFE_DIFF_OPTIONS, "--numstat", "-z"], options)
        : Promise.resolve(undefined),
      includeStaged
        ? tryGit(root, ["diff", ...SAFE_DIFF_OPTIONS, "--cached", "--numstat", "-z"], options)
        : Promise.resolve(undefined),
    ]);
    const counts = new Map<string, { additions?: number; deletions?: number }>();
    for (const map of [parseNumstat(unstagedStats ?? ""), parseNumstat(stagedStats ?? "")]) {
      for (const [filePath, value] of map) {
        const previous = counts.get(filePath);
        counts.set(filePath, {
          additions:
            value.additions === undefined
              ? previous?.additions
              : (previous?.additions ?? 0) + value.additions,
          deletions:
            value.deletions === undefined
              ? previous?.deletions
              : (previous?.deletions ?? 0) + value.deletions,
        });
      }
    }
    for (const parsedEntry of parsePorcelainV1(
      status,
      options.includeUntracked !== false,
    )) {
      const { stagedStatus, unstagedStatus, ...entry } = parsedEntry;
      const selectedStatus =
        includeStaged && includeUnstaged
          ? entry.status
          : includeStaged
            ? stagedStatus
            : unstagedStatus;
      if (!selectedStatus) continue;
      const selectedEntry = {
        ...entry,
        status: selectedStatus,
        previousPath:
          selectedStatus === "renamed" || selectedStatus === "copied"
            ? entry.previousPath
            : undefined,
        staged: includeStaged && entry.staged,
        unstaged: includeUnstaged && entry.unstaged,
      };
      if (!selectedEntry.staged && !selectedEntry.unstaged) continue;
      mergeEntry(entries, { ...selectedEntry, ...counts.get(entry.path) });
    }
  }

  return [...entries.values()].sort((a, b) => comparePaths(a.path, b.path));
}

export async function getGitMetadata(
  projectPath: string,
  options: ChangedFilesOptions = {},
): Promise<GitMetadata> {
  const root = await findGitRoot(projectPath, options);
  if (!root) {
    if (options.base) {
      throw new GitComparisonError(
        "NOT_REPOSITORY",
        "A base revision comparison requires a Git repository.",
      );
    }
    return {
      isRepository: false,
      detached: false,
      dirty: false,
      changedFiles: [],
    };
  }

  const [branchText, headText, upstreamText, changedFiles] = await Promise.all([
    tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], options),
    tryGit(root, ["rev-parse", "--verify", "HEAD"], options),
    tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], options),
    getChangedFiles(root, options),
  ]);
  const branch = branchText?.trim() || undefined;
  const head = headText?.trim() || undefined;
  return {
    isRepository: true,
    root,
    branch,
    head,
    upstream: upstreamText?.trim() || undefined,
    detached: Boolean(head && !branch),
    dirty: changedFiles.some((file) => file.staged || file.unstaged || file.status === "untracked"),
    changedFiles,
  };
}

export const __gitParsersForTests = {
  parseNameStatus,
  parseNumstat,
  parsePorcelainV1,
};

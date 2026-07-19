import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { comparePaths, normalizeRelativePath } from "./path-utils";
import type { GitChangedFile, GitChangeStatus, GitMetadata } from "./types";

const execFileAsync = promisify(execFile);
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
    maxBuffer: options.maxBufferBytes ?? 8 * 1024 * 1024,
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

function parsePorcelainV1(output: string, includeUntracked: boolean): GitChangedFile[] {
  const fields = output.split("\0");
  const changed: GitChangedFile[] = [];
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
    for (const entry of parsePorcelainV1(status, options.includeUntracked !== false)) {
      const selectedEntry = {
        ...entry,
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

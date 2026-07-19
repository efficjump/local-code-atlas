import { promises as fs } from "node:fs";
import path from "node:path";
import { IgnoreMatcher } from "./ignore";
import { classifyFile, DEFAULT_LANGUAGE_DEFINITIONS, detectLanguage } from "./languages";
import { comparePaths, extensionOf, safeRelativePath } from "./path-utils";
import { looksLikeSecretFile } from "./redaction";
import {
  classifySourceScope,
  sourceScopeIncluded,
  type SourceScopeClassificationOptions,
} from "./source-scope";
import type {
  LanguageDefinition,
  PublicScanResult,
  ScanResult,
  ScanStats,
  ScanWarning,
  ScannedFile,
  SourceScope,
} from "./types";

export const DEFAULT_IGNORED_DIRECTORIES: readonly string[] = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".cache",
  ".parcel-cache",
  ".turbo",
  ".wrangler",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
  ".gradle",
  ".venv",
  "venv",
  "__pycache__",
];

export interface ScanOptions {
  signal?: AbortSignal;
  ignorePatterns?: readonly string[];
  ignoreFileNames?: readonly string[];
  useIgnoreFiles?: boolean;
  ignoredDirectoryNames?: readonly string[];
  includeHidden?: boolean;
  includeSecretFiles?: boolean;
  followSymlinks?: boolean;
  countLines?: boolean;
  maxFiles?: number;
  /** Stop before accepting files whose cumulative size exceeds this budget. */
  maxTotalBytes?: number;
  maxFileBytes?: number;
  binaryProbeBytes?: number;
  languageDefinitions?: readonly LanguageDefinition[];
  include?: (relativePath: string, isDirectory: boolean) => boolean;
  /** Annotate files with these rules; scanning still includes every scope by default. */
  sourceScopeRules?: SourceScopeClassificationOptions["rules"];
  extendSourceScopeRules?: SourceScopeClassificationOptions["extendRules"];
  /** Optionally limit returned files by role. Defaults to all for graph/test discovery. */
  sourceScope?: "production" | "all" | readonly SourceScope[];
}

function isHiddenPath(relativePath: string): boolean {
  return relativePath.split("/").some((part) => part.startsWith(".") && part !== ".");
}

function isProbablyBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / buffer.length > 0.1;
}

async function probeFile(
  absolutePath: string,
  maxBytes: number,
): Promise<{ isBinary: boolean; text?: string }> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (isProbablyBinary(sample)) return { isBinary: true };
    return { isBinary: false, text: sample.toString("utf8") };
  } finally {
    await handle.close();
  }
}

function warningFor(error: unknown, relativePath: string): ScanWarning {
  const code = (error as NodeJS.ErrnoException)?.code;
  return {
    code: code === "EACCES" || code === "EPERM" ? "permission-denied" : "read-failed",
    path: relativePath || undefined,
    message:
      code === "EACCES" || code === "EPERM"
        ? "The entry could not be read because access was denied."
        : "The entry could not be read and was skipped.",
  };
}

export async function scanProject(rootInput: string, options: ScanOptions = {}): Promise<ScanResult> {
  options.signal?.throwIfAborted();
  const root = await fs.realpath(path.resolve(rootInput));
  const rootStats = await fs.stat(root);
  if (!rootStats.isDirectory()) throw new Error("Project root must be a directory.");

  const maxFiles = Math.max(1, options.maxFiles ?? 20_000);
  const maxTotalBytes = Math.max(1_024, options.maxTotalBytes ?? 512 * 1024 * 1024);
  const maxFileBytes = Math.max(1_024, options.maxFileBytes ?? 2 * 1024 * 1024);
  const binaryProbeBytes = Math.max(256, options.binaryProbeBytes ?? 8_192);
  const ignoreFileNames = new Set(options.ignoreFileNames ?? [".gitignore", ".ignore"]);
  const ignoredDirectoryNames = new Set(
    options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORIES,
  );
  const matcher = new IgnoreMatcher(options.ignorePatterns ?? []);
  const files: ScannedFile[] = [];
  const warnings: ScanWarning[] = [];
  const visitedRealPaths = new Set<string>([root]);
  const stats: ScanStats = {
    visitedDirectories: 0,
    visitedFiles: 0,
    ignoredEntries: 0,
    binaryFiles: 0,
    totalBytes: 0,
  };
  let truncated = false;

  async function loadIgnoreFiles(directory: string, relativeDirectory: string): Promise<void> {
    if (options.useIgnoreFiles === false) return;
    for (const fileName of [...ignoreFileNames].sort(comparePaths)) {
      const ignorePath = path.join(directory, fileName);
      try {
        const contents = await fs.readFile(ignorePath, "utf8");
        const invalidCount = matcher.addFile(contents, {
          baseDir: relativeDirectory,
          source: relativeDirectory ? `${relativeDirectory}/${fileName}` : fileName,
        });
        if (invalidCount > 0) {
          warnings.push({
            code: "invalid-ignore-pattern",
            path: relativeDirectory ? `${relativeDirectory}/${fileName}` : fileName,
            message: `${invalidCount.toLocaleString("en-US")} invalid ignore pattern${invalidCount === 1 ? " was" : "s were"} skipped.`,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          warnings.push(warningFor(error, relativeDirectory ? `${relativeDirectory}/${fileName}` : fileName));
        }
      }
    }
  }

  async function visit(directory: string): Promise<void> {
    options.signal?.throwIfAborted();
    if (truncated) return;
    stats.visitedDirectories += 1;
    const relativeDirectory = safeRelativePath(root, directory) ?? "";
    await loadIgnoreFiles(directory, relativeDirectory);

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      warnings.push(warningFor(error, relativeDirectory));
      return;
    }
    entries.sort((a, b) => comparePaths(a.name, b.name));

    for (const entry of entries) {
      options.signal?.throwIfAborted();
      if (truncated) return;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = safeRelativePath(root, absolutePath);
      if (relativePath === undefined) {
        warnings.push({
          code: "outside-root",
          message: "An entry resolved outside the project root and was skipped.",
        });
        continue;
      }

      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) {
          stats.ignoredEntries += 1;
          continue;
        }
        try {
          const realPath = await fs.realpath(absolutePath);
          const safePath = safeRelativePath(root, realPath);
          if (safePath === undefined) {
            warnings.push({
              code: "outside-root",
              path: relativePath,
              message: "A symbolic link resolved outside the project root and was skipped.",
            });
            continue;
          }
          if (visitedRealPaths.has(realPath)) {
            warnings.push({
              code: "symlink-cycle",
              path: relativePath,
              message: "A symbolic link cycle was detected and skipped.",
            });
            continue;
          }
          visitedRealPaths.add(realPath);
          const targetStats = await fs.stat(realPath);
          isDirectory = targetStats.isDirectory();
          isFile = targetStats.isFile();
        } catch (error) {
          warnings.push(warningFor(error, relativePath));
          continue;
        }
      }

      if (options.includeHidden === false && isHiddenPath(relativePath)) {
        const isAllowedIgnoreFile = isFile && ignoreFileNames.has(entry.name);
        if (!isAllowedIgnoreFile) {
          stats.ignoredEntries += 1;
          continue;
        }
      }

      if (isDirectory && ignoredDirectoryNames.has(entry.name)) {
        stats.ignoredEntries += 1;
        continue;
      }

      const ignored = matcher.isIgnored(relativePath, isDirectory);
      if (ignored && !(isDirectory && matcher.mayReincludeDescendant(relativePath))) {
        stats.ignoredEntries += 1;
        continue;
      }
      if (options.include && !options.include(relativePath, isDirectory)) {
        stats.ignoredEntries += 1;
        continue;
      }

      if (isDirectory) {
        await visit(absolutePath);
        continue;
      }
      if (!isFile || ignoreFileNames.has(entry.name)) continue;
      if (!options.includeSecretFiles && looksLikeSecretFile(relativePath)) {
        stats.ignoredEntries += 1;
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        warnings.push({
          code: "limit-reached",
          message: `File scan stopped at the configured limit of ${maxFiles.toLocaleString("en-US")} files.`,
        });
        return;
      }

      stats.visitedFiles += 1;
      try {
        const fileStats = await fs.stat(absolutePath);
        if (stats.totalBytes + fileStats.size > maxTotalBytes) {
          truncated = true;
          warnings.push({
            code: "limit-reached",
            path: relativePath,
            message: "File scan stopped before exceeding the configured total byte budget.",
          });
          return;
        }
        stats.totalBytes += fileStats.size;
        const probe = await probeFile(absolutePath, Math.min(binaryProbeBytes, fileStats.size || binaryProbeBytes));
        if (probe.isBinary) stats.binaryFiles += 1;
        const firstLine = probe.text?.split(/\r?\n/u, 1)[0];
        const language = detectLanguage(
          relativePath,
          firstLine,
          options.languageDefinitions ?? DEFAULT_LANGUAGE_DEFINITIONS,
        )?.id;
        let lineCount: number | undefined;
        if (options.countLines !== false && !probe.isBinary && fileStats.size <= maxFileBytes) {
          const contents = await fs.readFile(absolutePath, "utf8");
          lineCount = contents.length === 0 ? 0 : contents.split(/\r?\n/u).length;
        }
        const kind = classifyFile(relativePath, language);
        const sourceScope = classifySourceScope(
          { path: relativePath, kind },
          {
            rules: options.sourceScopeRules,
            extendRules: options.extendSourceScopeRules,
          },
        );
        if (!sourceScopeIncluded(sourceScope, options.sourceScope ?? "all")) {
          stats.ignoredEntries += 1;
          continue;
        }
        files.push({
          path: relativePath,
          absolutePath,
          extension: extensionOf(relativePath),
          sizeBytes: fileStats.size,
          modifiedAtMs: Math.trunc(fileStats.mtimeMs),
          lineCount,
          language,
          kind,
          sourceScope,
          isBinary: probe.isBinary,
        });
      } catch (error) {
        warnings.push(warningFor(error, relativePath));
      }
    }
  }

  await visit(root);
  files.sort((a, b) => comparePaths(a.path, b.path));
  warnings.sort((a, b) => comparePaths(a.path ?? "", b.path ?? ""));
  return { root, files, warnings, truncated, stats };
}

export function toPublicScanResult(result: ScanResult): PublicScanResult {
  return {
    files: result.files.map(({ absolutePath, ...file }) => {
      void absolutePath;
      return file;
    }),
    warnings: result.warnings,
    truncated: result.truncated,
    stats: result.stats,
  };
}

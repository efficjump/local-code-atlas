import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { GitChangeStatus } from "../core/types.js";
import {
  BENCHMARK_DIMENSIONS,
  type BenchmarkCatalog,
  type BenchmarkChangedFile,
  type BenchmarkLabels,
  type BenchmarkManifest,
  type DiscoveredBenchmark,
} from "./types.js";

const MANIFEST_SUFFIX = ".benchmark.json";
const GIT_CHANGE_STATUSES = new Set<GitChangeStatus>([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  manifestPath: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${manifestPath}: ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function relativeCatalogPath(
  value: unknown,
  field: string,
  manifestPath: string,
): string {
  const candidate = requiredString(value, field, manifestPath).replaceAll(
    "\\",
    "/",
  );
  if (
    candidate.startsWith("/") ||
    /^[a-z]:\//iu.test(candidate) ||
    candidate.split("/").includes("..")
  ) {
    throw new Error(`${manifestPath}: ${field} must be a contained relative path.`);
  }
  const normalized = candidate.replace(/^\.\//u, "");
  if (!normalized || normalized === ".") {
    throw new Error(`${manifestPath}: ${field} must identify a path.`);
  }
  return normalized;
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string,
  manifestPath: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${manifestPath}: ${field} must be a non-negative integer.`);
  }
  return value as number;
}

function labelsFrom(
  value: unknown,
  manifestPath: string,
): BenchmarkLabels {
  if (!isRecord(value)) {
    throw new Error(`${manifestPath}: expected must be an object.`);
  }
  return Object.fromEntries(
    BENCHMARK_DIMENSIONS.map((dimension) => {
      const labels = value[dimension];
      if (
        !Array.isArray(labels) ||
        labels.some((label) => typeof label !== "string" || label.trim() === "")
      ) {
        throw new Error(
          `${manifestPath}: expected.${dimension} must be an array of non-empty strings.`,
        );
      }
      const normalized = labels.map((label) => (label as string).trim());
      if (new Set(normalized).size !== normalized.length) {
        throw new Error(
          `${manifestPath}: expected.${dimension} contains duplicate labels.`,
        );
      }
      return [
        dimension,
        normalized.sort((left, right) => left.localeCompare(right, "en")),
      ];
    }),
  ) as BenchmarkLabels;
}

function changedFilesFrom(
  value: unknown,
  manifestPath: string,
): BenchmarkChangedFile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${manifestPath}: changedFiles must be an array.`);
  }
  return value.map((candidate, index) => {
    const field = `changedFiles[${index}]`;
    if (!isRecord(candidate)) {
      throw new Error(`${manifestPath}: ${field} must be an object.`);
    }
    const status = candidate.status;
    if (
      status !== undefined &&
      (typeof status !== "string" ||
        !GIT_CHANGE_STATUSES.has(status as GitChangeStatus))
    ) {
      throw new Error(`${manifestPath}: ${field}.status is not supported.`);
    }
    for (const booleanField of ["staged", "unstaged"] as const) {
      if (
        candidate[booleanField] !== undefined &&
        typeof candidate[booleanField] !== "boolean"
      ) {
        throw new Error(
          `${manifestPath}: ${field}.${booleanField} must be a boolean.`,
        );
      }
    }
    const changedFile: BenchmarkChangedFile = {
      path: relativeCatalogPath(candidate.path, `${field}.path`, manifestPath),
      status: (status as GitChangeStatus | undefined) ?? "modified",
      staged: (candidate.staged as boolean | undefined) ?? false,
      unstaged: (candidate.unstaged as boolean | undefined) ?? true,
    };
    if (candidate.previousPath !== undefined) {
      changedFile.previousPath = relativeCatalogPath(
        candidate.previousPath,
        `${field}.previousPath`,
        manifestPath,
      );
    }
    const additions = optionalNonNegativeInteger(
      candidate.additions,
      `${field}.additions`,
      manifestPath,
    );
    const deletions = optionalNonNegativeInteger(
      candidate.deletions,
      `${field}.deletions`,
      manifestPath,
    );
    if (additions !== undefined) changedFile.additions = additions;
    if (deletions !== undefined) changedFile.deletions = deletions;
    return changedFile;
  });
}

function parseManifest(value: unknown, manifestPath: string): BenchmarkManifest {
  if (!isRecord(value)) {
    throw new Error(`${manifestPath}: benchmark manifest must be an object.`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${manifestPath}: schemaVersion must be 1.`);
  }
  const scope = value.scope;
  if (scope !== undefined && scope !== "production" && scope !== "all") {
    throw new Error(`${manifestPath}: scope must be production or all.`);
  }
  const normalizedFixture = relativeCatalogPath(
    value.fixture,
    "fixture",
    manifestPath,
  );

  const manifest: BenchmarkManifest = {
    schemaVersion: 1,
    id: requiredString(value.id, "id", manifestPath),
    name: requiredString(value.name, "name", manifestPath),
    fixture: normalizedFixture,
    question: requiredString(value.question, "question", manifestPath),
    expected: labelsFrom(value.expected, manifestPath),
  };
  if (typeof value.description === "string" && value.description.trim()) {
    manifest.description = value.description.trim();
  }
  if (scope) manifest.scope = scope;
  const changedFiles = changedFilesFrom(value.changedFiles, manifestPath);
  if (changedFiles) manifest.changedFiles = changedFiles;
  return manifest;
}

async function findManifestPaths(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      discovered.push(...(await findManifestPaths(root, absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(MANIFEST_SUFFIX)) {
      discovered.push(absolutePath);
    }
  }
  return discovered.sort((left, right) =>
    path.relative(root, left).localeCompare(path.relative(root, right), "en"),
  );
}

/** Discover and validate every `*.benchmark.json` manifest below a catalog. */
export async function discoverBenchmarkCatalog(
  catalogRoot: string,
): Promise<BenchmarkCatalog> {
  const root = path.resolve(catalogRoot);
  const paths = await findManifestPaths(root);
  const cases: DiscoveredBenchmark[] = [];
  const ids = new Map<string, string>();
  for (const absoluteManifestPath of paths) {
    const manifestPath = path.relative(root, absoluteManifestPath).replaceAll("\\", "/");
    let source: string;
    try {
      source = await readFile(absoluteManifestPath, "utf8");
    } catch {
      throw new Error(`${manifestPath}: could not read benchmark manifest.`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${manifestPath}: could not parse benchmark JSON: ${detail}`);
    }
    const manifest = parseManifest(raw, manifestPath);
    const duplicate = ids.get(manifest.id);
    if (duplicate) {
      throw new Error(
        `${manifestPath}: benchmark id ${manifest.id} is already used by ${duplicate}.`,
      );
    }
    ids.set(manifest.id, manifestPath);
    cases.push({ absoluteManifestPath, manifestPath, manifest });
  }
  return { root, cases };
}

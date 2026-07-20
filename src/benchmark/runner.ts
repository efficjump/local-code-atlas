import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { analyzeLocalProject } from "../report/analyze.js";
import type { AtlasReport } from "../report/types.js";
import { discoverBenchmarkCatalog } from "./catalog.js";
import {
  aggregateMetrics,
  evaluateBenchmarkLabels,
} from "./metrics.js";
import {
  extractBenchmarkLabels,
  type ExtractBenchmarkLabelsOptions,
} from "./labels.js";
import {
  BENCHMARK_DIMENSIONS,
  type BenchmarkCaseResult,
  type BenchmarkDimensionMetrics,
  type BenchmarkManifest,
  type BenchmarkRunResult,
} from "./types.js";

const DEFAULT_LIMITS = {
  maxFiles: 2_000,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 25_000_000,
} as const;

type AnalyzeReport = typeof analyzeLocalProject;

export interface RunBenchmarkCatalogOptions {
  signal?: AbortSignal;
  now?: () => number;
  analyze?: AnalyzeReport;
  extractLabels?: (report: AtlasReport) => ReturnType<typeof extractBenchmarkLabels>;
  migrationLabels?: ExtractBenchmarkLabelsOptions["migration"];
}

function durationMs(start: number, end: number): number {
  return Math.round(Math.max(0, end - start) * 1_000) / 1_000;
}

function assertInsideCatalog(catalogRoot: string, candidate: string): void {
  const relative = path.relative(catalogRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Benchmark fixture resolves outside the catalog root.");
  }
}

async function resolveFixture(
  catalogRoot: string,
  manifest: BenchmarkManifest,
): Promise<string> {
  const candidate = path.resolve(catalogRoot, manifest.fixture);
  assertInsideCatalog(catalogRoot, candidate);
  let realCatalogRoot: string;
  let realFixture: string;
  try {
    [realCatalogRoot, realFixture] = await Promise.all([
      realpath(catalogRoot),
      realpath(candidate),
    ]);
  } catch {
    throw new Error(`${manifest.id}: fixture could not be resolved.`);
  }
  assertInsideCatalog(realCatalogRoot, realFixture);
  let fixtureIsDirectory = false;
  try {
    fixtureIsDirectory = (await stat(realFixture)).isDirectory();
  } catch {
    throw new Error(`${manifest.id}: fixture metadata could not be read.`);
  }
  if (!fixtureIsDirectory) {
    throw new Error(`${manifest.id}: fixture must resolve to a directory.`);
  }
  return realFixture;
}

function gitMetadataOverride(manifest: BenchmarkManifest) {
  return {
    isRepository: true,
    detached: false,
    dirty: (manifest.changedFiles?.length ?? 0) > 0,
    changedFiles: (manifest.changedFiles ?? []).map((change) => ({
      path: change.path.replaceAll("\\", "/"),
      previousPath: change.previousPath?.replaceAll("\\", "/"),
      status: change.status ?? "modified",
      staged: change.staged ?? false,
      unstaged: change.unstaged ?? true,
      additions: change.additions,
      deletions: change.deletions,
    })),
  };
}

function aggregateCaseDimensions(
  dimensions: BenchmarkDimensionMetrics,
) {
  return aggregateMetrics(
    BENCHMARK_DIMENSIONS.map((dimension) => ({
      namespace: dimension,
      metric: dimensions[dimension],
    })),
  );
}

/** Run discovered cases sequentially so ordering and resource use stay stable. */
export async function runBenchmarkCatalog(
  catalogRoot: string,
  options: RunBenchmarkCatalogOptions = {},
): Promise<BenchmarkRunResult> {
  const now = options.now ?? performance.now.bind(performance);
  const analyze = options.analyze ?? analyzeLocalProject;
  const runStartedAt = now();
  options.signal?.throwIfAborted();
  const catalog = await discoverBenchmarkCatalog(catalogRoot);
  const cases: BenchmarkCaseResult[] = [];

  for (const entry of catalog.cases) {
    options.signal?.throwIfAborted();
    const fixtureRoot = await resolveFixture(catalog.root, entry.manifest);
    const caseStartedAt = now();
    const report = await analyze(
      {
        root: fixtureRoot,
        publicPath: entry.manifest.fixture,
        question: entry.manifest.question,
        enableAi: false,
        checkDependencies: false,
        scope: entry.manifest.scope ?? "production",
        comparison: { mode: "working-tree" },
        gitMetadataOverride: gitMetadataOverride(entry.manifest),
        limits: DEFAULT_LIMITS,
      },
      options.signal,
    );
    options.signal?.throwIfAborted();
    const predicted = options.extractLabels
      ? options.extractLabels(report)
      : extractBenchmarkLabels(report, { migration: options.migrationLabels });
    const dimensions = evaluateBenchmarkLabels(
      entry.manifest.expected,
      predicted,
    );
    cases.push({
      id: entry.manifest.id,
      name: entry.manifest.name,
      ...(entry.manifest.description
        ? { description: entry.manifest.description }
        : {}),
      manifestPath: entry.manifestPath,
      fixturePath: entry.manifest.fixture,
      durationMs: durationMs(caseStartedAt, now()),
      partial: report.run.partial,
      dimensions,
      aggregate: aggregateCaseDimensions(dimensions),
    });
  }

  const dimensions = Object.fromEntries(
    BENCHMARK_DIMENSIONS.map((dimension) => [
      dimension,
      aggregateMetrics(
        cases.map((caseResult) => ({
          namespace: caseResult.id,
          metric: caseResult.dimensions[dimension],
        })),
      ),
    ]),
  ) as BenchmarkDimensionMetrics;
  const partialCaseCount = cases.filter((caseResult) => caseResult.partial).length;
  return {
    schemaVersion: 1,
    caseCount: cases.length,
    partial: partialCaseCount > 0,
    partialCaseCount,
    durationMs: durationMs(runStartedAt, now()),
    cases,
    dimensions,
    aggregate: aggregateMetrics(
      BENCHMARK_DIMENSIONS.map((dimension) => ({
        namespace: dimension,
        metric: dimensions[dimension],
      })),
    ),
  };
}

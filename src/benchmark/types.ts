import type { GitChangeStatus } from "../core/types.js";
import type { ProjectScope } from "../report/types.js";

export const BENCHMARK_DIMENSIONS = [
  "impact",
  "security",
  "schema",
  "migration",
] as const;

export type BenchmarkDimension = (typeof BENCHMARK_DIMENSIONS)[number];

export type BenchmarkLabels = Record<BenchmarkDimension, string[]>;

export interface BenchmarkChangedFile {
  path: string;
  previousPath?: string;
  status?: GitChangeStatus;
  staged?: boolean;
  unstaged?: boolean;
  additions?: number;
  deletions?: number;
}

/** A data-only benchmark case. Fixture paths are relative to the catalog root. */
export interface BenchmarkManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  fixture: string;
  question: string;
  scope?: ProjectScope;
  changedFiles?: BenchmarkChangedFile[];
  expected: BenchmarkLabels;
}

export interface DiscoveredBenchmark {
  /** Manifest path relative to the catalog root. */
  manifestPath: string;
  /** Absolute path retained only for local execution. */
  absoluteManifestPath: string;
  manifest: BenchmarkManifest;
}

export interface BenchmarkCatalog {
  /** Absolute local path; it is deliberately omitted from serialized run results. */
  root: string;
  cases: DiscoveredBenchmark[];
}

export interface BenchmarkMetric {
  expectedCount: number;
  predictedCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Null means the metric denominator is zero (N/A), not a perfect score. */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  truePositiveLabels: string[];
  falsePositiveLabels: string[];
  falseNegativeLabels: string[];
}

export type BenchmarkDimensionMetrics = Record<
  BenchmarkDimension,
  BenchmarkMetric
>;

export interface BenchmarkCaseResult {
  id: string;
  name: string;
  description?: string;
  manifestPath: string;
  fixturePath: string;
  durationMs: number;
  /** True when any analyzer stage could not establish complete coverage. */
  partial: boolean;
  dimensions: BenchmarkDimensionMetrics;
  aggregate: BenchmarkMetric;
}

export interface BenchmarkRunResult {
  schemaVersion: 1;
  caseCount: number;
  partial: boolean;
  partialCaseCount: number;
  durationMs: number;
  cases: BenchmarkCaseResult[];
  dimensions: BenchmarkDimensionMetrics;
  aggregate: BenchmarkMetric;
}

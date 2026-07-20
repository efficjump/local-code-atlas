import {
  BENCHMARK_DIMENSIONS,
  type BenchmarkDimensionMetrics,
  type BenchmarkLabels,
  type BenchmarkMetric,
} from "./types.js";

function sortedUnique(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right, "en"),
  );
}

function rounded(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Score one label set; a zero denominator is represented as null (N/A). */
export function evaluateLabelSet(
  expectedLabels: readonly string[],
  predictedLabels: readonly string[],
): BenchmarkMetric {
  const expected = sortedUnique(expectedLabels);
  const predicted = sortedUnique(predictedLabels);
  const expectedSet = new Set(expected);
  const predictedSet = new Set(predicted);
  const truePositiveLabels = predicted.filter((label) => expectedSet.has(label));
  const falsePositiveLabels = predicted.filter((label) => !expectedSet.has(label));
  const falseNegativeLabels = expected.filter((label) => !predictedSet.has(label));
  const precision =
    predicted.length === 0 ? null : truePositiveLabels.length / predicted.length;
  const recall =
    expected.length === 0 ? null : truePositiveLabels.length / expected.length;
  const f1Denominator =
    2 * truePositiveLabels.length +
    falsePositiveLabels.length +
    falseNegativeLabels.length;
  const f1 =
    f1Denominator === 0
      ? null
      : (2 * truePositiveLabels.length) / f1Denominator;

  return {
    expectedCount: expected.length,
    predictedCount: predicted.length,
    truePositives: truePositiveLabels.length,
    falsePositives: falsePositiveLabels.length,
    falseNegatives: falseNegativeLabels.length,
    precision: precision === null ? null : rounded(precision),
    recall: recall === null ? null : rounded(recall),
    f1: f1 === null ? null : rounded(f1),
    truePositiveLabels,
    falsePositiveLabels,
    falseNegativeLabels,
  };
}

export function evaluateBenchmarkLabels(
  expected: BenchmarkLabels,
  predicted: BenchmarkLabels,
): BenchmarkDimensionMetrics {
  return Object.fromEntries(
    BENCHMARK_DIMENSIONS.map((dimension) => [
      dimension,
      evaluateLabelSet(expected[dimension], predicted[dimension]),
    ]),
  ) as BenchmarkDimensionMetrics;
}

export interface NamespacedMetric {
  namespace: string;
  metric: BenchmarkMetric;
}

/** Merge confusion counts while retaining unambiguous, stable error labels. */
export function aggregateMetrics(
  entries: readonly NamespacedMetric[],
): BenchmarkMetric {
  const qualify = (namespace: string, label: string) =>
    namespace ? `${namespace}::${label}` : label;
  const truePositiveLabels = entries.flatMap(({ namespace, metric }) =>
    metric.truePositiveLabels.map((label) => qualify(namespace, label)),
  );
  const falsePositiveLabels = entries.flatMap(({ namespace, metric }) =>
    metric.falsePositiveLabels.map((label) => qualify(namespace, label)),
  );
  const falseNegativeLabels = entries.flatMap(({ namespace, metric }) =>
    metric.falseNegativeLabels.map((label) => qualify(namespace, label)),
  );
  const expectedCount = entries.reduce(
    (total, entry) => total + entry.metric.expectedCount,
    0,
  );
  const predictedCount = entries.reduce(
    (total, entry) => total + entry.metric.predictedCount,
    0,
  );
  const truePositives = truePositiveLabels.length;
  const precision =
    predictedCount === 0 ? null : truePositives / predictedCount;
  const recall = expectedCount === 0 ? null : truePositives / expectedCount;
  const f1Denominator =
    2 * truePositives + falsePositiveLabels.length + falseNegativeLabels.length;
  const f1 =
    f1Denominator === 0 ? null : (2 * truePositives) / f1Denominator;

  return {
    expectedCount,
    predictedCount,
    truePositives,
    falsePositives: falsePositiveLabels.length,
    falseNegatives: falseNegativeLabels.length,
    precision: precision === null ? null : rounded(precision),
    recall: recall === null ? null : rounded(recall),
    f1: f1 === null ? null : rounded(f1),
    truePositiveLabels: sortedUnique(truePositiveLabels),
    falsePositiveLabels: sortedUnique(falsePositiveLabels),
    falseNegativeLabels: sortedUnique(falseNegativeLabels),
  };
}

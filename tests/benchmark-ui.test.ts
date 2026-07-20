import assert from "node:assert/strict";
import test from "node:test";

import {
  benchmarkHealthUrlFor,
  benchmarkUrlFor,
  normalizeBenchmarkHealth,
  normalizeBenchmarkRun,
} from "../app/components/BenchmarkLab.js";

function metric(overrides: Record<string, unknown> = {}) {
  return {
    expectedCount: 1,
    predictedCount: 1,
    truePositives: 1,
    falsePositives: 0,
    falseNegatives: 0,
    precision: 1,
    recall: 1,
    f1: 1,
    truePositiveLabels: ["match"],
    falsePositiveLabels: [],
    falseNegativeLabels: [],
    ...overrides,
  };
}

function dimensions(overrides: Record<string, unknown> = {}) {
  return {
    impact: metric(),
    security: metric(),
    schema: metric(),
    migration: metric({
      expectedCount: 0,
      predictedCount: 0,
      truePositives: 0,
      precision: null,
      recall: null,
      f1: null,
      truePositiveLabels: [],
    }),
    ...overrides,
  };
}

function benchmarkPayload() {
  return {
    schemaVersion: 1,
    caseCount: 1,
    durationMs: 12.5,
    partial: false,
    partialCaseCount: 0,
    cases: [
      {
        id: "case-one",
        name: "Case one",
        manifestPath: "cases/case-one.benchmark.json",
        fixturePath: "fixtures/case-one",
        durationMs: 10,
        partial: false,
        dimensions: dimensions(),
        aggregate: metric({
          expectedCount: 3,
          predictedCount: 3,
          truePositives: 3,
          truePositiveLabels: ["impact::match", "schema::match", "security::match"],
        }),
      },
    ],
    dimensions: dimensions(),
    aggregate: metric({
      expectedCount: 3,
      predictedCount: 3,
      truePositives: 3,
      truePositiveLabels: ["impact::match", "schema::match", "security::match"],
    }),
  };
}

test("benchmark URLs stay on the configured local analyzer origin", () => {
  assert.equal(
    benchmarkUrlFor("http://127.0.0.1:4317/api/analyze?ignored=true"),
    "http://127.0.0.1:4317/api/benchmark",
  );
  assert.equal(
    benchmarkHealthUrlFor("http://127.0.0.1:4317/api/analyze"),
    "http://127.0.0.1:4317/api/health",
  );
});

test("benchmark health requires the local benchmark capability", () => {
  const health = normalizeBenchmarkHealth({
    service: "local-code-atlas-engine",
    status: "ok",
    version: "0.3.0",
    localOnly: true,
    allowedRootsConfigured: true,
    capabilities: { benchmark: true },
    external: { localByDefault: true },
  });
  assert.equal(health.capabilities.benchmark, true);
  assert.throws(
    () =>
      normalizeBenchmarkHealth({
        service: "local-code-atlas-engine",
        status: "ok",
        version: "0.3.0",
        localOnly: true,
        allowedRootsConfigured: true,
        capabilities: {},
        external: { localByDefault: true },
      }),
    /benchmark capability/u,
  );
});

test("benchmark normalization preserves N/A scores and explicit coverage", () => {
  const result = normalizeBenchmarkRun(benchmarkPayload());
  assert.equal(result.partial, false);
  assert.equal(result.partialCaseCount, 0);
  assert.equal(result.dimensions.migration.f1, null);
  assert.equal(result.cases[0]?.dimensions.impact.f1, 1);
});

test("benchmark normalization rejects missing or inconsistent coverage", () => {
  const missing = benchmarkPayload() as Record<string, unknown>;
  delete missing.partialCaseCount;
  assert.throws(
    () => normalizeBenchmarkRun(missing),
    /coverage metadata/u,
  );

  const inconsistent = benchmarkPayload();
  inconsistent.partial = true;
  assert.throws(
    () => normalizeBenchmarkRun(inconsistent),
    /inconsistent case coverage/u,
  );
});

test("benchmark normalization rejects impossible confusion counts", () => {
  const payload = benchmarkPayload();
  payload.dimensions.security = metric({
    predictedCount: 1,
    truePositives: 1,
    falsePositives: 1,
    falsePositiveLabels: ["unexpected"],
  });
  assert.throws(
    () => normalizeBenchmarkRun(payload),
    /inconsistent metric counts/u,
  );

  const dishonestScore = benchmarkPayload();
  dishonestScore.dimensions.security.precision = 0.5;
  assert.throws(
    () => normalizeBenchmarkRun(dishonestScore),
    /scores do not match/u,
  );

  const dishonestAggregate = benchmarkPayload();
  dishonestAggregate.aggregate.expectedCount = 4;
  dishonestAggregate.aggregate.truePositives = 4;
  dishonestAggregate.aggregate.predictedCount = 4;
  dishonestAggregate.aggregate.truePositiveLabels = [
    "impact::match",
    "schema::match",
    "security::match",
    "unexpected::match",
  ];
  assert.throws(
    () => normalizeBenchmarkRun(dishonestAggregate),
    /dimension totals/u,
  );
});

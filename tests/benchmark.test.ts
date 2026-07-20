import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  discoverBenchmarkCatalog,
  evaluateLabelSet,
  extractBenchmarkLabels,
  runBenchmarkCatalog,
} from "../src/benchmark/index.js";
import { classifySourceScope } from "../src/core/source-scope.js";
import { analyzeLocalProject } from "../src/report/analyze.js";

test("repository self-analysis classifies benchmark catalogs as fixtures", () => {
  assert.equal(
    classifySourceScope({ path: "benchmarks/fixtures/case/src/example.ts" }),
    "fixture",
  );
  assert.equal(
    classifySourceScope({ path: "packages/service/src/main.ts" }),
    "production",
  );
});
import type { AtlasReport } from "../src/report/types.js";

test("perfect label sets receive full precision, recall, and F1", () => {
  const metric = evaluateLabelSet(["alpha", "beta"], ["beta", "alpha"]);

  assert.equal(metric.truePositives, 2);
  assert.equal(metric.falsePositives, 0);
  assert.equal(metric.falseNegatives, 0);
  assert.equal(metric.precision, 1);
  assert.equal(metric.recall, 1);
  assert.equal(metric.f1, 1);
  assert.deepEqual(metric.truePositiveLabels, ["alpha", "beta"]);
});

test("unexpected labels are retained as false positives", () => {
  const metric = evaluateLabelSet(["expected"], ["expected", "unexpected"]);

  assert.equal(metric.truePositives, 1);
  assert.equal(metric.falsePositives, 1);
  assert.equal(metric.falseNegatives, 0);
  assert.equal(metric.precision, 0.5);
  assert.equal(metric.recall, 1);
  assert.equal(metric.f1, 0.666667);
  assert.deepEqual(metric.falsePositiveLabels, ["unexpected"]);
});

test("missing labels are retained as false negatives", () => {
  const metric = evaluateLabelSet(["found", "missing"], ["found"]);

  assert.equal(metric.truePositives, 1);
  assert.equal(metric.falsePositives, 0);
  assert.equal(metric.falseNegatives, 1);
  assert.equal(metric.precision, 1);
  assert.equal(metric.recall, 0.5);
  assert.equal(metric.f1, 0.666667);
  assert.deepEqual(metric.falseNegativeLabels, ["missing"]);
});

test("zero denominators are serialized as null rather than inflated scores", () => {
  const empty = evaluateLabelSet([], []);
  assert.deepEqual(
    { precision: empty.precision, recall: empty.recall, f1: empty.f1 },
    { precision: null, recall: null, f1: null },
  );

  const missed = evaluateLabelSet(["expected"], []);
  assert.deepEqual(
    { precision: missed.precision, recall: missed.recall, f1: missed.f1 },
    { precision: null, recall: 0, f1: 0 },
  );

  const unexpected = evaluateLabelSet([], ["unexpected"]);
  assert.deepEqual(
    {
      precision: unexpected.precision,
      recall: unexpected.recall,
      f1: unexpected.f1,
    },
    { precision: 0, recall: null, f1: 0 },
  );
});

test("migration risk labels participate in the migration-ready dimension", () => {
  const report = {
    impact: { findings: [] },
    security: { findings: [] },
    erd: { tables: [], relationships: [] },
    migration: {
      risks: [
        { label: "drop-column:records.legacy_value" },
        {
          category: "set-not-null",
          namespace: "main",
          table: "profiles",
          column: "display_name",
        },
      ],
    },
  } as unknown as AtlasReport;

  assert.deepEqual(extractBenchmarkLabels(report).migration, [
    "drop-column:records.legacy_value",
    "set-not-null:main.profiles.display_name",
  ]);
});

test("bundled manifests are discovered dynamically and run deterministically", async () => {
  const catalogRoot = resolve("benchmarks");
  const catalog = await discoverBenchmarkCatalog(catalogRoot);
  assert.deepEqual(
    catalog.cases.map((entry) => entry.manifestPath),
    [
      "cases/account-migration.benchmark.json",
      "cases/profile-format.benchmark.json",
      "cases/session-flow.benchmark.json",
    ],
  );

  const externalOptions: Array<{
    enableAi: boolean | undefined;
    checkDependencies: boolean | undefined;
  }> = [];
  const first = await runBenchmarkCatalog(catalogRoot, {
    now: () => 0,
    analyze: async (input, signal) => {
      externalOptions.push({
        enableAi: input.enableAi,
        checkDependencies: input.checkDependencies,
      });
      return analyzeLocalProject(input, signal);
    },
  });
  const second = await runBenchmarkCatalog(catalogRoot, { now: () => 0 });
  assert.deepEqual(externalOptions, [
    { enableAi: false, checkDependencies: false },
    { enableAi: false, checkDependencies: false },
    { enableAi: false, checkDependencies: false },
  ]);
  assert.deepEqual(second, first);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assert.equal(first.caseCount, 3);
  assert.equal(first.partial, false);
  assert.equal(first.partialCaseCount, 0);
  assert.ok(first.cases.every((caseResult) => !caseResult.partial));
  assert.equal(first.aggregate.falsePositives, 2);
  assert.equal(first.aggregate.falseNegatives, 0);
  assert.equal(first.aggregate.f1, 0.971429);
  assert.equal(first.dimensions.migration.f1, 1);
  assert.deepEqual(first.dimensions.schema.falsePositiveLabels, [
    "account-migration::column:accounts.legacy_code",
  ]);
  assert.equal(JSON.stringify(first).includes(catalogRoot), false);
});

test("catalog discovery rejects fixture paths that escape the catalog", async (context) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), "benchmark-catalog-"));
  context.after(() => rm(catalogRoot, { recursive: true, force: true }));
  await mkdir(join(catalogRoot, "cases"));
  await writeFile(
    join(catalogRoot, "cases", "escape.benchmark.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "escape",
      name: "Escaping fixture",
      fixture: "../outside",
      question: "Which files are affected?",
      expected: { impact: [], security: [], schema: [], migration: [] },
    }),
  );

  await assert.rejects(
    discoverBenchmarkCatalog(catalogRoot),
    /fixture must be a contained relative path/u,
  );
});

test("benchmark results preserve partial analyzer coverage", async (context) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), "benchmark-catalog-"));
  context.after(() => rm(catalogRoot, { recursive: true, force: true }));
  await mkdir(join(catalogRoot, "cases"));
  await mkdir(join(catalogRoot, "fixtures", "oversized", "src"), {
    recursive: true,
  });
  await writeFile(
    join(catalogRoot, "fixtures", "oversized", "src", "oversized.ts"),
    "x".repeat(1_000_001),
  );
  await writeFile(
    join(catalogRoot, "cases", "oversized.benchmark.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "oversized",
      name: "Oversized source",
      fixture: "fixtures/oversized",
      question: "Which source is affected?",
      expected: { impact: [], security: [], schema: [], migration: [] },
    }),
  );

  const result = await runBenchmarkCatalog(catalogRoot, { now: () => 0 });
  assert.equal(result.partial, true);
  assert.equal(result.partialCaseCount, 1);
  assert.equal(result.cases[0]?.partial, true);
});

test("benchmark execution rejects a fixture symlink outside the catalog", async (context) => {
  const catalogRoot = await mkdtemp(join(tmpdir(), "benchmark-catalog-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "benchmark-outside-"));
  context.after(async () => {
    await Promise.all([
      rm(catalogRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });
  await mkdir(join(catalogRoot, "cases"));
  await mkdir(join(catalogRoot, "fixtures"));
  await symlink(outsideRoot, join(catalogRoot, "fixtures", "linked"), "dir");
  await writeFile(
    join(catalogRoot, "cases", "linked.benchmark.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "linked",
      name: "Linked fixture",
      fixture: "fixtures/linked",
      question: "Which files are affected?",
      expected: { impact: [], security: [], schema: [], migration: [] },
    }),
  );

  await assert.rejects(
    runBenchmarkCatalog(catalogRoot),
    /fixture resolves outside the catalog root/u,
  );
});

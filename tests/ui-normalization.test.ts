import assert from "node:assert/strict";
import test from "node:test";
import {
  buildErdGraphLayout,
  healthUrlFor,
  normalizeAtlasAnalysis,
  normalizeAtlasApiError,
  normalizeAtlasHealth,
  relativeRelevanceLabel,
} from "../app/components/AtlasWorkbench.js";

function minimalReport() {
  return {
    id: "analysis-1",
    generatedAt: "2026-07-20T00:00:00.000Z",
    project: {
      name: "sample",
      path: "/projects/sample",
      rootKind: "Local directory",
      files: 2,
      lines: 10,
      languages: [],
      frameworks: [],
    },
    impact: {
      question: "What changes?",
      findings: [{ file: "src/index.ts", score: 75, reason: "Symbol match" }],
      suggestedTests: [],
    },
    security: {
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      findings: [],
      dependencies: { total: 0, exact: 0, eligibleForAdvisoryLookup: 0, ecosystems: {} },
    },
    erd: { tables: [], relationships: [] },
    ai: { enabled: false },
    run: {
      scope: "production",
      partial: false,
      stages: [{ id: "index", status: "complete", detail: "Indexed 2 files." }],
    },
    external: {
      localByDefault: true,
      osv: {
        requested: false,
        requestAttempted: false,
        status: "not-requested",
        wouldTransmit: ["package name"],
        transmitted: [],
      },
      ai: {
        requested: false,
        configured: false,
        requestAttempted: false,
        status: "not-requested",
        wouldTransmit: ["question"],
        transmitted: [],
      },
    },
  };
}

test("workbench rejects an incomplete 200 response instead of assuming a clean scan", () => {
  assert.throws(
    () => normalizeAtlasAnalysis({ project: { name: "partial" } }),
    /incomplete evidence contract/u,
  );
});

test("workbench normalizes an empty result only with explicit coverage metadata", () => {
  const analysis = normalizeAtlasAnalysis(minimalReport());

  assert.equal(analysis.project.name, "sample");
  assert.equal(analysis.impact.findings[0].score, 0.75);
  assert.deepEqual(analysis.security.findings, []);
  assert.deepEqual(analysis.erd.tables, []);
});

test("workbench preserves trust metadata without deriving ERD origin from confidence", () => {
  const base = minimalReport();
  const analysis = normalizeAtlasAnalysis({
    ...base,
    project: {
      ...base.project,
      name: "trust-sample",
      git: {
        branch: "feature/trust",
        comparison: { mode: "base", base: "main", label: "main...HEAD" },
        changes: [
          {
            path: "src/session.ts",
            status: "modified",
            staged: true,
            unstaged: false,
            additions: 4,
            deletions: 1,
          },
        ],
      },
    },
    impact: {
      ...base.impact,
      findings: [
        {
          file: "src/session.ts",
          score: 82,
          changed: true,
          graphDistance: 0,
          relevance: "direct",
        },
      ],
    },
    security: {
      ...base.security,
      findings: [
        {
          id: "finding-1",
          title: "Example-only finding",
          severity: "high",
          category: "configuration",
          file: "examples/demo.ts",
          confidence: 0.91,
          scope: "example",
          sourceKind: "source",
          relevance: "project",
        },
      ],
      dependencies: { total: 4, ecosystems: { npm: 4 } },
    },
    erd: {
      tables: [
        { name: "users", sourceFile: "schema.sql", relevance: "direct", columns: [] },
        { name: "sessions", sourceFile: "schema.sql", relevance: "indirect", columns: [] },
      ],
      relationships: [
        {
          fromTable: "sessions",
          fromColumn: "user_id",
          toTable: "users",
          toColumn: "id",
          confidence: 0.99,
          origin: "declared",
          relevance: "direct",
        },
        {
          fromTable: "sessions",
          fromColumn: "owner_id",
          toTable: "users",
          toColumn: "id",
          confidence: 1,
          source: "inferred · schema.sql:9",
        },
      ],
    },
    run: {
      scope: "production",
      partial: true,
      stages: [
        { id: "security", status: "partial", detail: "One source was skipped", analyzed: 8, skipped: 1 },
      ],
    },
    external: {
      localByDefault: true,
      osv: {
        requested: true,
        status: "complete",
        queriedPackages: 3,
        eligiblePackages: 4,
        requestAttempted: true,
        wouldTransmit: ["package names", "exact versions"],
        transmitted: ["package names", "exact versions"],
      },
      ai: {
        requested: false,
        configured: true,
        requestAttempted: false,
        status: "not-requested",
        wouldTransmit: ["question"],
        transmitted: [],
      },
    },
  });

  assert.equal(analysis.project.git?.changes[0].staged, true);
  assert.equal(analysis.project.git?.comparison?.label, "main...HEAD");
  assert.equal(analysis.security.findings[0].scope, "example");
  assert.equal(analysis.security.findings[0].relevance, "project");
  assert.equal(analysis.erd.relationships[0].origin, "declared");
  assert.equal(analysis.erd.relationships[1].origin, "inferred");
  assert.equal(analysis.run.partial, true);
  assert.equal(analysis.external.osv.queriedPackages, 3);

  const graph = buildErdGraphLayout(analysis.erd.tables, analysis.erd.relationships);
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 2);
  assert.equal(graph.edges[0].relationship.origin, "declared");
});

test("workbench normalizes typed errors, health URLs, and relative ranking labels", () => {
  assert.deepEqual(
    normalizeAtlasApiError(
      {
        error: {
          code: "PATH_OUTSIDE_ALLOWED_ROOTS",
          message: "Path is not allowed.",
          requestId: "request-123",
        },
      },
      400,
    ),
    {
      code: "PATH_OUTSIDE_ALLOWED_ROOTS",
      message: "Path is not allowed.",
      requestId: "request-123",
    },
  );
  assert.equal(
    healthUrlFor("http://127.0.0.1:4317/api/analyze"),
    "http://127.0.0.1:4317/api/health",
  );
  assert.equal(relativeRelevanceLabel(0.61, 0.7), "Strongly related");
  assert.equal(relativeRelevanceLabel(0.2, 0.7), "Exploratory");

  const health = normalizeAtlasHealth({
    service: "local-code-atlas-engine",
    status: "ok",
    version: "0.2.0",
    localOnly: true,
    allowedRootsConfigured: true,
    external: {
      localByDefault: true,
      osv: { available: true, wouldTransmit: ["package name"] },
      ai: {
        configured: true,
        endpointOrigin: "https://models.example.test",
        wouldTransmit: ["project name", "question"],
      },
    },
  });
  assert.equal(health.external.ai.endpointOrigin, "https://models.example.test");
  assert.deepEqual(health.external.ai.wouldTransmit, ["project name", "question"]);
  assert.throws(
    () => normalizeAtlasHealth({ status: "ok" }),
    /unrecognized health contract/u,
  );
});

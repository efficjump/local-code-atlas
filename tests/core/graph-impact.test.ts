import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  analyzeLocalProject,
  extractCodeGraph,
  rankChangeImpact,
  scanProject,
  toPublicLocalProjectAnalysis,
} from "../../src/core/index";

const fixtureRoot = fileURLToPath(new URL("./fixtures/sample-project", import.meta.url));

test("graph resolves aliases and records symbol/call evidence", async () => {
  const scan = await scanProject(fixtureRoot);
  const graph = await extractCodeGraph(scan);
  const serviceFile = graph.nodes.find(
    (node) => node.type === "file" && node.path === "src/user/service.cts",
  );
  const apiFile = graph.nodes.find(
    (node) => node.type === "file" && node.path === "src/api.cts",
  );
  const symbol = graph.nodes.find(
    (node) => node.type === "symbol" && node.name === "deactivateUser",
  );

  assert.ok(serviceFile);
  assert.ok(apiFile);
  assert.ok(symbol);
  assert.ok(
    graph.edges.some(
      (edge) => edge.kind === "imports" && edge.source === apiFile.id && edge.target === serviceFile.id,
    ),
  );
  assert.ok(
    graph.edges.some(
      (edge) => edge.kind === "calls" && edge.source === apiFile.id && edge.target === symbol.id,
    ),
  );
});

test("impact ranking propagates to dependents and suggests related tests", async () => {
  const scan = await scanProject(fixtureRoot);
  const graph = await extractCodeGraph(scan);
  const impact = await rankChangeImpact({
    question: "deactivate user behavior",
    semanticTerms: ["deactivateUser"],
    scan,
    graph,
  });

  assert.equal(impact.candidates[0]?.path, "src/user/service.cts");
  assert.ok(impact.candidates.some((candidate) => candidate.path === "src/api.cts"));
  assert.ok(
    impact.suggestedTests.some(
      (suggestion) => suggestion.kind === "existing" && suggestion.path === "tests/user/service.test.cts",
    ),
  );
  assert.ok(impact.candidates[0]?.evidence.some((evidence) => evidence.location.line > 1));
});

test("evidence excerpts redact sensitive assignments", async () => {
  const analysis = await analyzeLocalProject(fixtureRoot, {
    question: "password variable",
  });
  const serialized = JSON.stringify(analysis.impact);

  assert.ok(serialized.includes("[REDACTED]"));
  assert.ok(!serialized.includes("fixture-value-that-must-be-redacted"));

  const publicAnalysis = JSON.stringify(toPublicLocalProjectAnalysis(analysis));
  assert.ok(!publicAnalysis.includes(fixtureRoot));
  assert.ok(!publicAnalysis.includes("absolutePath"));
});

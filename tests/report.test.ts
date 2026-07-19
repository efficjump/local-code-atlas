import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { analyzeLocalProject } from "../src/report/analyze.js";

test("bundled sample produces linked impact, security, and schema evidence", async () => {
  const report = await analyzeLocalProject({
    root: resolve("examples/sample-project"),
    publicPath: "Bundled sample",
    question:
      "If session expiration changes, what code, tests, risks, and tables are affected?",
    enableAi: false,
    checkDependencies: false,
    limits: {
      maxFiles: 1_000,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
    },
  });

  assert.equal(report.project.name, "atlas-sample-service");
  assert.equal(report.project.path, "Bundled sample");
  assert.ok(report.impact.findings.some((finding) => finding.file.includes("session")));
  assert.ok(report.security.findings.length >= 1);
  assert.ok(report.erd.tables.some((table) => table.name === "users"));
  assert.ok(
    report.erd.relationships.some(
      (relationship) =>
        relationship.fromTable === "sessions" &&
        relationship.toTable === "users" &&
        relationship.origin === "declared",
    ),
  );
  assert.equal(report.run.scope, "production");
  assert.equal(report.run.stages.find((stage) => stage.id === "security")?.status, "complete");
  assert.equal(report.external.osv.status, "not-requested");
  assert.equal(report.external.osv.requestAttempted, false);
  assert.deepEqual(report.external.osv.transmitted, []);
  assert.ok(report.external.osv.wouldTransmit.includes("exact version"));
  assert.equal(report.external.ai.requestAttempted, false);
  assert.deepEqual(report.external.ai.transmitted, []);
  assert.ok(report.external.ai.wouldTransmit.includes("project name"));
  assert.equal(report.project.git?.comparison.mode, "working-tree");
  assert.ok(
    report.security.findings.every(
      (finding) => finding.scope === "production" || finding.scope === "configuration",
    ),
  );
  assert.equal(report.ai.enabled, false);
  assert.doesNotMatch(JSON.stringify(report.security), /SELECT \* FROM sessions/u);
});

test("report ERD keeps namespace-qualified identities across tables, edges, and foreign keys", async (context) => {
  const root = await mkdtemp(join(os.tmpdir(), "local-code-atlas-report-erd-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "schemas"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "qualified-schema-project", private: true }),
    ),
    writeFile(
      join(root, "schemas", "auth.sql"),
      [
        "CREATE TABLE auth.users (id UUID PRIMARY KEY);",
        "CREATE TABLE auth.sessions (",
        "  id UUID PRIMARY KEY,",
        "  user_id UUID NOT NULL REFERENCES auth.users(id)",
        ");",
      ].join("\n"),
    ),
    writeFile(
      join(root, "schemas", "billing.sql"),
      [
        "CREATE TABLE billing.users (id UUID PRIMARY KEY);",
        "CREATE TABLE billing.invoices (",
        "  id UUID PRIMARY KEY,",
        "  user_id UUID NOT NULL REFERENCES billing.users(id)",
        ");",
      ].join("\n"),
    ),
  ]);

  const report = await analyzeLocalProject({
    root,
    publicPath: "Qualified schema fixture",
    question: "How do billing invoices connect to billing users?",
    enableAi: false,
    checkDependencies: false,
    limits: {
      maxFiles: 100,
      maxFileBytes: 100_000,
      maxTotalBytes: 1_000_000,
    },
  });

  assert.deepEqual(
    report.erd.tables.map((table) => table.name).sort(),
    ["auth.sessions", "auth.users", "billing.invoices", "billing.users"],
  );
  assert.ok(
    report.erd.relationships.some(
      (relationship) =>
        relationship.fromTable === "auth.sessions" &&
        relationship.toTable === "auth.users",
    ),
  );
  assert.ok(
    report.erd.relationships.some(
      (relationship) =>
        relationship.fromTable === "billing.invoices" &&
        relationship.toTable === "billing.users",
    ),
  );
  assert.equal(
    report.erd.tables
      .find((table) => table.name === "auth.sessions")
      ?.columns.find((column) => column.name === "user_id")
      ?.foreignKey?.table,
    "auth.users",
  );
  assert.equal(
    report.erd.tables
      .find((table) => table.name === "billing.invoices")
      ?.columns.find((column) => column.name === "user_id")
      ?.foreignKey?.table,
    "billing.users",
  );
});

test("all-scope reports preserve non-production security source scopes", async (context) => {
  const root = await mkdtemp(join(os.tmpdir(), "local-code-atlas-report-scope-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const scopedDirectories = ["fixtures", "docs", "generated", "vendor"] as const;
  await Promise.all(
    scopedDirectories.map((directory) =>
      mkdir(join(root, directory), { recursive: true }),
    ),
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "all-scope-project", private: true }),
  );
  await Promise.all(
    scopedDirectories.map((directory) =>
      writeFile(
        join(root, directory, "transport.ts"),
        "export const transport = { rejectUnauthorized: false };\n",
      ),
    ),
  );

  const report = await analyzeLocalProject({
    root,
    publicPath: "All-scope fixture",
    question: "Which transport settings are unsafe?",
    scope: "all",
    enableAi: false,
    checkDependencies: false,
    limits: {
      maxFiles: 100,
      maxFileBytes: 100_000,
      maxTotalBytes: 1_000_000,
    },
  });
  const scopeByFile = new Map(
    report.security.findings.map((finding) => [finding.file, finding.scope]),
  );
  assert.equal(scopeByFile.get("fixtures/transport.ts"), "fixture");
  assert.equal(scopeByFile.get("docs/transport.ts"), "documentation");
  assert.equal(scopeByFile.get("generated/transport.ts"), "generated");
  assert.equal(scopeByFile.get("vendor/transport.ts"), "vendor");
});

test("report scans eligible secret files and marks oversized analyzer inputs partial", async (context) => {
  const root = await mkdtemp(join(os.tmpdir(), "local-code-atlas-report-coverage-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "coverage-project",
        private: true,
        dependencies: { "range-only-package": "^1.0.0" },
      }),
    ),
    writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({
        name: "coverage-project",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "range-only-package": "^1.0.0" } },
          "node_modules/range-only-package": {
            version: "1.2.3",
            padding: "x".repeat(2_000),
          },
        },
      }),
    ),
    writeFile(
      join(root, ".env.production"),
      "SERVICE_TOKEN=super-secret-value-123\n",
    ),
    writeFile(
      join(root, "src", "oversized.ts"),
      `export const oversized = "${"x".repeat(2_000)}";\n`,
    ),
  ]);

  const report = await analyzeLocalProject({
    root,
    publicPath: "Coverage fixture",
    question: "What is affected by the oversized source?",
    enableAi: false,
    checkDependencies: true,
    limits: {
      maxFiles: 100,
      maxFileBytes: 1_024,
      maxTotalBytes: 100_000,
    },
  });

  assert.ok(
    report.security.findings.some(
      (finding) =>
        finding.file === ".env.production" &&
        finding.category === "exposed-secret",
    ),
  );
  assert.doesNotMatch(JSON.stringify(report), /super-secret-value-123/u);
  assert.equal(report.run.partial, true);
  assert.equal(
    report.run.stages.find((stage) => stage.id === "impact")?.status,
    "partial",
  );
  assert.equal(
    report.run.stages.find((stage) => stage.id === "security")?.status,
    "partial",
  );
  assert.equal(
    report.run.stages.find((stage) => stage.id === "schema")?.status,
    "partial",
  );
  assert.equal(
    report.run.stages.find((stage) => stage.id === "dependencies")?.status,
    "partial",
  );
  assert.equal(report.external.osv.requestAttempted, false);
  assert.ok(
    report.diagnostics.some(
      (diagnostic) =>
        diagnostic.includes("src/oversized.ts") &&
        diagnostic.includes("per-file limit"),
    ),
  );
});

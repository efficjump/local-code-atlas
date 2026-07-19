import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverProject, scanProject, toPublicScanResult } from "../../src/core/index";

const fixtureRoot = fileURLToPath(new URL("./fixtures/sample-project", import.meta.url));

test("scanner applies ignore rules, protects secret files, and returns stable paths", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-atlas-scan-"));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.cp(fixtureRoot, temporaryRoot, { recursive: true });
  await fs.writeFile(path.join(temporaryRoot, "ignored/drop.cts"), "ignored fixture\n");
  await fs.writeFile(path.join(temporaryRoot, "src/drop.generated.cts"), "ignored fixture\n");
  const scan = await scanProject(temporaryRoot);
  const paths = scan.files.map((file) => file.path);

  assert.ok(paths.includes("ignored/keep.cts"));
  assert.ok(paths.includes("src/keep.generated.cts"));
  assert.ok(paths.includes(".env.example"));
  assert.ok(!paths.includes("ignored/drop.cts"));
  assert.ok(!paths.includes("src/drop.generated.cts"));
  assert.ok(!paths.includes("id_ed25519"));
  assert.deepEqual(paths, [...paths].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })));
  assert.ok(toPublicScanResult(scan).files.every((file) => !("absolutePath" in file)));
});

test("scanner enforces file and cumulative-byte budgets deterministically", async () => {
  const fileLimited = await scanProject(fixtureRoot, { maxFiles: 2 });
  assert.equal(fileLimited.files.length, 2);
  assert.equal(fileLimited.truncated, true);
  assert.ok(fileLimited.warnings.some((warning) => warning.code === "limit-reached"));

  const byteLimited = await scanProject(fixtureRoot, { maxTotalBytes: 1_024 });
  assert.equal(byteLimited.truncated, true);
  assert.ok(byteLimited.stats.totalBytes <= 1_024);
});

test("discovery summarizes languages and framework evidence without versions", async () => {
  const scan = await scanProject(fixtureRoot);
  const discovery = await discoverProject(scan);

  assert.equal(discovery.name, "sample-local-atlas-project");
  assert.equal(discovery.languages[0]?.id, "typescript");
  assert.ok(discovery.frameworks.some((framework) => framework.id === "nextjs"));
  assert.ok(discovery.frameworks.some((framework) => framework.id === "drizzle"));
  assert.ok(discovery.frameworks.some((framework) => framework.id === "vitest"));
  assert.deepEqual(
    discovery.manifests.find((manifest) => manifest.path === "package.json")?.dependencyNames,
    ["drizzle-orm", "next", "react", "vitest"],
  );
  assert.ok(!JSON.stringify(discovery).includes("workspace-compatible-version"));
});

test("discovery prefers a root manifest and excludes non-production evidence by default", async (context) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "local-code-atlas-monorepo-"));
  context.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporaryRoot, "examples", "demo"), { recursive: true });
  await fs.mkdir(path.join(temporaryRoot, "tests", "fixtures", "application"), { recursive: true });
  await fs.mkdir(path.join(temporaryRoot, "packages", "api"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(temporaryRoot, "package.json"),
      JSON.stringify({ name: "root-workspace", dependencies: { react: "19.0.0" } }),
    ),
    fs.writeFile(
      path.join(temporaryRoot, "examples", "demo", "package.json"),
      JSON.stringify({ name: "nested-demo", dependencies: { express: "5.0.0" } }),
    ),
    fs.writeFile(
      path.join(temporaryRoot, "tests", "fixtures", "application", "package.json"),
      JSON.stringify({ name: "nested-fixture", dependencies: { next: "15.0.0" } }),
    ),
    fs.writeFile(
      path.join(temporaryRoot, "packages", "api", "package.json"),
      JSON.stringify({ name: "api-package", dependencies: { fastify: "5.0.0" } }),
    ),
  ]);

  const scan = await scanProject(temporaryRoot);
  assert.equal(
    scan.files.find((file) => file.path === "examples/demo/package.json")?.sourceScope,
    "example",
  );
  assert.equal(
    scan.files.find((file) => file.path === "tests/fixtures/application/package.json")?.sourceScope,
    "fixture",
  );
  assert.equal(
    scan.files.find((file) => file.path === "packages/api/package.json")?.sourceScope,
    "production",
  );

  const production = await discoverProject(scan);
  assert.equal(production.name, "root-workspace");
  assert.deepEqual(
    production.manifests.map((manifest) => manifest.path),
    ["package.json", "packages/api/package.json"],
  );
  assert.ok(production.frameworks.some((framework) => framework.id === "react"));
  assert.ok(production.frameworks.some((framework) => framework.id === "fastify"));
  assert.equal(production.frameworks.some((framework) => framework.id === "express"), false);
  assert.equal(production.frameworks.some((framework) => framework.id === "nextjs"), false);
  const reactEvidence = production.frameworks
    .find((framework) => framework.id === "react")
    ?.evidence.find((evidence) => evidence.kind === "dependency");
  assert.equal(reactEvidence?.path, "package.json");
  assert.equal(reactEvidence?.sourceScope, "production");

  const all = await discoverProject(scan, { sourceScope: "all" });
  assert.equal(all.name, "root-workspace");
  assert.ok(all.manifests.some((manifest) => manifest.path === "examples/demo/package.json"));
  assert.ok(all.frameworks.some((framework) => framework.id === "express"));
  assert.ok(all.frameworks.some((framework) => framework.id === "nextjs"));
});

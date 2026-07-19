import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  analyzeSecurity,
  type AnalysisFile,
} from "../../src/analyzers/index.js";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "dependency-locks",
);

test("package-lock resolves direct ranges and inventories transitive packages", async () => {
  const result = await analyzeSecurity(await fixtureFiles("package-lock"), {
    sourceScope: "all",
  });
  const dependencies = byName(result.dependencies);

  assert.equal(dependencies.get("runtime-library")?.versionSpec, "1.4.2");
  assert.equal(dependencies.get("runtime-library")?.pinning, "exact");
  assert.equal(dependencies.get("runtime-library")?.declaredVersionSpec, "^1.0.0");
  assert.equal(dependencies.get("runtime-library")?.direct, true);
  assert.equal(dependencies.get("runtime-library")?.resolutionSource, "lockfile");
  assert.match(
    dependencies.get("runtime-library")?.provenance.path ?? "",
    /package-lock\.json$/u,
  );

  assert.equal(dependencies.get("development-library")?.scope, "development");
  assert.equal(dependencies.get("transitive-library")?.versionSpec, "3.1.4");
  assert.equal(dependencies.get("transitive-library")?.direct, false);
  assert.equal(dependencies.get("transitive-library")?.scope, "transitive");
  assert.equal(result.dependencies.length, 3);
});

test("pnpm lock importers retain declared risk while exposing exact resolutions", async () => {
  const result = await analyzeSecurity(await fixtureFiles("pnpm"), {
    sourceScope: "all",
  });
  const dependencies = byName(result.dependencies);

  const scoped = dependencies.get("@scope/runtime-library");
  assert.equal(scoped?.versionSpec, "1.4.2");
  assert.equal(scoped?.declaredVersionSpec, "^1.0.0");
  assert.equal(scoped?.direct, true);

  const movingTool = dependencies.get("moving-tool");
  assert.equal(movingTool?.versionSpec, "2.0.1");
  assert.equal(movingTool?.pinning, "exact");
  assert.equal(movingTool?.declaredPinning, "floating");
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.ruleId === "dependency.floating-version" &&
        finding.title.includes("moving-tool"),
    ),
  );

  assert.equal(dependencies.get("transitive-library")?.direct, false);
  assert.equal(result.dependencies.length, 3);
});

test("Yarn v1 selectors map manifest dependencies to locked versions", async () => {
  const result = await analyzeSecurity(await fixtureFiles("yarn"), {
    sourceScope: "all",
  });
  const dependencies = byName(result.dependencies);

  assert.deepEqual(
    [...dependencies.values()].map((dependency) => [
      dependency.name,
      dependency.versionSpec,
      dependency.direct,
    ]),
    [
      ["direct-library", "1.3.0", true],
      ["transitive-library", "4.2.1", false],
    ],
  );
  assert.equal(dependencies.get("direct-library")?.declaredVersionSpec, "^1.0.0");
});

test("a manifest without a lockfile reports declarations without inventing versions", async () => {
  const result = await analyzeSecurity(await fixtureFiles("no-lock"), {
    sourceScope: "all",
  });
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0].versionSpec, "^5.0.0");
  assert.equal(result.dependencies[0].pinning, "range");
  assert.equal(result.dependencies[0].resolutionSource, "manifest");
  assert.equal(result.dependencies[0].lockfilePath, undefined);
});

test("a malformed selected lockfile falls back to the manifest safely", async () => {
  const result = await analyzeSecurity(await fixtureFiles("malformed"), {
    sourceScope: "all",
  });
  assert.equal(result.dependencies.length, 1);
  assert.equal(result.dependencies[0].name, "fallback-library");
  assert.equal(result.dependencies[0].versionSpec, "^6.0.0");
  assert.equal(result.dependencies[0].resolutionSource, "manifest");
  assert.match(result.dependencies[0].provenance.path, /package\.json$/u);
});

function byName(
  dependencies: Awaited<ReturnType<typeof analyzeSecurity>>["dependencies"],
) {
  return new Map(dependencies.map((dependency) => [dependency.name, dependency]));
}

async function fixtureFiles(directory: string): Promise<AnalysisFile[]> {
  const directoryPath = path.join(fixtureRoot, directory);
  const names = (await readdir(directoryPath)).sort();
  return Promise.all(
    names.map(async (name) => ({
      path: `fixtures/dependency-locks/${directory}/${name}`,
      content: await readFile(path.join(directoryPath, name), "utf8"),
    })),
  );
}

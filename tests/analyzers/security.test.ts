import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AnalyzerRegistry,
  analyzeSecurity,
  type AnalysisFile,
  type FileAnalyzer,
  type SecurityObservation,
} from "../../src/analyzers";

const fixtureRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "security",
);

test("security analysis redacts secret values and keeps exact provenance", async () => {
  const syntheticVendorToken = ["gh", `p_${"A".repeat(40)}`].join("");
  const files = (
    await fixtureFiles([
      "secrets-and-risks.ts",
      "synthetic-environment.fixture",
      "package.json",
    ])
  ).map((file) => ({
    ...file,
    content: file.content.replace(
      "__SYNTHETIC_VENDOR_TOKEN__",
      syntheticVendorToken,
    ),
  }));
  const result = await analyzeSecurity(files, { sourceScope: "all" });

  const secretFindings = result.findings.filter(
    (finding) => finding.category === "exposed-secret",
  );
  assert.equal(secretFindings.length, 2);
  assert.ok(
    secretFindings.every((finding) =>
      finding.evidence.redactedValue?.startsWith("[REDACTED:"),
    ),
  );

  const serialized = JSON.stringify(result);
  assert.equal(
    serialized.includes(syntheticVendorToken),
    false,
  );
  assert.equal(serialized.includes("synthetic-password-value"), false);
  assert.equal(serialized.includes("${SERVICE_TOKEN}"), false);
  assert.equal(serialized.includes("sha256:"), false);

  const token = secretFindings.find(
    (finding) => finding.ruleId === "signature.github-token",
  );
  assert.equal(token?.evidence.provenance.range.start.line, 1);
  assert.ok(token?.evidence.provenance.range.start.column ?? 0 > 1);

  assert.ok(
    result.findings.some((finding) => finding.ruleId === "tls-verification-disabled"),
  );
  assert.ok(
    result.findings.some((finding) => finding.ruleId === "sql-string-interpolation"),
  );
});

test("dependency manifests produce inventory and bounded supply-chain claims", async () => {
  const result = await analyzeSecurity(await fixtureFiles(["package.json"]), {
    sourceScope: "all",
  });

  assert.deepEqual(
    result.dependencies.map((dependency) => [
      dependency.name,
      dependency.pinning,
    ]),
    [
      ["exact-library", "exact"],
      ["floating-library", "floating"],
      ["mutable-library", "source"],
      ["range-library", "range"],
    ],
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.ruleId === "dependency.floating-version",
    ),
  );
  assert.ok(
    result.findings.some(
      (finding) => finding.ruleId === "dependency.mutable-source",
    ),
  );
  assert.equal(
    result.findings.some((finding) => /known vulnerability|CVE-/i.test(finding.title)),
    false,
  );
});

test("the registry selects analyzers by discovered file content and supports extensions", async () => {
  const custom: FileAnalyzer<SecurityObservation> = {
    id: "test.custom",
    domain: "security",
    supports: (file) => file.content.includes("custom-marker"),
    analyze: () => [],
  };
  const registry = new AnalyzerRegistry<SecurityObservation>("security").register(
    custom,
  );
  const run = await registry.run([
    { path: "a.txt", content: "custom-marker" },
    { path: "b.txt", content: "ordinary" },
  ]);
  assert.deepEqual(run.executions[0]?.matchedFiles, ["a.txt"]);
});

test("source offsets remain valid for CRLF input", async () => {
  const rawSecret = "another-synthetic-secret";
  const content = `const ordinary = true;\r\nconst apiKey = "${rawSecret}";\r\n`;
  const result = await analyzeSecurity([{ path: "config.ts", content }]);
  const finding = result.findings.find(
    (candidate) => candidate.category === "exposed-secret",
  );

  assert.equal(finding?.evidence.provenance.range.start.offset, content.indexOf(rawSecret));
  assert.equal(finding?.evidence.provenance.range.start.line, 2);
  assert.equal(JSON.stringify(result).includes(rawSecret), false);
});

test("production scope excludes test, fixture, example, documentation, generated, and vendor findings", async () => {
  const insecureSource = "const options = { rejectUnauthorized: false };";
  const files: AnalysisFile[] = [
    { path: "src/client.ts", content: insecureSource },
    { path: "tests/client.test.ts", content: insecureSource },
    { path: "fixtures/client.ts", content: insecureSource },
    { path: "examples/client.ts", content: insecureSource },
    { path: "docs/client.ts", content: insecureSource },
    { path: "src/client.generated.ts", content: insecureSource },
    { path: "vendor/client.ts", content: insecureSource },
  ];

  const production = await analyzeSecurity(files);
  assert.deepEqual(
    production.findings.map((finding) => finding.evidence.provenance.path),
    ["src/client.ts"],
  );
  assert.equal(production.findings[0]?.sourceScope, "production");
  assert.equal(production.summary.inputFileCount, 7);
  assert.equal(production.summary.scannedFileCount, 1);
  assert.equal(production.summary.excludedFileCount, 6);
  assert.equal(production.summary.sourceScope, "production");

  const all = await analyzeSecurity(files, { sourceScope: "all" });
  assert.equal(all.findings.length, 7);
  assert.equal(all.summary.excludedFileCount, 0);
  assert.equal(all.summary.sourceScope, "all");
});

test("detector pattern literals are not reported as runtime vulnerabilities or secrets", async () => {
  const tokenPatternValue = `ghp_${"A".repeat(40)}`;
  const detectorSource = [
    "const SENSITIVE_KEY = /(?:token|password)/i;",
    'const tlsRule = "rejectUnauthorized: false";',
    `const githubTokenPattern = new RegExp("${tokenPatternValue}");`,
  ].join("\n");

  const result = await analyzeSecurity([
    { path: "src/security-rules.ts", content: detectorSource },
  ]);
  assert.equal(result.findings.length, 0);
  assert.equal(JSON.stringify(result).includes(tokenPatternValue), false);
});

test("RegExp execution is distinct from an imported Node shell execution", async () => {
  const result = await analyzeSecurity([
    {
      path: "src/match.ts",
      content: [
        'import { exec } from "node:child_process";',
        "const expression = /safe/;",
        "expression.exec(input);",
        "exec(userCommand);",
      ].join("\n"),
    },
  ]);
  const shellFindings = result.findings.filter(
    (finding) => finding.ruleId === "node-shell-exec",
  );
  assert.equal(shellFindings.length, 1);
  assert.equal(shellFindings[0]?.evidence.provenance.range.start.line, 4);
});

async function fixtureFiles(names: readonly string[]): Promise<AnalysisFile[]> {
  return Promise.all(
    names.map(async (name) => ({
      path: `fixtures/security/${name}`,
      content: await readFile(path.join(fixtureRoot, name), "utf8"),
    })),
  );
}

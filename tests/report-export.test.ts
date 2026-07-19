import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { analyzeLocalProject } from "../src/report/analyze.js";
import {
  reportToMarkdown,
  reportToSarif,
  serializeReport,
} from "../src/report/export.js";

test("reports export to readable Markdown and SARIF without losing source locations", async () => {
  const report = await analyzeLocalProject({
    root: resolve("examples/sample-project"),
    publicPath: "Bundled sample",
    question: "What changes around session expiry?",
    limits: {
      maxFiles: 1_000,
      maxFileBytes: 1_000_000,
      maxTotalBytes: 10_000_000,
    },
  });

  const markdown = reportToMarkdown(report);
  assert.match(markdown, /## Change impact/u);
  assert.match(markdown, /## Security findings/u);
  assert.match(markdown, /src\/config\/tls\.ts/u);

  const sarif = reportToSarif(report) as {
    version: string;
    runs: Array<{ results: Array<{ locations: unknown[] }> }>;
  };
  assert.equal(sarif.version, "2.1.0");
  assert.equal(sarif.runs[0]?.results.length, report.security.findings.length);
  assert.ok(sarif.runs[0]?.results.every((result) => result.locations.length === 1));
  assert.doesNotThrow(() => JSON.parse(serializeReport(report, "sarif")));

  const encodedPathReport = {
    ...report,
    security: {
      ...report.security,
      findings: [
        {
          ...report.security.findings[0],
          file: "src/한 글 #100%.ts",
        },
      ],
    },
  };
  const encodedSarif = reportToSarif(encodedPathReport) as {
    runs: Array<{
      results: Array<{
        locations: Array<{
          physicalLocation: { artifactLocation: { uri: string } };
        }>;
      }>;
    }>;
  };
  assert.equal(
    encodedSarif.runs[0]?.results[0]?.locations[0]?.physicalLocation.artifactLocation.uri,
    "src/%ED%95%9C%20%EA%B8%80%20%23100%25.ts",
  );
});

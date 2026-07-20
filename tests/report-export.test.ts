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
  assert.match(markdown, /## Migration review/u);
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

  const migrationReport = {
    ...report,
    migration: {
      status: "complete" as const,
      comparison: {
        mode: "staged" as const,
        label: "Staged changes",
        beforeSource: "HEAD" as const,
        afterSource: "index" as const,
      },
      summary: {
        files: 1,
        operations: 1,
        risks: 1,
        destructive: 1,
        safe: 0,
        bySeverity: { critical: 0, high: 1, medium: 0, low: 0, info: 0 },
      },
      risks: [
        {
          id: "migration-drop-column",
          label: "drop-column:accounts.legacy_code",
          semanticKey: "drop-column\u0000accounts\u0000legacy_code",
          category: "drop-column",
          severity: "high" as const,
          destructive: true,
          safe: false,
          confidence: 0.99,
          explanation: "The migration removes stored values.",
          remediation: "Preserve required data before dropping the column.",
          table: "accounts",
          column: "legacy_code",
          file: "db/migrations/002_cleanup.sql",
          line: 3,
          relevance: "direct" as const,
          introduced: true as const,
        },
      ],
      diagnostics: [],
    },
  };
  const migrationMarkdown = reportToMarkdown(migrationReport);
  assert.match(migrationMarkdown, /drop-column:accounts\.legacy_code/u);
  const migrationSarif = reportToSarif(migrationReport) as {
    runs: Array<{
      results: Array<{
        ruleId: string;
        locations: Array<{
          physicalLocation: {
            artifactLocation: { uri: string };
            region?: { startLine: number };
          };
        }>;
      }>;
    }>;
  };
  const migrationResult = migrationSarif.runs[0]?.results.find(
    (result) => result.ruleId === "migration/drop-column",
  );
  assert.equal(
    migrationResult?.locations[0]?.physicalLocation.artifactLocation.uri,
    "db/migrations/002_cleanup.sql",
  );
  assert.equal(
    migrationResult?.locations[0]?.physicalLocation.region?.startLine,
    3,
  );

  const partialMigrationReport = {
    ...migrationReport,
    migration: {
      ...migrationReport.migration,
      status: "partial" as const,
      diagnostics: [
        "db/migrations/002_cleanup.sql: after-version content was unavailable.",
      ],
    },
    run: {
      ...migrationReport.run,
      partial: true,
      stages: migrationReport.run.stages.map((stage) =>
        stage.id === "migration"
          ? { ...stage, status: "partial" as const }
          : stage,
      ),
    },
  };
  assert.match(
    reportToMarkdown(partialMigrationReport),
    /Migration coverage diagnostics[\s\S]*after-version content was unavailable/u,
  );
  const partialSarif = reportToSarif(partialMigrationReport) as {
    runs: Array<{
      invocations: Array<{
        toolExecutionNotifications: Array<{
          descriptor: { id: string };
          message: { text: string };
        }>;
      }>;
    }>;
  };
  assert.equal(
    partialSarif.runs[0]?.invocations[0]?.toolExecutionNotifications[0]
      ?.descriptor.id,
    "migration-coverage",
  );
  assert.match(
    partialSarif.runs[0]?.invocations[0]?.toolExecutionNotifications[0]?.message
      .text ?? "",
    /after-version content was unavailable/u,
  );
});

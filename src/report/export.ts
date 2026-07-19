import type { AtlasReport, ReportSeverity } from "./types.js";

export type ReportFormat = "json" | "markdown" | "sarif";

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function reportToMarkdown(report: AtlasReport): string {
  const lines = [
    `# Local Code Atlas — ${report.project.name}`,
    "",
    `- Generated: ${report.generatedAt}`,
    `- Project: ${report.project.path}`,
    `- Scope: ${report.run.scope}`,
    `- Comparison: ${report.project.git?.comparison.label ?? "No Git comparison"}`,
    `- Scan: ${report.run.partial ? "Partial" : "Complete"}`,
    "",
    "## Change impact",
    "",
    `Question: ${report.impact.question || "—"}`,
    "",
    "| Relevance | Source | Reason |",
    "| ---: | --- | --- |",
    ...report.impact.findings.map(
      (finding) =>
        `| ${Math.round(finding.score * 100)}% | \`${markdownCell(finding.file)}${finding.line ? `:${finding.line}` : ""}\` | ${markdownCell(finding.reason)} |`,
    ),
    "",
    "## Security findings",
    "",
    "| Severity | Finding | Source | Scope |",
    "| --- | --- | --- | --- |",
    ...report.security.findings.map(
      (finding) =>
        `| ${finding.severity} | ${markdownCell(finding.title)} | \`${markdownCell(finding.file)}${finding.line ? `:${finding.line}` : ""}\` | ${finding.scope} |`,
    ),
    "",
    "## Data relationships",
    "",
    "| Origin | From | To | Relationship |",
    "| --- | --- | --- | --- |",
    ...report.erd.relationships.map(
      (relationship) =>
        `| ${relationship.origin} | \`${markdownCell(`${relationship.fromTable}.${relationship.fromColumn}`)}\` | \`${markdownCell(`${relationship.toTable}.${relationship.toColumn}`)}\` | ${markdownCell(relationship.kind ?? "related")} |`,
    ),
    "",
    "## Analysis coverage",
    "",
    ...report.run.stages.map(
      (stage) => `- **${stage.id}** — ${stage.status}: ${stage.detail}`,
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

function sarifLevel(severity: ReportSeverity): "error" | "warning" | "note" {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function sarifArtifactUri(file: string): string {
  return file
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function reportToSarif(report: AtlasReport): object {
  const ruleMap = new Map(
    report.security.findings.map((finding) => [
      finding.id,
      {
        id: finding.id,
        name: finding.title,
        shortDescription: { text: finding.title },
        fullDescription: { text: finding.evidence },
        help: {
          text: finding.remediation,
          ...(finding.advisoryUrl ? { markdown: `[Advisory](${finding.advisoryUrl})` } : {}),
        },
        properties: {
          category: finding.category,
          confidence: finding.confidence,
          sourceKind: finding.sourceKind,
          scope: finding.scope,
        },
      },
    ]),
  );

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "Local Code Atlas",
            rules: [...ruleMap.values()],
          },
        },
        invocations: [
          {
            executionSuccessful: !report.run.stages.some(
              (stage) => stage.status === "failed",
            ),
            properties: {
              scope: report.run.scope,
              partial: report.run.partial,
              comparison: report.project.git?.comparison.label,
            },
          },
        ],
        results: report.security.findings.map((finding) => ({
          ruleId: finding.id,
          level: sarifLevel(finding.severity),
          message: { text: `${finding.title}. ${finding.evidence}` },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: sarifArtifactUri(finding.file) },
                ...(finding.line
                  ? { region: { startLine: finding.line } }
                  : {}),
              },
            },
          ],
        })),
      },
    ],
  };
}

export function serializeReport(
  report: AtlasReport,
  format: ReportFormat,
): string {
  if (format === "markdown") return reportToMarkdown(report);
  if (format === "sarif") return `${JSON.stringify(reportToSarif(report), null, 2)}\n`;
  return `${JSON.stringify(report, null, 2)}\n`;
}

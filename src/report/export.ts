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
    "## Migration review",
    "",
    `- Status: ${report.migration.status}`,
    `- Comparison: ${report.migration.comparison?.label ?? "No supported migration comparison"}`,
    `- Introduced operations: ${report.migration.summary.operations}`,
    `- Review risks: ${report.migration.summary.risks}`,
    "",
    ...(report.migration.status === "partial" || report.migration.status === "failed"
      ? [
          "> Migration coverage is incomplete. Missing findings must not be interpreted as a clean result.",
          "",
        ]
      : []),
    ...(report.migration.diagnostics.length > 0
      ? [
          "### Migration coverage diagnostics",
          "",
          ...report.migration.diagnostics.map(
            (diagnostic) => `- ${markdownCell(diagnostic)}`,
          ),
          "",
        ]
      : []),
    "| Severity | Operation | Source | Review |",
    "| --- | --- | --- | --- |",
    ...report.migration.risks.map(
      (risk) =>
        `| ${risk.severity} | ${markdownCell(risk.label)} | \`${markdownCell(risk.file)}${risk.line ? `:${risk.line}` : ""}\` | ${risk.safe ? "safe" : risk.destructive ? "destructive" : "review"} |`,
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
  const securityRuleMap = new Map(
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
  const migrationRuleMap = new Map(
    report.migration.risks.map((risk) => {
      const ruleId = `migration/${risk.category}`;
      return [
        ruleId,
        {
          id: ruleId,
          name: `Migration ${risk.category}`,
          shortDescription: {
            text: `Review ${risk.category.replaceAll("-", " ")} migration operations`,
          },
          fullDescription: { text: risk.explanation },
          help: { text: risk.remediation },
          properties: {
            category: risk.category,
            destructive: risk.destructive,
            safe: risk.safe,
            confidence: risk.confidence,
          },
        },
      ] as const;
    }),
  );

  return {
    version: "2.1.0",
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    runs: [
      {
        tool: {
          driver: {
            name: "Local Code Atlas",
            rules: [...securityRuleMap.values(), ...migrationRuleMap.values()],
          },
        },
        invocations: [
          {
            executionSuccessful: !report.run.stages.some(
              (stage) => stage.status === "failed",
            ),
            toolExecutionNotifications: report.migration.diagnostics.map(
              (diagnostic) => ({
                descriptor: { id: "migration-coverage" },
                level: report.migration.status === "failed" ? "error" : "warning",
                message: { text: diagnostic },
                properties: {
                  stage: "migration",
                  coverageStatus: report.migration.status,
                },
              }),
            ),
            properties: {
              scope: report.run.scope,
              partial: report.run.partial,
              comparison: report.project.git?.comparison.label,
              migrationStatus: report.migration.status,
              migrationDiagnostics: report.migration.diagnostics.length,
            },
          },
        ],
        results: [
          ...report.security.findings.map((finding) => ({
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
          ...report.migration.risks.map((risk) => ({
            ruleId: `migration/${risk.category}`,
            level: sarifLevel(risk.severity),
            message: { text: `${risk.label}. ${risk.explanation}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: sarifArtifactUri(risk.file) },
                  ...(risk.line ? { region: { startLine: risk.line } } : {}),
                },
              },
            ],
            properties: {
              destructive: risk.destructive,
              safe: risk.safe,
              confidence: risk.confidence,
              introduced: risk.introduced,
            },
          })),
        ],
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

import { createHash } from "node:crypto";
import {
  analyzeSchema,
  analyzeMigrationRisks,
  supportsMigrationRiskFile,
  type MigrationRisk,
} from "../analyzers/schema";
import type { AnalysisFile } from "../analyzers/types";
import {
  getGitFileSnapshots,
  type GitChangedFile,
  type GitMetadata,
  type GitSnapshotComparison,
} from "../core";
import type { AtlasReport, GitComparisonMode } from "./types";

interface MigrationComparisonInput {
  root: string;
  comparison: {
    mode: GitComparisonMode;
    base?: string;
    label: string;
  };
  git: GitMetadata;
  changes: readonly GitChangedFile[];
  loadedFiles: readonly AnalysisFile[];
  impact: AtlasReport["impact"];
  syntheticGit: boolean;
  snapshotOverrides?: readonly MigrationSnapshotOverride[];
  maxFileBytes: number;
  signal?: AbortSignal;
}

export interface MigrationSnapshotOverride {
  path: string;
  previousPath?: string;
  status: GitChangedFile["status"];
  before?: string;
  after?: string;
}

type MigrationSnapshot = MigrationSnapshotOverride;

function emptySummary(): AtlasReport["migration"]["summary"] {
  return {
    files: 0,
    operations: 0,
    risks: 0,
    destructive: 0,
    safe: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  };
}

function comparisonMetadata(
  input: MigrationComparisonInput,
): NonNullable<AtlasReport["migration"]["comparison"]> {
  return {
    mode: input.comparison.mode,
    label: input.comparison.label,
    beforeSource: input.syntheticGit
      ? "synthetic baseline"
      : input.comparison.mode === "base"
        ? "merge-base"
        : "HEAD",
    afterSource: input.syntheticGit
      ? "fixture"
      : input.comparison.mode === "working-tree"
        ? "working-tree"
        : input.comparison.mode === "staged"
          ? "index"
          : "HEAD",
  };
}

function isMigrationHistoryPath(filePath: string): boolean {
  const normalized = `/${filePath.replaceAll("\\", "/").toLocaleLowerCase()}/`;
  return [
    "/migration/",
    "/migrations/",
    "/db/migrate/",
    "/database/migrate/",
  ].some((segment) => normalized.includes(segment));
}

function isPotentialMigrationPath(filePath: string): boolean {
  return /\.sql$/iu.test(filePath) || isMigrationHistoryPath(filePath);
}

function syntheticSnapshots(
  changes: readonly GitChangedFile[],
  loadedFiles: readonly AnalysisFile[],
): { snapshots: MigrationSnapshot[]; diagnostics: string[] } {
  const filesByPath = new Map(loadedFiles.map((file) => [file.path, file.content]));
  const snapshots: MigrationSnapshot[] = [];
  const diagnostics: string[] = [];
  for (const change of changes) {
    const after = filesByPath.get(change.path);
    if (change.status === "added" || change.status === "untracked") {
      if (after === undefined) {
        diagnostics.push(
          `${change.path}: fixture content was unavailable for migration analysis.`,
        );
      }
      snapshots.push({
        path: change.path,
        previousPath: change.previousPath,
        status: change.status,
        after,
      });
      continue;
    }
    diagnostics.push(
      `${change.path}: a synthetic Git scenario did not provide the before-version content needed for this migration comparison.`,
    );
    snapshots.push({
      path: change.path,
      previousPath: change.previousPath,
      status: change.status,
      after: change.status === "deleted" ? undefined : after,
    });
  }
  return { snapshots, diagnostics };
}

function safeSnapshotContent(
  snapshot: MigrationSnapshot,
  maxFileBytes: number,
  diagnostics: string[],
): MigrationSnapshot {
  const validate = (side: "before" | "after", content: string | undefined) => {
    if (content === undefined) return undefined;
    if (content.includes("\u0000")) {
      diagnostics.push(
        `${snapshot.path}: ${side}-version migration content was binary and could not be analyzed.`,
      );
      return undefined;
    }
    if (Buffer.byteLength(content, "utf8") > maxFileBytes) {
      diagnostics.push(
        `${snapshot.path}: ${side}-version migration content exceeded the configured per-file analysis limit.`,
      );
      return undefined;
    }
    return content;
  };
  return {
    ...snapshot,
    before: validate("before", snapshot.before),
    after: validate("after", snapshot.after),
  };
}

function introducedOperations(
  snapshot: MigrationSnapshot,
): {
  risks: MigrationRisk[];
  diagnostics: string[];
  partial: boolean;
} {
  const before = snapshot.before === undefined
    ? undefined
    : analyzeMigrationRisks([
        {
          path: snapshot.previousPath ?? snapshot.path,
          content: snapshot.before,
        },
      ]);
  const after = snapshot.after === undefined
    ? undefined
    : analyzeMigrationRisks([{ path: snapshot.path, content: snapshot.after }]);
  const counts = new Map<string, number>();
  for (const risk of before?.risks ?? []) {
    counts.set(risk.semanticKey, (counts.get(risk.semanticKey) ?? 0) + 1);
  }
  const introduced: MigrationRisk[] = [];
  for (const risk of after?.risks ?? []) {
    const remaining = counts.get(risk.semanticKey) ?? 0;
    if (remaining > 0) {
      counts.set(risk.semanticKey, remaining - 1);
    } else {
      introduced.push(risk);
    }
  }
  return {
    risks: introduced,
    diagnostics: [
      ...(before?.diagnostics.map(
        (diagnostic) => `${diagnostic} (before version)`,
      ) ?? []),
      ...(after?.diagnostics.map(
        (diagnostic) => `${diagnostic} (after version)`,
      ) ?? []),
    ],
    partial: before?.partial === true || after?.partial === true,
  };
}

function fileChangeRisk(
  snapshot: MigrationSnapshot,
): AtlasReport["migration"]["risks"][number] | undefined {
  if (
    !isMigrationHistoryPath(snapshot.path) &&
    !(
      snapshot.previousPath &&
      isMigrationHistoryPath(snapshot.previousPath)
    )
  ) {
    return undefined;
  }
  const line = 1;
  let category: string | undefined;
  let severity: "high" | "medium" | undefined;
  let destructive = false;
  let explanation = "";
  let remediation = "";
  if (snapshot.status === "deleted") {
    category = "migration-file-deleted";
    severity = "high";
    destructive = true;
    explanation =
      "Deletes an existing migration file, which can make fresh installations and already-migrated environments follow different histories.";
    remediation =
      "Restore the historical migration and add a new forward migration; verify both fresh and upgraded database paths.";
  } else if (snapshot.status === "renamed") {
    category = "migration-file-renamed";
    severity = "medium";
    explanation =
      "Renames an existing migration file, which can change ordering or tracking identity in migration tools.";
    remediation =
      "Keep applied migration identifiers stable or verify the migration tool's history table and ordering semantics before renaming.";
  } else if (
    snapshot.status === "modified" &&
    snapshot.before !== undefined &&
    snapshot.after !== undefined &&
    snapshot.before !== snapshot.after
  ) {
    category = "migration-file-rewritten";
    severity = "medium";
    explanation =
      "Rewrites an existing migration file, so databases that already applied it can diverge from fresh installations.";
    remediation =
      "Leave historical migrations immutable and express the correction in a new forward migration with an explicit rollback plan.";
  }
  if (!category || !severity) return undefined;
  const semanticKey = `${category}\u0000${snapshot.path}`;
  return {
    id: `migration-${createHash("sha256")
      .update(semanticKey)
      .digest("hex")
      .slice(0, 16)}`,
    label: `${category}:${snapshot.path}`,
    semanticKey,
    category,
    severity,
    destructive,
    safe: false,
    confidence: 0.98,
    explanation,
    remediation,
    file: snapshot.path,
    line,
    relevance: "project",
    introduced: true,
  };
}

function relevanceFor(
  filePath: string,
  impact: AtlasReport["impact"],
): "direct" | "indirect" | "project" {
  const score = impact.findings.find((finding) => finding.file === filePath)?.score;
  if (score === undefined) return "project";
  return score >= 0.6 ? "direct" : "indirect";
}

function reportRisk(
  risk: MigrationRisk,
  impact: AtlasReport["impact"],
): AtlasReport["migration"]["risks"][number] {
  return {
    id: risk.id,
    label: risk.label,
    semanticKey: risk.semanticKey,
    category: risk.category,
    severity: risk.severity,
    destructive: risk.destructive,
    safe: risk.safe,
    confidence: risk.confidence,
    explanation: risk.explanation,
    remediation: risk.remediation,
    namespace: risk.namespace,
    table: risk.qualifiedTable,
    column: risk.column,
    nextName: risk.nextName,
    file: risk.provenance.path,
    line: risk.provenance.range.start.line,
    relevance: relevanceFor(risk.provenance.path, impact),
    introduced: true,
  };
}

function schemaObjectRisk(input: {
  category: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  destructive: boolean;
  safe: boolean;
  confidence: number;
  explanation: string;
  remediation: string;
  table: string;
  column?: string;
  file: string;
  line?: number;
  semanticDetail?: string;
  impact: AtlasReport["impact"];
}): AtlasReport["migration"]["risks"][number] {
  const label = `${input.category}:${input.table}${input.column ? `.${input.column}` : ""}`;
  const semanticKey = [
    input.category,
    input.table,
    input.column ?? "",
    input.semanticDetail ?? "",
  ].join("\u0000");
  return {
    id: `migration-${createHash("sha256")
      .update(`${input.file}\u0000${semanticKey}`)
      .digest("hex")
      .slice(0, 16)}`,
    label,
    semanticKey,
    category: input.category,
    severity: input.severity,
    destructive: input.destructive,
    safe: input.safe,
    confidence: input.confidence,
    explanation: input.explanation,
    remediation: input.remediation,
    table: input.table,
    column: input.column,
    file: input.file,
    line: input.line,
    relevance: relevanceFor(input.file, input.impact),
    introduced: true,
  };
}

function schemaTableName(table: {
  name?: string;
  table?: string;
  namespace?: string;
}): string {
  const name = table.name ?? table.table ?? "unknown_table";
  return table.namespace ? `${table.namespace}.${name}` : name;
}

function relationshipIdentity(relationship: {
  from: { table: string; namespace?: string; columns: string[] };
  to: { table: string; namespace?: string; columns: string[] };
}): string {
  return [
    schemaTableName(relationship.from),
    relationship.from.columns.join(","),
    schemaTableName(relationship.to),
    relationship.to.columns.join(","),
  ].join("\u0000");
}

async function schemaDiffRisks(
  snapshot: MigrationSnapshot,
  impact: AtlasReport["impact"],
  signal?: AbortSignal,
): Promise<AtlasReport["migration"]["risks"]> {
  if (snapshot.before === undefined || snapshot.after === undefined) return [];
  signal?.throwIfAborted();
  const [before, after] = await Promise.all([
    analyzeSchema(
      [
        {
          path: snapshot.previousPath ?? snapshot.path,
          content: snapshot.before,
        },
      ],
      { inferRelationships: false, signal },
    ),
    analyzeSchema(
      [{ path: snapshot.path, content: snapshot.after }],
      { inferRelationships: false, signal },
    ),
  ]);
  const risks: AtlasReport["migration"]["risks"] = [];
  const afterTables = new Map(
    after.tables.map((table) => [schemaTableName(table).toLocaleLowerCase(), table]),
  );
  const beforeTables = new Map(
    before.tables.map((table) => [schemaTableName(table).toLocaleLowerCase(), table]),
  );

  for (const table of before.tables) {
    const identity = schemaTableName(table);
    const next = afterTables.get(identity.toLocaleLowerCase());
    const tableSource = table.provenance[0];
    if (!next) {
      risks.push(
        schemaObjectRisk({
          category: "drop-table",
          severity: "critical",
          destructive: true,
          safe: false,
          confidence: 0.92,
          explanation: `The compared schema removes ${identity}, including its stored rows and dependent objects.`,
          remediation:
            "Confirm data retention and dependencies, remove application usage first, and prepare a tested backup and rollback path.",
          table: identity,
          file: snapshot.path,
          line: tableSource?.range.start.line,
          impact,
        }),
      );
      continue;
    }
    const afterColumns = new Map(
      next.columns.map((column) => [column.name.toLocaleLowerCase(), column]),
    );
    for (const column of table.columns) {
      const afterColumn = afterColumns.get(column.name.toLocaleLowerCase());
      if (!afterColumn) {
        risks.push(
          schemaObjectRisk({
            category: "drop-column",
            severity: "high",
            destructive: true,
            safe: false,
            confidence: 0.94,
            explanation: `The compared schema removes ${identity}.${column.name} and its stored values.`,
            remediation:
              "Remove application reads and writes first, preserve required data, and verify rollback before dropping the column.",
            table: identity,
            column: column.name,
            file: snapshot.path,
            line: column.provenance.range.start.line,
            impact,
          }),
        );
        continue;
      }
      if (column.nullable && !afterColumn.nullable) {
        risks.push(
          schemaObjectRisk({
            category: "set-not-null",
            severity: "high",
            destructive: false,
            safe: false,
            confidence: 0.93,
            explanation: `The compared schema makes ${identity}.${column.name} required; existing null rows and older writers can violate the new constraint.`,
            remediation:
              "Backfill and validate null rows, then deploy compatible writers before enforcing the constraint.",
            table: identity,
            column: column.name,
            file: snapshot.path,
            line: afterColumn.provenance.range.start.line,
            semanticDetail: "nullable=false",
            impact,
          }),
        );
      }
      const previousType = column.dataType.replace(/\s+/gu, " ").toLocaleLowerCase();
      const nextType = afterColumn.dataType.replace(/\s+/gu, " ").toLocaleLowerCase();
      if (previousType !== nextType) {
        risks.push(
          schemaObjectRisk({
            category: "type-change",
            severity: "high",
            destructive: false,
            safe: false,
            confidence: 0.9,
            explanation: `The compared schema changes ${identity}.${column.name} from ${previousType} to ${nextType}; data compatibility cannot be proven statically.`,
            remediation:
              "Test conversion against production-shaped data and use a reversible expand-and-contract rollout when compatibility is uncertain.",
            table: identity,
            column: column.name,
            file: snapshot.path,
            line: afterColumn.provenance.range.start.line,
            semanticDetail: `newType=${nextType}`,
            impact,
          }),
        );
      }
    }
  }

  for (const table of after.tables) {
    const identity = schemaTableName(table);
    const previous = beforeTables.get(identity.toLocaleLowerCase());
    if (!previous) continue;
    const previousColumns = new Set(
      previous.columns.map((column) => column.name.toLocaleLowerCase()),
    );
    for (const column of table.columns) {
      if (previousColumns.has(column.name.toLocaleLowerCase())) continue;
      risks.push(
        schemaObjectRisk({
          category: "add-column",
          severity: column.nullable ? "low" : "high",
          destructive: false,
          safe: column.nullable,
          confidence: column.nullable ? 0.9 : 0.82,
          explanation: column.nullable
            ? `The compared schema adds nullable column ${identity}.${column.name}.`
            : `The compared schema adds required column ${identity}.${column.name}; the schema model cannot prove a safe backfill or default for existing rows.`,
          remediation: column.nullable
            ? "Verify application compatibility and the rollback path before deployment."
            : "Use an expand-and-contract rollout and verify any default or backfill explicitly before enforcing the constraint.",
          table: identity,
          column: column.name,
          file: snapshot.path,
          line: column.provenance.range.start.line,
          semanticDetail: `nullable=${column.nullable};type=${column.dataType.toLocaleLowerCase()}`,
          impact,
        }),
      );
    }
  }

  const afterRelationships = new Map(
    after.relationships.map((relationship) => [
      relationshipIdentity(relationship),
      relationship,
    ]),
  );
  for (const relationship of before.relationships) {
    const identity = relationshipIdentity(relationship);
    const next = afterRelationships.get(identity);
    const table = schemaTableName(relationship.from);
    const column = relationship.from.columns.join(",") || undefined;
    if (!next) {
      risks.push(
        schemaObjectRisk({
          category: "drop-constraint",
          severity: "medium",
          destructive: false,
          safe: false,
          confidence: 0.85,
          explanation: `The compared schema removes the declared relationship from ${table}${column ? `.${column}` : ""}, weakening a database-enforced reference.`,
          remediation:
            "Confirm the relationship is intentionally removed and deploy compensating validation before dropping the constraint.",
          table,
          column,
          file: snapshot.path,
          line: relationship.provenance.range.start.line,
          semanticDetail: identity,
          impact,
        }),
      );
      continue;
    }
    const beforeDelete = relationship.onDelete?.toLocaleLowerCase() ?? "";
    const beforeUpdate = relationship.onUpdate?.toLocaleLowerCase() ?? "";
    const afterDelete = next.onDelete?.toLocaleLowerCase() ?? "";
    const afterUpdate = next.onUpdate?.toLocaleLowerCase() ?? "";
    if (beforeDelete === afterDelete && beforeUpdate === afterUpdate) continue;
    const introducesCascade =
      (afterDelete === "cascade" && beforeDelete !== "cascade") ||
      (afterUpdate === "cascade" && beforeUpdate !== "cascade");
    risks.push(
      schemaObjectRisk({
        category: "cascade-change",
        severity: introducesCascade ? "high" : "medium",
        destructive: introducesCascade,
        safe: false,
        confidence: 0.94,
        explanation: `The compared schema changes referential actions for ${table}${column ? `.${column}` : ""}; parent mutations can now affect related rows differently.`,
        remediation:
          "Verify delete and update flows, retention requirements, and every dependent relationship with production-shaped data.",
        table,
        column,
        file: snapshot.path,
        line: next.provenance.range.start.line,
        semanticDetail: `delete=${afterDelete};update=${afterUpdate}`,
        impact,
      }),
    );
  }
  return risks;
}

function summarize(
  files: number,
  risks: readonly AtlasReport["migration"]["risks"][number][],
): AtlasReport["migration"]["summary"] {
  const summary = emptySummary();
  summary.files = files;
  summary.operations = risks.length;
  summary.risks = risks.filter((risk) => !risk.safe).length;
  summary.destructive = risks.filter((risk) => risk.destructive).length;
  summary.safe = risks.filter((risk) => risk.safe).length;
  for (const risk of risks) summary.bySeverity[risk.severity] += 1;
  return summary;
}

function rethrowCancellation(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : error;
  }
  if (error instanceof Error && error.name === "AbortError") throw error;
}

export async function analyzeMigrationComparison(
  input: MigrationComparisonInput,
): Promise<AtlasReport["migration"]> {
  const relevantChanges = input.changes.filter(
    (change) =>
      isPotentialMigrationPath(change.path) ||
      Boolean(
        change.previousPath && isPotentialMigrationPath(change.previousPath),
      ),
  );
  const comparison = comparisonMetadata(input);
  if (!input.git.isRepository || relevantChanges.length === 0) {
    return {
      status: "not-run",
      comparison: input.git.isRepository ? comparison : undefined,
      summary: emptySummary(),
      risks: [],
      diagnostics: [],
    };
  }

  const diagnostics: string[] = [];
  let snapshots: MigrationSnapshot[];
  try {
    if (input.syntheticGit) {
      if (input.snapshotOverrides) {
        const overridesByPath = new Map(
          input.snapshotOverrides.map((snapshot) => [snapshot.path, snapshot]),
        );
        snapshots = relevantChanges.map((change) => {
          const override = overridesByPath.get(change.path);
          if (override) return { ...override };
          diagnostics.push(
            `${change.path}: the synthetic scenario did not provide a migration snapshot.`,
          );
          return {
            path: change.path,
            previousPath: change.previousPath,
            status: change.status,
          };
        });
      } else {
        const result = syntheticSnapshots(relevantChanges, input.loadedFiles);
        snapshots = result.snapshots;
        diagnostics.push(...result.diagnostics);
      }
    } else {
      let snapshotComparison: GitSnapshotComparison;
      if (input.comparison.mode === "base") {
        if (!input.comparison.base) {
          return {
            status: "failed",
            comparison,
            summary: emptySummary(),
            risks: [],
            diagnostics: [
              "Migration comparison could not resolve a base revision.",
            ],
          };
        }
        snapshotComparison = { mode: "base", base: input.comparison.base };
      } else {
        snapshotComparison = { mode: input.comparison.mode };
      }
      const result = await getGitFileSnapshots(
        input.root,
        relevantChanges,
        snapshotComparison,
        {
          signal: input.signal,
          maxFileBytes: input.maxFileBytes,
        },
      );
      snapshots = result.snapshots;
      diagnostics.push(...result.diagnostics);
    }
  } catch (error) {
    rethrowCancellation(error, input.signal);
    return {
      status: "failed",
      comparison,
      summary: emptySummary(),
      risks: [],
      diagnostics: [
        "Migration before/after snapshots could not be read from the selected Git comparison.",
      ],
    };
  }

  const reportRisks: AtlasReport["migration"]["risks"] = [];
  let partial = diagnostics.length > 0;
  let analyzedFiles = 0;
  for (const originalSnapshot of snapshots) {
    input.signal?.throwIfAborted();
    const snapshot = safeSnapshotContent(
      originalSnapshot,
      input.maxFileBytes,
      diagnostics,
    );
    analyzedFiles += 1;
    const fileRisk = fileChangeRisk(snapshot);
    if (fileRisk) {
      fileRisk.relevance = relevanceFor(fileRisk.file, input.impact);
      reportRisks.push(fileRisk);
    }
    if (!supportsMigrationRiskFile({ path: originalSnapshot.path })) {
      diagnostics.push(
        `${originalSnapshot.path}: this migration source type is not supported by the SQL migration analyzer.`,
      );
      partial = true;
      continue;
    }
    const expectedBefore = !["added", "untracked"].includes(snapshot.status);
    const expectedAfter = snapshot.status !== "deleted";
    if (
      (expectedBefore && snapshot.before === undefined) ||
      (expectedAfter && snapshot.after === undefined)
    ) {
      partial = true;
    }
    const analyzed = introducedOperations(snapshot);
    partial ||= analyzed.partial;
    diagnostics.push(...analyzed.diagnostics);
    reportRisks.push(
      ...analyzed.risks.map((risk) => reportRisk(risk, input.impact)),
    );
    const stateDiffRisks = await schemaDiffRisks(
      snapshot,
      input.impact,
      input.signal,
    );
    const existingLabels = new Set(reportRisks.map((risk) => risk.label));
    for (const stateRisk of stateDiffRisks) {
      if (!existingLabels.has(stateRisk.label)) {
        reportRisks.push(stateRisk);
        existingLabels.add(stateRisk.label);
      }
    }
  }
  if (diagnostics.length > 0) partial = true;
  reportRisks.sort(
    (left, right) =>
      left.file.localeCompare(right.file, "en") ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.label.localeCompare(right.label, "en") ||
      left.id.localeCompare(right.id, "en"),
  );

  return {
    status: partial ? "partial" : "complete",
    comparison,
    summary: summarize(analyzedFiles, reportRisks),
    risks: reportRisks,
    diagnostics: [...new Set(diagnostics)],
  };
}

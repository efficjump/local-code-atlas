import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { analyzeProject, type AnalysisFile } from "../analyzers/index.js";
import {
  analyzeLocalProject as analyzeCoreProject,
  classifySourceScope,
  isDependencyManifestPath,
  sourceScopeIncluded,
  type LocalProjectAnalysis,
  type GitMetadata,
  type ScannedFile,
} from "../core/index.js";
import {
  modelEndpointOrigin,
  modelIsConfigured,
  synthesizeWithModel,
} from "../ai/synthesis.js";
import {
  AI_SYNTHESIS_REQUEST_FIELDS,
  OSV_REQUEST_FIELDS,
} from "../privacy/external-data.js";
import {
  lookupDependencyAdvisories,
  type AdvisoryDependency,
} from "../integrations/osv.js";
import type {
  AtlasReport,
  ExternalCheckStatus,
  GitComparisonMode,
  ProjectScope,
} from "./types.js";
import { analyzeMigrationComparison } from "./migration.js";
import type { MigrationSnapshotOverride } from "./migration.js";

export interface AnalyzeLocalProjectInput {
  root: string;
  question: string;
  publicPath: string;
  enableAi?: boolean;
  checkDependencies?: boolean;
  scope?: ProjectScope;
  comparison?: {
    mode: GitComparisonMode;
    base?: string;
  };
  gitMetadataOverride?: GitMetadata;
  gitFileSnapshotsOverride?: readonly MigrationSnapshotOverride[];
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
  };
}

function comparisonOptions(
  comparison: AnalyzeLocalProjectInput["comparison"],
) {
  const mode = comparison?.mode ?? "working-tree";
  if (mode === "staged") {
    return {
      includeWorkingTree: true,
      includeStaged: true,
      includeUnstaged: false,
      includeUntracked: false,
    };
  }
  if (mode === "base") {
    return {
      base: comparison?.base,
      includeWorkingTree: false,
      includeUntracked: false,
    };
  }
  return {
    includeWorkingTree: true,
    includeStaged: true,
    includeUnstaged: true,
    includeUntracked: true,
  };
}

function comparisonDescription(
  comparison: AnalyzeLocalProjectInput["comparison"],
): { mode: GitComparisonMode; base?: string; label: string } {
  const mode = comparison?.mode ?? "working-tree";
  if (mode === "staged") return { mode, label: "Staged changes" };
  if (mode === "base") {
    const base = comparison?.base;
    return {
      mode,
      base,
      label: base ? `${base}...HEAD` : "Base revision...HEAD",
    };
  }
  return { mode, label: "Current working tree" };
}

function osvExternalStatus(
  status: Awaited<ReturnType<typeof lookupDependencyAdvisories>>["status"],
): ExternalCheckStatus {
  if (status === "disabled") return "not-requested";
  if (status === "not-applicable") return "skipped";
  if (status === "complete") return "complete";
  if (status === "partial") return "partial";
  return "failed";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Analysis was cancelled.");
  }
}

async function loadAnalysisFiles(
  analysis: LocalProjectAnalysis,
  maximumFileBytes: number,
  signal?: AbortSignal,
): Promise<{
  files: AnalysisFile[];
  diagnostics: string[];
  skipped: Array<{
    path: string;
    kind: ScannedFile["kind"];
    sourceScope: ScannedFile["sourceScope"];
    reason: "binary" | "asset" | "oversized" | "read-failed";
  }>;
}> {
  const files: AnalysisFile[] = [];
  const diagnostics: string[] = [];
  const skipped: Array<{
    path: string;
    kind: ScannedFile["kind"];
    sourceScope: ScannedFile["sourceScope"];
    reason: "binary" | "asset" | "oversized" | "read-failed";
  }> = [];
  for (const file of analysis.scan.files) {
    throwIfAborted(signal);
    if (file.isBinary) {
      skipped.push({
        path: file.path,
        kind: file.kind,
        sourceScope: file.sourceScope,
        reason: "binary",
      });
      continue;
    }
    if (file.kind === "asset") {
      skipped.push({
        path: file.path,
        kind: file.kind,
        sourceScope: file.sourceScope,
        reason: "asset",
      });
      continue;
    }
    if (file.sizeBytes > maximumFileBytes) {
      skipped.push({
        path: file.path,
        kind: file.kind,
        sourceScope: file.sourceScope,
        reason: "oversized",
      });
      diagnostics.push(
        `${file.path}: deep analysis skipped the file because it exceeds the ${maximumFileBytes.toLocaleString("en-US")}-byte per-file limit.`,
      );
      continue;
    }
    try {
      files.push({
        path: file.path,
        content: await readFile(file.absolutePath, "utf8"),
        language: file.language,
        sourceScope: file.sourceScope,
      });
    } catch {
      skipped.push({
        path: file.path,
        kind: file.kind,
        sourceScope: file.sourceScope,
        reason: "read-failed",
      });
      diagnostics.push(`${file.path}: content could not be read for deep analysis.`);
    }
  }
  const nonTextCount = skipped.filter(
    (file) => file.reason === "binary" || file.reason === "asset",
  ).length;
  if (nonTextCount > 0) {
    diagnostics.push(
      `${nonTextCount} binary or asset file(s) were indexed as metadata but excluded from text analyzers.`,
    );
  }
  return { files, diagnostics, skipped };
}

function impactSection(analysis: LocalProjectAnalysis): AtlasReport["impact"] {
  const impact = analysis.impact;
  if (!impact) {
    return { question: "", findings: [], suggestedTests: [] };
  }
  return {
    question: impact.question,
    findings: impact.candidates.map((candidate) => {
      const evidence = candidate.evidence[0];
      const evidenceText = [evidence?.reason, evidence?.excerpt]
        .filter(Boolean)
        .join(" — ");
      return {
        file: candidate.path,
        line: evidence?.location.line,
        score: candidate.score / 100,
        confidence: candidate.confidence,
        graphDistance: candidate.graphDistance,
        changed: candidate.changed,
        reason: candidate.reasons[0] ?? "Connected through the indexed project graph.",
        evidence: evidenceText || undefined,
      };
    }),
    suggestedTests: impact.suggestedTests.map((suggestion) =>
      `${suggestion.title} — ${suggestion.reason}`,
    ),
  };
}

function dependencyForAdvisoryLookup(dependency: {
  ecosystem: string;
  name: string;
  versionSpec: string;
  pinning: string;
  direct: boolean;
  resolutionSource?: "manifest" | "lockfile";
  provenance: { path: string };
}): AdvisoryDependency | undefined {
  const supported = ["npm", "python", "maven", "gradle", "cargo", "go"] as const;
  const ecosystem = supported.find((candidate) => candidate === dependency.ecosystem);
  return ecosystem
    ? {
        ecosystem,
        name: dependency.name,
        versionSpec: dependency.versionSpec,
        pinning: dependency.pinning,
        sourcePath: dependency.provenance.path,
        direct: dependency.direct,
        resolutionSource:
          dependency.resolutionSource ??
          (/(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$/iu.test(
            dependency.provenance.path,
          )
            ? "lockfile"
            : "manifest"),
      }
    : undefined;
}

function securitySection(
  security: Awaited<ReturnType<typeof analyzeProject>>["security"],
  advisories: Awaited<ReturnType<typeof lookupDependencyAdvisories>>,
  impact: AtlasReport["impact"],
  scannedFiles: readonly ScannedFile[],
  eligiblePackageCount: number,
): AtlasReport["security"] {
  const filesByPath = new Map(scannedFiles.map((file) => [file.path, file]));
  const relevanceByPath = new Map(
    impact.findings.map((finding) => [finding.file, finding.score] as const),
  );
  const scopeFor = (
    filePath: string,
    observedScope?: AtlasReport["security"]["findings"][number]["scope"],
  ): AtlasReport["security"]["findings"][number]["scope"] => {
    const file = filesByPath.get(filePath);
    const sourceScope = observedScope ?? file?.sourceScope;
    if (sourceScope && sourceScope !== "production") return sourceScope;
    if (file?.kind === "configuration" || file?.kind === "manifest") return "configuration";
    return "production";
  };
  const relevanceFor = (
    filePath: string,
  ): AtlasReport["security"]["findings"][number]["relevance"] => {
    const score = relevanceByPath.get(filePath);
    if (score === undefined) return "project";
    return score >= 0.6 ? "direct" : "indirect";
  };
  const findings: AtlasReport["security"]["findings"] = security.findings.map(
    (finding) => ({
      id: finding.id,
      title: finding.title,
      severity: finding.severity,
      category: finding.category,
      file: finding.evidence.provenance.path,
      line: finding.evidence.provenance.range.start.line,
      evidence: finding.evidence.summary,
      remediation: finding.remediation,
      confidence: finding.confidence.score,
      scope: scopeFor(finding.evidence.provenance.path, finding.sourceScope),
      sourceKind: "source",
      relevance: relevanceFor(finding.evidence.provenance.path),
    }),
  );

  for (const advisory of advisories.findings) {
    const advisoryInstanceId = createHash("sha256")
      .update(
        [
          advisory.id,
          advisory.packageName,
          advisory.packageVersion,
          advisory.sourcePath,
        ].join("\u0000"),
      )
      .digest("hex")
      .slice(0, 16);
    findings.push({
      id: `osv-${advisory.id}-${advisoryInstanceId}`,
      title: `${advisory.id}: ${advisory.packageName} ${advisory.packageVersion}`,
      severity: advisory.severity,
      category: "supply-chain",
      file: advisory.sourcePath,
      evidence: advisory.summary,
      remediation: advisory.fixedVersion
        ? `Upgrade to ${advisory.fixedVersion} or a later compatible release after reviewing the advisory.`
        : "Review the advisory and choose a patched or unaffected version for this project.",
      confidence: 1,
      scope: scopeFor(advisory.sourcePath),
      sourceKind: "dependency",
      relevance: relevanceFor(advisory.sourcePath),
      advisoryUrl: advisory.advisoryUrl,
    });
  }

  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) {
    if (finding.severity in summary) {
      summary[finding.severity as keyof typeof summary] += 1;
    }
  }
  return {
    summary,
    findings,
    dependencies: {
      total: security.dependencies.length,
      exact: security.dependencies.filter((dependency) => dependency.pinning === "exact").length,
      eligibleForAdvisoryLookup: eligiblePackageCount,
      ecosystems: Object.fromEntries(
        Object.entries(security.summary.dependencyCountByEcosystem).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        ),
      ),
    },
  };
}

function schemaSection(
  schema: Awaited<ReturnType<typeof analyzeProject>>["schema"],
  impact: AtlasReport["impact"],
): AtlasReport["erd"] {
  const impactByPath = new Map(
    impact.findings.map((finding) => [finding.file, finding.score] as const),
  );
  const normalizedQuestion = normalizeTableSearchText(impact.question);
  const tableIdentities = schema.tables.map((table) => ({
    table,
    identity: qualifiedTableName(table.name, table.namespace),
  }));
  const rawNameCounts = new Map<string, number>();
  for (const { table } of tableIdentities) {
    const rawName = normalizeTableSearchText(table.name);
    rawNameCounts.set(rawName, (rawNameCounts.get(rawName) ?? 0) + 1);
  }
  const relevanceForTable = (
    tableName: string,
    namespace: string | undefined,
    sourceFile: string,
  ): AtlasReport["erd"]["tables"][number]["relevance"] => {
    const score = impactByPath.get(sourceFile);
    if (score !== undefined) return score >= 0.6 ? "direct" : "indirect";
    const searchableIdentity = normalizeTableSearchText(
      qualifiedTableName(tableName, namespace),
    );
    if (normalizedQuestion.includes(searchableIdentity)) return "direct";
    const searchableRawName = normalizeTableSearchText(tableName);
    if (
      (rawNameCounts.get(searchableRawName) ?? 0) === 1 &&
      normalizedQuestion.includes(searchableRawName)
    ) return "direct";
    return "project";
  };
  const tableRelevance = new Map<string, "direct" | "indirect" | "project">();
  for (const { table, identity } of tableIdentities) {
    const sourceFile = table.provenance[0]?.path ?? "Unknown schema source";
    tableRelevance.set(
      identity,
      relevanceForTable(table.name, table.namespace, sourceFile),
    );
  }
  const relationships = schema.relationships.map((relationship) => {
    const fromTable = qualifiedTableName(
      relationship.from.table,
      relationship.from.namespace,
    );
    const toTable = qualifiedTableName(
      relationship.to.table,
      relationship.to.namespace,
    );
    const relevance: AtlasReport["erd"]["relationships"][number]["relevance"] =
      tableRelevance.get(fromTable) === "direct" ||
      tableRelevance.get(toTable) === "direct"
        ? "direct"
        : tableRelevance.get(fromTable) === "indirect" ||
            tableRelevance.get(toTable) === "indirect"
          ? "indirect"
          : "project";
    return {
      fromTable,
      fromColumn: relationship.from.columns.join(", ") || "—",
      toTable,
      toColumn: relationship.to.columns.join(", ") || "—",
      kind: relationship.cardinality,
      confidence: relationship.confidence.score,
      origin: relationship.declaration,
      source: `${relationship.declaration} · ${relationship.provenance.path}:${relationship.provenance.range.start.line}`,
      sourceFile: relationship.provenance.path,
      line: relationship.provenance.range.start.line,
      relevance,
    };
  });
  return {
    tables: schema.tables.map((table) => {
      const location = table.provenance[0];
      const tableName = qualifiedTableName(table.name, table.namespace);
      return {
        name: tableName,
        sourceFile: location?.path ?? "Unknown schema source",
        line: location?.range.start.line,
        relevance: relevanceForTable(
          table.name,
          table.namespace,
          location?.path ?? "Unknown schema source",
        ),
        columns: table.columns.map((column) => {
          const foreignKey = schema.relationships.find(
            (relationship) =>
              qualifiedTableName(
                relationship.from.table,
                relationship.from.namespace,
              ) === tableName &&
              relationship.from.columns.includes(column.name),
          );
          return {
            name: column.name,
            type: column.dataType,
            nullable: column.nullable,
            primaryKey: column.primaryKey,
            foreignKey: foreignKey
              ? {
                  table: qualifiedTableName(
                    foreignKey.to.table,
                    foreignKey.to.namespace,
                  ),
                  column: foreignKey.to.columns.join(", ") || "—",
                }
              : undefined,
          };
        }),
      };
    }),
    relationships,
  };
}

function qualifiedTableName(tableName: string, namespace?: string): string {
  return namespace ? `${namespace}.${tableName}` : tableName;
}

function normalizeTableSearchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export async function analyzeLocalProject(
  input: AnalyzeLocalProjectInput,
  signal?: AbortSignal,
): Promise<AtlasReport> {
  const startedAt = performance.now();
  throwIfAborted(signal);
  const core = await analyzeCoreProject(input.root, {
    signal,
    git: comparisonOptions(input.comparison),
    gitMetadataOverride: input.gitMetadataOverride,
    scan: {
      maxFiles: input.limits.maxFiles,
      maxFileBytes: input.limits.maxFileBytes,
      maxTotalBytes: input.limits.maxTotalBytes,
      countLines: true,
      includeSecretFiles: true,
      // Tests remain available to impact/test suggestions, while examples,
      // fixtures, generated code, vendored code, and docs stay out of the
      // production graph. Security applies its stricter production scope below.
      sourceScope:
        (input.scope ?? "production") === "all"
          ? "all"
          : ["production", "test"],
    },
    graph: { maxSourceBytes: input.limits.maxFileBytes },
    question: input.question,
    impact: {
      maxCandidates: 16,
      maxEvidencePerCandidate: 3,
      maxSuggestedTests: 6,
      propagationDepth: 2,
    },
  });
  const selectedGitChanges = core.git.changedFiles.filter((change) =>
    (input.scope ?? "production") === "all"
      ? true
      : sourceScopeIncluded(classifySourceScope({ path: change.path }), [
          "production",
          "test",
        ]),
  );
  const comparison = comparisonDescription(input.comparison);
  throwIfAborted(signal);
  const loaded = await loadAnalysisFiles(core, input.limits.maxFileBytes, signal);
  const reportScope = input.scope ?? "production";
  const inReportScope = (file: (typeof loaded.skipped)[number]) =>
    sourceScopeIncluded(
      file.sourceScope ?? classifySourceScope({ path: file.path, kind: file.kind }),
      reportScope,
    );
  const materialDeepSkips = loaded.skipped.filter(
    (file) =>
      inReportScope(file) &&
      (file.reason === "oversized" || file.reason === "read-failed"),
  );
  // ORM entities can live in ordinary source files. Once an oversized or
  // unreadable source is skipped, content-based schema support is unknowable,
  // so schema coverage must fail closed as partial too.
  const schemaDeepSkips = materialDeepSkips;
  const dependencyDeepSkips = materialDeepSkips.filter(
    (file) => isDependencyManifestPath(file.path),
  );
  const projectAnalysis = await analyzeProject(loaded.files, {
    signal,
    security: { sourceScope: input.scope ?? "production" },
    schemaSourceScope: input.scope ?? "production",
  });
  const advisoryDependencies = projectAnalysis.security.dependencies.flatMap(
    (dependency) => {
      const mapped = dependencyForAdvisoryLookup(dependency);
      return mapped ? [mapped] : [];
    },
  );
  const advisories = await lookupDependencyAdvisories(advisoryDependencies, {
    enabled: input.checkDependencies === true,
    signal,
  });
  const eligiblePackageCount = advisories.coverage.exactVersionPackages;

  const impact = impactSection(core);
  const security = securitySection(
    projectAnalysis.security,
    advisories,
    impact,
    core.scan.files,
    eligiblePackageCount,
  );
  const erd = schemaSection(projectAnalysis.schema, impact);
  const migration = await analyzeMigrationComparison({
    root: input.root,
    comparison,
    git: core.git,
    changes: selectedGitChanges,
    loadedFiles: loaded.files,
    impact,
    syntheticGit: input.gitMetadataOverride !== undefined,
    snapshotOverrides: input.gitFileSnapshotsOverride,
    maxFileBytes: input.limits.maxFileBytes,
    signal,
  });
  const ai = await synthesizeWithModel(
    {
      project: {
        name: core.discovery.name,
        languages: core.discovery.languages.map((language) => language.name),
        frameworks: core.discovery.frameworks.map((framework) => framework.name),
      },
      question: input.question,
      impact: impact.findings.map((finding) => ({
        path: finding.file,
        reason: finding.reason,
        excerpt: finding.evidence,
      })),
      security: security.findings.map((finding) => ({
        title: finding.title,
        severity: finding.severity,
        path: finding.file,
        evidence: finding.evidence,
      })),
      dataModel: erd.tables.map((table) => ({
        table: table.name,
        columns: table.columns.map((column) => `${column.name}: ${column.type}`),
      })),
    },
    { enabled: input.enableAi === true, signal },
  );

  const diagnostics = [
    ...loaded.diagnostics,
    ...core.scan.warnings.map((warning) =>
      warning.path ? `${warning.path}: ${warning.message}` : warning.message,
    ),
    ...core.graph.warnings.map((warning) =>
      warning.path ? `${warning.path}: ${warning.message}` : warning.message,
    ),
    ...(core.impact?.limitations ?? []),
    ...advisories.diagnostics,
    ...migration.diagnostics,
  ];
  if (ai.diagnostic) diagnostics.push(ai.diagnostic);
  if (projectAnalysis.schema.summary.inferredRelationshipCount > 0) {
    diagnostics.push(
      `${projectAnalysis.schema.summary.inferredRelationshipCount} database relationship(s) are inferred from naming conventions and shown with reduced confidence.`,
    );
  }
  if (!core.git.isRepository) {
    diagnostics.push("No Git metadata was available; impact ranking used project structure and the question.");
  }

  const configuredModel = modelIsConfigured();
  const endpointOrigin = configuredModel ? modelEndpointOrigin() : undefined;
  const dependencyStatus = osvExternalStatus(advisories.status);
  const osvRequestAttempted =
    input.checkDependencies === true && advisories.coverage.queriedPackages > 0;
  const aiRequestAttempted = ai.requestAttempted === true;
  const aiStatus: ExternalCheckStatus = !input.enableAi
    ? "not-requested"
    : !configuredModel
      ? "not-configured"
      : ai.enabled
        ? "complete"
        : "failed";
  const indexPartial = core.scan.truncated || core.scan.warnings.length > 0;
  const impactPartial = core.graph.warnings.length > 0;
  const securityPartial = materialDeepSkips.length > 0;
  const schemaPartial = schemaDeepSkips.length > 0;
  const dependencyPartial = dependencyDeepSkips.length > 0;
  const excludedSecurityFiles =
    (projectAnalysis.security.summary.excludedFileCount ?? 0) +
    materialDeepSkips.length;
  const stages: AtlasReport["run"]["stages"] = [
    {
      id: "index",
      status: indexPartial ? "partial" : "complete",
      detail: indexPartial
        ? `Indexed ${core.scan.files.length} files with ${core.scan.warnings.length} scan warning(s).`
        : `Indexed ${core.scan.files.length} files within configured budgets.`,
      analyzed: core.scan.files.length,
      skipped: core.scan.stats.ignoredEntries,
    },
    {
      id: "impact",
      status: impactPartial ? "partial" : "complete",
      detail: `${
        core.git.isRepository
          ? `Ranked ${impact.findings.length} leads from ${selectedGitChanges.length} selected Git change(s).`
          : `Ranked ${impact.findings.length} leads from project structure and the question.`
      }${impactPartial ? ` ${core.graph.warnings.length} graph input(s) were incomplete.` : ""}`,
      analyzed: impact.findings.length,
      skipped: core.graph.warnings.length,
    },
    {
      id: "security",
      status: securityPartial ? "partial" : "complete",
      detail: `Scanned ${projectAnalysis.security.summary.scannedFileCount} in-scope text files; skipped ${excludedSecurityFiles} out-of-scope, oversized, or unreadable file(s).`,
      analyzed: projectAnalysis.security.summary.scannedFileCount,
      skipped: excludedSecurityFiles,
    },
    {
      id: "dependencies",
      status:
        dependencyStatus === "not-requested"
          ? "not-run"
          : dependencyPartial
            ? "partial"
            : dependencyStatus === "skipped"
              ? "not-run"
          : dependencyStatus === "complete"
            ? "complete"
            : dependencyStatus === "partial"
              ? "partial"
              : "failed",
      detail:
        dependencyStatus === "not-requested"
          ? "OSV advisory lookup was not requested."
          : dependencyStatus === "skipped"
            ? `No exact resolved dependency versions were available for OSV lookup.${dependencyPartial ? ` ${dependencyDeepSkips.length} dependency source file(s) were oversized or unreadable.` : ""}`
            : `Queried ${advisories.coverage.queriedPackages} of ${advisories.coverage.exactVersionPackages} eligible package version(s).${dependencyPartial ? ` ${dependencyDeepSkips.length} dependency source file(s) were oversized or unreadable.` : ""}`,
      analyzed: advisories.coverage.queriedPackages,
      skipped:
        advisories.coverage.skippedNonExact + advisories.coverage.cappedPackages,
    },
    {
      id: "schema",
      status: schemaPartial ? "partial" : "complete",
      detail: `Mapped ${erd.tables.length} table(s) and ${erd.relationships.length} relationship(s) from in-scope sources.${schemaPartial ? ` ${schemaDeepSkips.length} potential schema source file(s) were oversized or unreadable.` : ""}`,
      analyzed: erd.tables.length,
      skipped: schemaDeepSkips.length,
    },
    {
      id: "migration",
      status: migration.status,
      detail:
        migration.status === "not-run"
          ? "No supported migration file was present in the selected Git comparison."
          : migration.status === "failed"
            ? "Migration before/after evidence could not be compared."
            : `Reviewed ${migration.summary.operations} introduced operation(s) across ${migration.summary.files} changed migration file(s); ${migration.summary.risks} require review.${migration.status === "partial" ? " Coverage is incomplete." : ""}`,
      analyzed: migration.summary.operations,
      skipped: migration.status === "partial" ? migration.diagnostics.length : 0,
    },
    {
      id: "ai",
      status:
        aiStatus === "not-requested" || aiStatus === "not-configured"
          ? "not-run"
          : aiStatus === "complete"
            ? "complete"
            : "failed",
      detail:
        aiStatus === "not-requested"
          ? "Model synthesis was not requested."
          : aiStatus === "not-configured"
            ? "Model synthesis was requested but no endpoint and model are configured."
            : ai.enabled
              ? `Synthesized bounded evidence with ${endpointOrigin ?? "the configured endpoint"}.`
              : "The configured model endpoint did not return a usable synthesis.",
    },
  ];
  const partial = stages.some(
    (stage) => stage.status === "partial" || stage.status === "failed",
  );
  return {
    id: randomUUID(),
    generatedAt: new Date().toISOString(),
    durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
    project: {
      name: core.discovery.name,
      path: input.publicPath,
      rootKind: core.git.isRepository ? "Git repository" : "Local directory",
      files: core.scan.files.length,
      lines: core.scan.files.reduce((sum, file) => sum + (file.lineCount ?? 0), 0),
      languages: core.discovery.languages.map((language) => ({
        name: language.name,
        files: language.fileCount,
      })),
      frameworks: core.discovery.frameworks.map((framework) => framework.name),
      git: core.git.isRepository
        ? {
            branch: core.git.branch,
            changedFiles: selectedGitChanges.map((file) => file.path),
            comparison,
            changes: selectedGitChanges.map((file) => ({
              path: file.path,
              previousPath: file.previousPath,
              status: file.status,
              staged: file.staged,
              unstaged: file.unstaged,
              additions: file.additions,
              deletions: file.deletions,
            })),
          }
        : undefined,
    },
    impact,
    security,
    erd,
    migration,
    ai: {
      configured: configuredModel,
      enabled: ai.enabled,
      summary: ai.summary,
      recommendations: ai.recommendations,
      endpointOrigin,
    },
    run: {
      scope: input.scope ?? "production",
      partial,
      stages,
    },
    external: {
      localByDefault: true,
      osv: {
        requested: input.checkDependencies === true,
        requestAttempted: osvRequestAttempted,
        status: dependencyStatus,
        queriedPackages: advisories.coverage.queriedPackages,
        eligiblePackages: eligiblePackageCount,
        wouldTransmit: [...OSV_REQUEST_FIELDS],
        transmitted: osvRequestAttempted ? [...OSV_REQUEST_FIELDS] : [],
      },
      ai: {
        requested: input.enableAi === true,
        configured: configuredModel,
        requestAttempted: aiRequestAttempted,
        status: aiStatus,
        endpointOrigin,
        wouldTransmit: [...AI_SYNTHESIS_REQUEST_FIELDS],
        transmitted: aiRequestAttempted
          ? [...AI_SYNTHESIS_REQUEST_FIELDS]
          : [],
      },
    },
    diagnostics,
  };
}

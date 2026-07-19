import { AnalyzerRegistry } from "../registry";
import type { AnalysisFile, FileAnalyzer } from "../types";
import {
  classifySourceScope,
  sourceScopeIncluded,
  type SourceScopeClassificationOptions,
} from "../../core/source-scope";
import type { SourceScope } from "../../core/types";
import {
  DependencyManifestAnalyzer,
  type DependencyManifestParser,
} from "./dependency-analyzer";
import { RiskPatternAnalyzer, type RiskPatternRule } from "./risk-analyzer";
import { SecretAnalyzer } from "./secret-analyzer";
import type {
  DependencyEcosystem,
  SecurityAnalysisResult,
  SecurityObservation,
  SecuritySeverity,
} from "./types";

export interface SecurityAnalyzerOptions {
  signal?: AbortSignal;
  includeDefaults?: boolean;
  analyzers?: readonly FileAnalyzer<SecurityObservation>[];
  riskRules?: readonly RiskPatternRule[];
  dependencyParsers?: readonly DependencyManifestParser[];
  /** Production files are analyzed by default; `all` includes tests and examples. */
  sourceScope?: "production" | "all" | readonly SourceScope[];
  sourceScopeRules?: SourceScopeClassificationOptions["rules"];
  extendSourceScopeRules?: SourceScopeClassificationOptions["extendRules"];
}

export function createSecurityRegistry(
  options: Omit<SecurityAnalyzerOptions, "signal"> = {},
): AnalyzerRegistry<SecurityObservation> {
  const registry = new AnalyzerRegistry<SecurityObservation>("security");
  if (options.includeDefaults !== false) {
    registry.register(new SecretAnalyzer());
    registry.register(new RiskPatternAnalyzer(options.riskRules));
    registry.register(new DependencyManifestAnalyzer(options.dependencyParsers));
  }
  for (const analyzer of options.analyzers ?? []) registry.register(analyzer);
  return registry;
}

export async function analyzeSecurity(
  files: readonly AnalysisFile[],
  options: SecurityAnalyzerOptions = {},
): Promise<SecurityAnalysisResult> {
  const registry = createSecurityRegistry(options);
  const scopeSelection = options.sourceScope ?? "production";
  const scopedFiles = files.map((file) => ({
    file,
    sourceScope:
      options.sourceScopeRules || options.extendSourceScopeRules
        ? classifySourceScope(
            { path: file.path },
            {
              rules: options.sourceScopeRules,
              extendRules: options.extendSourceScopeRules,
            },
          )
        : file.sourceScope ?? classifySourceScope({ path: file.path }),
  }));
  const selectedFiles = scopedFiles
    .filter(({ sourceScope }) => sourceScopeIncluded(sourceScope, scopeSelection))
    .map(({ file }) => file);
  const run = await registry.run(selectedFiles, options.signal);
  const scopeByPath = new Map(
    scopedFiles.map(({ file, sourceScope }) => [
      file.path.replaceAll("\\", "/"),
      sourceScope,
    ]),
  );
  const findings = run.observations
    .filter((observation) => observation.kind === "finding")
    .map((finding) => ({
      ...finding,
      sourceScope: scopeByPath.get(finding.evidence.provenance.path),
    }))
    .sort(compareFindings);
  const dependencies = run.observations
    .filter((observation) => observation.kind === "dependency")
    .map((dependency) => ({
      ...dependency,
      sourceScope: scopeByPath.get(dependency.provenance.path),
    }))
    .sort((left, right) =>
      `${left.ecosystem}:${left.name}:${left.scope}`.localeCompare(
        `${right.ecosystem}:${right.name}:${right.scope}`,
      ),
    );

  const findingCountBySeverity: Record<SecuritySeverity, number> = {
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  for (const finding of findings) findingCountBySeverity[finding.severity] += 1;

  const dependencyCountByEcosystem: Partial<
    Record<DependencyEcosystem, number>
  > = {};
  for (const dependency of dependencies) {
    dependencyCountByEcosystem[dependency.ecosystem] =
      (dependencyCountByEcosystem[dependency.ecosystem] ?? 0) + 1;
  }

  const pathsByScope = new Map<SourceScope, Set<string>>();
  for (const { file, sourceScope } of scopedFiles) {
    if (!sourceScopeIncluded(sourceScope, scopeSelection)) continue;
    const paths = pathsByScope.get(sourceScope) ?? new Set<string>();
    paths.add(file.path.replaceAll("\\", "/"));
    pathsByScope.set(sourceScope, paths);
  }
  const scannedFileCountByScope = Object.fromEntries(
    [...pathsByScope].map(([scope, paths]) => [scope, paths.size]),
  ) as Partial<Record<SourceScope, number>>;
  const inputFileCount = new Set(files.map((file) => file.path)).size;
  const scannedFileCount = new Set(selectedFiles.map((file) => file.path)).size;

  return {
    findings,
    dependencies,
    executions: run.executions,
    summary: {
      scannedFileCount,
      inputFileCount,
      excludedFileCount: inputFileCount - scannedFileCount,
      sourceScope:
        scopeSelection === "production" || scopeSelection === "all"
          ? scopeSelection
          : "custom",
      scannedFileCountByScope,
      findingCountBySeverity,
      dependencyCountByEcosystem,
    },
  };
}

function compareFindings(
  left: SecurityAnalysisResult["findings"][number],
  right: SecurityAnalysisResult["findings"][number],
): number {
  const rank: Record<SecuritySeverity, number> = {
    critical: 5,
    high: 4,
    medium: 3,
    low: 2,
    info: 1,
  };
  return (
    rank[right.severity] - rank[left.severity] ||
    left.evidence.provenance.path.localeCompare(right.evidence.provenance.path) ||
    left.evidence.provenance.range.start.offset -
      right.evidence.provenance.range.start.offset
  );
}

export * from "./types";
export * from "./secret-analyzer";
export * from "./risk-analyzer";
export * from "./dependency-analyzer";

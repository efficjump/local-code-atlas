export type ReportSeverity = "critical" | "high" | "medium" | "low" | "info";
export type ProjectScope = "production" | "all";
export type GitComparisonMode = "working-tree" | "staged" | "base";
export type RunStageStatus = "complete" | "partial" | "not-run" | "failed";
export type ExternalCheckStatus =
  | "not-requested"
  | "complete"
  | "partial"
  | "not-configured"
  | "skipped"
  | "failed";

export interface AtlasReport {
  id: string;
  generatedAt: string;
  durationMs: number;
  project: {
    name: string;
    path: string;
    rootKind: "Git repository" | "Local directory";
    files: number;
    lines: number;
    languages: Array<{ name: string; files: number }>;
    frameworks: string[];
    git?: {
      branch?: string;
      changedFiles: string[];
      comparison: {
        mode: GitComparisonMode;
        base?: string;
        label: string;
      };
      changes: Array<{
        path: string;
        previousPath?: string;
        status: string;
        staged: boolean;
        unstaged: boolean;
        additions?: number;
        deletions?: number;
      }>;
    };
  };
  impact: {
    question: string;
    findings: Array<{
      file: string;
      line?: number;
      score: number;
      confidence: "high" | "medium" | "low";
      graphDistance: number;
      changed: boolean;
      reason: string;
      evidence?: string;
    }>;
    suggestedTests: string[];
  };
  security: {
    summary: Record<"critical" | "high" | "medium" | "low" | "info", number>;
    findings: Array<{
      id: string;
      title: string;
      severity: ReportSeverity;
      category: string;
      file: string;
      line?: number;
      evidence: string;
      remediation: string;
      confidence: number;
      scope:
        | "production"
        | "test"
        | "example"
        | "fixture"
        | "documentation"
        | "generated"
        | "vendor"
        | "configuration";
      sourceKind: "source" | "dependency";
      relevance: "direct" | "indirect" | "project";
      advisoryUrl?: string;
    }>;
    dependencies: {
      total: number;
      exact: number;
      eligibleForAdvisoryLookup: number;
      ecosystems: Record<string, number>;
    };
  };
  erd: {
    tables: Array<{
      name: string;
      sourceFile: string;
      line?: number;
      relevance: "direct" | "indirect" | "project";
      columns: Array<{
        name: string;
        type: string;
        nullable?: boolean;
        primaryKey?: boolean;
        foreignKey?: { table: string; column: string };
      }>;
    }>;
    relationships: Array<{
      fromTable: string;
      fromColumn: string;
      toTable: string;
      toColumn: string;
      kind?: string;
      confidence: number;
      origin: "declared" | "inferred";
      source?: string;
      sourceFile?: string;
      line?: number;
      relevance: "direct" | "indirect" | "project";
    }>;
  };
  migration: {
    status: RunStageStatus;
    comparison?: {
      mode: GitComparisonMode;
      label: string;
      beforeSource?: "HEAD" | "merge-base" | "synthetic baseline";
      afterSource?: "working-tree" | "index" | "HEAD" | "fixture";
    };
    summary: {
      files: number;
      operations: number;
      risks: number;
      destructive: number;
      safe: number;
      bySeverity: Record<ReportSeverity, number>;
    };
    risks: Array<{
      id: string;
      label: string;
      semanticKey: string;
      category: string;
      severity: ReportSeverity;
      destructive: boolean;
      safe: boolean;
      confidence: number;
      explanation: string;
      remediation: string;
      namespace?: string;
      table?: string;
      column?: string;
      nextName?: string;
      file: string;
      line?: number;
      relevance: "direct" | "indirect" | "project";
      introduced: true;
    }>;
    diagnostics: string[];
  };
  ai: {
    configured: boolean;
    enabled: boolean;
    summary?: string;
    recommendations?: string[];
    endpointOrigin?: string;
  };
  run: {
    scope: ProjectScope;
    partial: boolean;
    stages: Array<{
      id:
        | "index"
        | "impact"
        | "security"
        | "dependencies"
        | "schema"
        | "migration"
        | "ai";
      status: RunStageStatus;
      detail: string;
      analyzed?: number;
      skipped?: number;
    }>;
  };
  external: {
    localByDefault: true;
    osv: {
      requested: boolean;
      requestAttempted: boolean;
      status: ExternalCheckStatus;
      queriedPackages: number;
      eligiblePackages: number;
      wouldTransmit: string[];
      transmitted: string[];
    };
    ai: {
      requested: boolean;
      configured: boolean;
      requestAttempted: boolean;
      status: ExternalCheckStatus;
      endpointOrigin?: string;
      wouldTransmit: string[];
      transmitted: string[];
    };
  };
  diagnostics: string[];
}

export interface AnalyzeRequest {
  projectPath?: string;
  sample?: boolean;
  question?: string;
  enableAi?: boolean;
  checkDependencies?: boolean;
  scope?: ProjectScope;
  comparison?: {
    mode: GitComparisonMode;
    base?: string;
  };
}

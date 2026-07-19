"use client";

import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import packageMetadata from "../../package.json";
import {
  AI_SYNTHESIS_REQUEST_FIELDS,
  OSV_REQUEST_FIELDS,
} from "../../src/privacy/external-data";

export type AtlasSeverity = "critical" | "high" | "medium" | "low" | "info";
export type AtlasRelationshipOrigin = "declared" | "inferred" | "unknown";
export type AtlasStageStatus = "complete" | "partial" | "not-run" | "failed";
export type AtlasSecurityScope =
  | "production"
  | "test"
  | "example"
  | "fixture"
  | "documentation"
  | "generated"
  | "vendor"
  | "configuration"
  | "unknown";
export type AtlasSecuritySourceKind = "source" | "dependency";
export type AtlasEvidenceRelevance = "direct" | "indirect" | "project" | "unknown";

export interface AtlasUiError {
  code: string;
  message: string;
  requestId?: string;
}

export interface AtlasRequestContext {
  checkDependencies?: boolean;
  enableAi?: boolean;
}

export interface AtlasHealth {
  service: "local-code-atlas-engine";
  status: "ok";
  version: string;
  localOnly: boolean;
  allowedRootsConfigured: boolean;
  external: {
    localByDefault: boolean;
    osv: {
      available: boolean;
      wouldTransmit: string[];
    };
    ai: {
      configured: boolean;
      endpointOrigin?: string;
      wouldTransmit: string[];
    };
  };
}

export interface AtlasAnalysis {
  id: string;
  generatedAt: string;
  durationMs?: number;
  stale: boolean;
  project: {
    name: string;
    path: string;
    rootKind?: string;
    files: number;
    lines: number;
    languages: Array<{ name: string; files: number }>;
    frameworks: string[];
    git?: {
      branch?: string;
      changedFiles: string[];
      changes: Array<{
        path: string;
        status: string;
        staged: boolean;
        unstaged: boolean;
        additions?: number;
        deletions?: number;
      }>;
      comparison?: {
        mode: "working-tree" | "staged" | "base" | "unknown";
        base?: string;
        label: string;
      };
    };
  };
  impact: {
    question: string;
    findings: Array<{
      file: string;
      line?: number;
      score: number;
      reason: string;
      evidence?: string;
      confidence?: string;
      graphDistance?: number;
      changed: boolean;
      relevance: AtlasEvidenceRelevance;
    }>;
    suggestedTests: string[];
  };
  security: {
    summary: { critical: number; high: number; medium: number; low: number; info: number };
    findings: Array<{
      id: string;
      title: string;
      severity: AtlasSeverity;
      category: string;
      file: string;
      line?: number;
      evidence: string;
      remediation: string;
      confidence: number;
      scope: AtlasSecurityScope;
      sourceKind: AtlasSecuritySourceKind;
      advisoryUrl?: string;
      relevance: AtlasEvidenceRelevance;
    }>;
    dependencies?: {
      total: number;
      exact?: number;
      eligibleForAdvisoryLookup?: number;
      ecosystems: Record<string, number>;
    };
  };
  erd: {
    tables: Array<{
      name: string;
      sourceFile: string;
      line?: number;
      relevance: AtlasEvidenceRelevance;
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
      source?: string;
      origin: AtlasRelationshipOrigin;
      relevance: AtlasEvidenceRelevance;
    }>;
  };
  ai: {
    enabled: boolean;
    summary?: string;
    recommendations?: string[];
  };
  run: {
    scope: "production" | "all" | "unknown";
    partial: boolean;
    stages: Array<{
      id: string;
      status: AtlasStageStatus;
      detail: string;
      analyzed?: number;
      skipped?: number;
    }>;
  };
  external: {
    localByDefault: boolean;
    osv: {
      requested: boolean;
      requestAttempted: boolean;
      status: string;
      queriedPackages?: number;
      eligiblePackages?: number;
      wouldTransmit: string[];
      transmitted: string[];
    };
    ai: {
      requested: boolean;
      configured: boolean;
      requestAttempted: boolean;
      status: string;
      endpointOrigin?: string;
      wouldTransmit: string[];
      transmitted: string[];
    };
  };
  diagnostics?: string[];
}

type View = "overview" | "impact" | "security" | "data";
type RequestStatus = "idle" | "loading" | "ready" | "error";
type ApiStatus = "checking" | "online" | "offline";
type SecuritySeverityFilter = "all" | AtlasSeverity;
type RelationshipFilter = "all" | Exclude<AtlasRelationshipOrigin, "unknown">;
type RelevanceFilter = "all" | Exclude<AtlasEvidenceRelevance, "unknown">;
type ComparisonMode = "working-tree" | "staged" | "base";
interface AnalysisInput {
  projectPath?: string;
  question: string;
  sample?: boolean;
  checkDependencies: boolean;
  enableAi: boolean;
  comparison: { mode: ComparisonMode; base?: string };
  scope: "production" | "all";
}

const DEFAULT_API_URL = "http://127.0.0.1:4317/api/analyze";
const API_URL = process.env.NEXT_PUBLIC_ATLAS_API_URL || DEFAULT_API_URL;
const APP_VERSION = packageMetadata.version;
export function healthUrlFor(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    url.pathname = url.pathname.replace(/\/api\/analyze\/?$/u, "/api/health");
    if (!url.pathname.endsWith("/api/health")) url.pathname = "/api/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return apiUrl.replace(/\/api\/analyze\/?$/u, "/api/health");
  }
}
const HEALTH_URL = healthUrlFor(API_URL);
const SAMPLE_QUESTION =
  "If session expiration changes and user deletion stops cascading to sessions, what code, tests, security controls, and database relationships are affected?";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toStringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeConfidence(value: unknown): number {
  const numeric = toNumber(value);
  return Math.max(0, Math.min(1, numeric > 1 ? numeric / 100 : numeric));
}

function normalizeSeverity(value: unknown): AtlasSeverity {
  return ["critical", "high", "medium", "low", "info"].includes(String(value))
    ? (value as AtlasSeverity)
    : "info";
}

function normalizeSecurityScope(value: unknown): AtlasSecurityScope {
  const scope = toStringValue(value).toLowerCase();
  return [
    "production",
    "test",
    "example",
    "fixture",
    "documentation",
    "generated",
    "vendor",
    "configuration",
  ].includes(scope)
    ? (scope as AtlasSecurityScope)
    : "unknown";
}

function normalizeEvidenceRelevance(value: unknown): AtlasEvidenceRelevance {
  const relevance = toStringValue(value).toLowerCase();
  return ["direct", "indirect", "project"].includes(relevance)
    ? (relevance as AtlasEvidenceRelevance)
    : "unknown";
}

function normalizeRelationshipOrigin(
  value: unknown,
  source: unknown,
): AtlasRelationshipOrigin {
  const explicit = toStringValue(value).toLowerCase();
  if (explicit === "declared" || explicit === "inferred") return explicit;
  const provenance = toStringValue(source).trim().toLowerCase();
  if (/^declared\b/u.test(provenance)) return "declared";
  if (/^inferred\b/u.test(provenance)) return "inferred";
  return "unknown";
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
  return toArray(value).map((entry) => toStringValue(entry)).filter(Boolean);
}

export class AtlasHealthContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AtlasHealthContractError";
  }
}

export function normalizeAtlasHealth(payload: unknown): AtlasHealth {
  const root = isRecord(payload) ? payload : {};
  const external = isRecord(root.external) ? root.external : {};
  const osv = isRecord(external.osv) ? external.osv : {};
  const ai = isRecord(external.ai) ? external.ai : {};
  const osvFields = stringList(osv.wouldTransmit);
  const aiFields = stringList(ai.wouldTransmit);
  const valid =
    root.service === "local-code-atlas-engine" &&
    root.status === "ok" &&
    Boolean(toStringValue(root.version).trim()) &&
    typeof root.localOnly === "boolean" &&
    typeof root.allowedRootsConfigured === "boolean" &&
    typeof external.localByDefault === "boolean" &&
    typeof osv.available === "boolean" &&
    Array.isArray(osv.wouldTransmit) &&
    typeof ai.configured === "boolean" &&
    Array.isArray(ai.wouldTransmit) &&
    osvFields.length > 0 &&
    aiFields.length > 0;
  if (!valid) {
    throw new AtlasHealthContractError(
      "The configured analyzer returned an unrecognized health contract.",
    );
  }

  return {
    service: "local-code-atlas-engine",
    status: "ok",
    version: toStringValue(root.version),
    localOnly: root.localOnly as boolean,
    allowedRootsConfigured: root.allowedRootsConfigured as boolean,
    external: {
      localByDefault: external.localByDefault as boolean,
      osv: {
        available: osv.available as boolean,
        wouldTransmit: osvFields,
      },
      ai: {
        configured: ai.configured === true,
        endpointOrigin: toStringValue(ai.endpointOrigin) || undefined,
        wouldTransmit: aiFields,
      },
    },
  };
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
}

export function normalizeAtlasApiError(
  payload: unknown,
  status?: number,
): AtlasUiError {
  const root = isRecord(payload) ? payload : {};
  const error = isRecord(root.error) ? root.error : {};
  return {
    code: toStringValue(
      error.code,
      status ? `HTTP_${status}` : "ANALYSIS_FAILED",
    ),
    message: toStringValue(
      error.message,
      typeof root.error === "string"
        ? root.error
        : status
          ? `The analyzer returned HTTP ${status}.`
          : "Atlas could not complete this analysis.",
    ),
    requestId: toStringValue(error.requestId) || undefined,
  };
}

class AtlasRequestFailure extends Error {
  readonly detail: AtlasUiError;

  constructor(detail: AtlasUiError) {
    super(detail.message);
    this.name = "AtlasRequestFailure";
    this.detail = detail;
  }
}

function assertAtlasReportContract(root: Record<string, unknown>): void {
  const missing: string[] = [];
  const requireRecord = (key: string, value: unknown) => {
    if (!isRecord(value)) missing.push(key);
  };
  const requireArray = (key: string, value: unknown) => {
    if (!Array.isArray(value)) missing.push(key);
  };

  if (!toStringValue(root.id).trim()) missing.push("id");
  if (!toStringValue(root.generatedAt).trim()) missing.push("generatedAt");

  requireRecord("project", root.project);
  requireRecord("impact", root.impact);
  requireRecord("security", root.security);
  requireRecord("erd", root.erd);
  requireRecord("ai", root.ai);
  requireRecord("run", root.run);
  requireRecord("external", root.external);

  const project = isRecord(root.project) ? root.project : {};
  if (!toStringValue(project.name).trim()) missing.push("project.name");
  if (!toStringValue(project.path).trim()) missing.push("project.path");
  if (typeof project.files !== "number") missing.push("project.files");
  if (typeof project.lines !== "number") missing.push("project.lines");
  requireArray("project.languages", project.languages);
  requireArray("project.frameworks", project.frameworks);

  const impact = isRecord(root.impact) ? root.impact : {};
  requireArray("impact.findings", impact.findings);
  requireArray("impact.suggestedTests", impact.suggestedTests);

  const security = isRecord(root.security) ? root.security : {};
  requireRecord("security.summary", security.summary);
  requireArray("security.findings", security.findings);
  requireRecord("security.dependencies", security.dependencies);

  const erd = isRecord(root.erd) ? root.erd : {};
  requireArray("erd.tables", erd.tables);
  requireArray("erd.relationships", erd.relationships);

  const run = isRecord(root.run) ? root.run : {};
  if (typeof run.partial !== "boolean") missing.push("run.partial");
  if (run.scope !== "production" && run.scope !== "all") missing.push("run.scope");
  if (!Array.isArray(run.stages) || run.stages.length === 0) {
    missing.push("run.stages");
  }

  const external = isRecord(root.external) ? root.external : {};
  if (typeof external.localByDefault !== "boolean") {
    missing.push("external.localByDefault");
  }
  for (const capability of ["osv", "ai"] as const) {
    const detail = isRecord(external[capability]) ? external[capability] : {};
    requireRecord(`external.${capability}`, external[capability]);
    if (typeof detail.requested !== "boolean") {
      missing.push(`external.${capability}.requested`);
    }
    requireArray(`external.${capability}.wouldTransmit`, detail.wouldTransmit);
    requireArray(`external.${capability}.transmitted`, detail.transmitted);
  }

  if (missing.length > 0) {
    throw new AtlasRequestFailure({
      code: "INVALID_ANALYSIS_RESPONSE",
      message: `The analyzer returned an incomplete evidence contract (${[...new Set(missing)].join(", ")}). No clean result was assumed.`,
    });
  }
}

/**
 * Keeps the workbench usable when an early backend returns a partial payload or
 * wraps the analysis in `data`, `result`, or `analysis`.
 */
export function normalizeAtlasAnalysis(
  payload: unknown,
  requestContext: AtlasRequestContext = {},
): AtlasAnalysis {
  const outer = isRecord(payload) ? payload : {};
  const wrapped = outer.data ?? outer.result ?? outer.analysis ?? outer;
  const root = isRecord(wrapped) ? wrapped : {};
  assertAtlasReportContract(root);
  const project = isRecord(root.project) ? root.project : {};
  const git = isRecord(project.git) ? project.git : undefined;
  const impact = isRecord(root.impact) ? root.impact : {};
  const security = isRecord(root.security) ? root.security : {};
  const securitySummary = isRecord(security.summary) ? security.summary : {};
  const erdCandidate = root.erd ?? root.dataMap;
  const erd = isRecord(erdCandidate) ? erdCandidate : {};
  const ai = isRecord(root.ai) ? root.ai : {};
  const run = isRecord(root.run) ? root.run : {};
  const external = isRecord(root.external) ? root.external : {};
  const externalOsv = isRecord(external.osv) ? external.osv : {};
  const externalAi = isRecord(external.ai) ? external.ai : {};
  const dependencies = isRecord(security.dependencies)
    ? security.dependencies
    : undefined;

  const changedFiles = git ? stringList(git.changedFiles) : [];
  const rawChanges = git ? toArray(git.changes) : [];
  const changes = rawChanges.length
    ? rawChanges.map((entry) => {
        const change = isRecord(entry) ? entry : {};
        return {
          path: toStringValue(change.path, "Unknown path"),
          status: toStringValue(change.status, "changed"),
          staged: change.staged === true,
          unstaged: change.unstaged === true,
          additions: optionalNumber(change.additions),
          deletions: optionalNumber(change.deletions),
        };
      })
    : changedFiles.map((path) => ({
        path,
        status: "changed",
        staged: false,
        unstaged: false,
      }));
  const comparisonCandidate = git && isRecord(git.comparison)
    ? git.comparison
    : undefined;
  const comparisonMode = toStringValue(comparisonCandidate?.mode);
  const comparison = comparisonCandidate
    ? {
        mode: (["working-tree", "staged", "base"].includes(comparisonMode)
          ? comparisonMode
          : "unknown") as "working-tree" | "staged" | "base" | "unknown",
        base: toStringValue(comparisonCandidate.base) || undefined,
        label: toStringValue(
          comparisonCandidate.label,
          comparisonMode === "base"
            ? `Changes from ${toStringValue(comparisonCandidate.base, "base")}`
            : comparisonMode === "staged"
              ? "Staged changes"
              : "Working tree",
        ),
      }
    : undefined;

  const securityFindings = toArray(security.findings).map((entry, index) => {
    const finding = isRecord(entry) ? entry : {};
    return {
      id: toStringValue(finding.id, `finding-${index + 1}`),
      title: toStringValue(finding.title, "Untitled security finding"),
      severity: normalizeSeverity(finding.severity),
      category: toStringValue(finding.category, "Uncategorized"),
      file: toStringValue(finding.file, "Unknown source"),
      line: toNumber(finding.line) || undefined,
      evidence: toStringValue(finding.evidence, "No evidence was provided."),
      remediation: toStringValue(
        finding.remediation,
        "Review the finding and define a project-specific remediation.",
      ),
      confidence: normalizeConfidence(finding.confidence),
      scope: normalizeSecurityScope(finding.scope),
      sourceKind:
        toStringValue(finding.sourceKind).toLowerCase() === "dependency" ||
        toStringValue(finding.category).toLowerCase() === "supply-chain"
          ? ("dependency" as const)
          : ("source" as const),
      advisoryUrl: toStringValue(finding.advisoryUrl) || undefined,
      relevance: normalizeEvidenceRelevance(finding.relevance),
    };
  });

  const derivedSeverityCount = (severity: AtlasSeverity) =>
    securityFindings.filter((finding) => finding.severity === severity).length;

  return {
    id: toStringValue(root.id, `analysis-${Date.now()}`),
    generatedAt: toStringValue(root.generatedAt, new Date().toISOString()),
    durationMs: optionalNumber(root.durationMs),
    stale: root.stale === true || run.stale === true,
    project: {
      name: toStringValue(project.name, "Local project"),
      path: toStringValue(project.path, "Path unavailable"),
      rootKind: toStringValue(project.rootKind) || undefined,
      files: toNumber(project.files),
      lines: toNumber(project.lines),
      languages: toArray(project.languages).map((entry) => {
        if (typeof entry === "string") return { name: entry, files: 0 };
        const language = isRecord(entry) ? entry : {};
        return {
          name: toStringValue(language.name, "Unknown"),
          files: toNumber(language.files),
        };
      }),
      frameworks: toArray(project.frameworks)
        .map((entry) => toStringValue(entry))
        .filter(Boolean),
      git: git
        ? {
            branch: toStringValue(git.branch) || undefined,
            changedFiles: changes.map((change) => change.path),
            changes,
            comparison,
          }
        : undefined,
    },
    impact: {
      question: toStringValue(impact.question, "Project impact analysis"),
      findings: toArray(impact.findings).map((entry) => {
        const finding = isRecord(entry) ? entry : {};
        return {
          file: toStringValue(finding.file, "Unknown source"),
          line: toNumber(finding.line) || undefined,
          score: normalizeConfidence(finding.score),
          reason: toStringValue(finding.reason, "Related code path detected."),
          evidence: toStringValue(finding.evidence) || undefined,
          confidence: toStringValue(finding.confidence) || undefined,
          graphDistance: optionalNumber(finding.graphDistance),
          changed: finding.changed === true,
          relevance: normalizeEvidenceRelevance(finding.relevance),
        };
      }),
      suggestedTests: toArray(impact.suggestedTests)
        .map((entry) => toStringValue(entry))
        .filter(Boolean),
    },
    security: {
      summary: {
        critical: toNumber(
          securitySummary.critical,
          derivedSeverityCount("critical"),
        ),
        high: toNumber(securitySummary.high, derivedSeverityCount("high")),
        medium: toNumber(
          securitySummary.medium,
          derivedSeverityCount("medium"),
        ),
        low: toNumber(securitySummary.low, derivedSeverityCount("low")),
        info: toNumber(securitySummary.info, derivedSeverityCount("info")),
      },
      findings: securityFindings,
      dependencies: dependencies
        ? {
            total: toNumber(dependencies.total),
            exact: optionalNumber(dependencies.exact),
            eligibleForAdvisoryLookup: optionalNumber(
              dependencies.eligibleForAdvisoryLookup,
            ),
            ecosystems: numberRecord(dependencies.ecosystems),
          }
        : undefined,
    },
    erd: {
      tables: toArray(erd.tables).map((entry) => {
        const table = isRecord(entry) ? entry : {};
        return {
          name: toStringValue(table.name, "unnamed_table"),
          sourceFile: toStringValue(table.sourceFile, "Unknown schema source"),
          line: toNumber(table.line) || undefined,
          relevance: normalizeEvidenceRelevance(table.relevance),
          columns: toArray(table.columns).map((columnEntry) => {
            const column = isRecord(columnEntry) ? columnEntry : {};
            const foreignKey = isRecord(column.foreignKey)
              ? column.foreignKey
              : undefined;
            return {
              name: toStringValue(column.name, "unnamed_column"),
              type: toStringValue(column.type, "unknown"),
              nullable: Boolean(column.nullable),
              primaryKey: Boolean(column.primaryKey),
              foreignKey: foreignKey
                ? {
                    table: toStringValue(foreignKey.table, "unknown"),
                    column: toStringValue(foreignKey.column, "unknown"),
                  }
                : undefined,
            };
          }),
        };
      }),
      relationships: toArray(erd.relationships).map((entry) => {
        const relationship = isRecord(entry) ? entry : {};
        return {
          fromTable: toStringValue(relationship.fromTable, "unknown"),
          fromColumn: toStringValue(relationship.fromColumn, "unknown"),
          toTable: toStringValue(relationship.toTable, "unknown"),
          toColumn: toStringValue(relationship.toColumn, "unknown"),
          kind: toStringValue(relationship.kind) || undefined,
          confidence: normalizeConfidence(relationship.confidence),
          source: toStringValue(relationship.source) || undefined,
          origin: normalizeRelationshipOrigin(
            relationship.origin ?? relationship.declaration,
            relationship.source,
          ),
          relevance: normalizeEvidenceRelevance(relationship.relevance),
        };
      }),
    },
    ai: {
      enabled:
        typeof ai.enabled === "boolean" ? ai.enabled : Boolean(ai.summary),
      summary: toStringValue(ai.summary) || undefined,
      recommendations: toArray(ai.recommendations)
        .map((entry) => toStringValue(entry))
        .filter(Boolean),
    },
    run: {
      scope:
        run.scope === "production" || run.scope === "all"
          ? run.scope
          : "unknown",
      partial: run.partial === true,
      stages: toArray(run.stages).map((entry, index) => {
        const stage = isRecord(entry) ? entry : {};
        const status = toStringValue(stage.status);
        return {
          id: toStringValue(stage.id, `stage-${index + 1}`),
          status: (["complete", "partial", "not-run", "failed"].includes(status)
            ? status
            : "partial") as AtlasStageStatus,
          detail: toStringValue(stage.detail, "No stage detail was provided."),
          analyzed: optionalNumber(stage.analyzed),
          skipped: optionalNumber(stage.skipped),
        };
      }),
    },
    external: {
      localByDefault:
        typeof external.localByDefault === "boolean"
          ? external.localByDefault
          : true,
      osv: {
        requested:
          typeof externalOsv.requested === "boolean"
            ? externalOsv.requested
            : requestContext.checkDependencies === true,
        status: toStringValue(
          externalOsv.status,
          requestContext.checkDependencies ? "unknown" : "not-requested",
        ),
        queriedPackages: optionalNumber(externalOsv.queriedPackages),
        eligiblePackages: optionalNumber(externalOsv.eligiblePackages),
        requestAttempted:
          externalOsv.requestAttempted === true ||
          stringList(externalOsv.transmitted).length > 0,
        wouldTransmit: stringList(
          externalOsv.wouldTransmit ?? externalOsv.transmitted,
        ),
        transmitted: stringList(externalOsv.transmitted),
      },
      ai: {
        requested:
          typeof externalAi.requested === "boolean"
            ? externalAi.requested
            : requestContext.enableAi === true,
        configured:
          typeof externalAi.configured === "boolean"
            ? externalAi.configured
            : ai.configured === true,
        status: toStringValue(
          externalAi.status,
          requestContext.enableAi
            ? ai.enabled === true
              ? "complete"
              : "unknown"
            : "not-requested",
        ),
        endpointOrigin: toStringValue(externalAi.endpointOrigin) || undefined,
        requestAttempted:
          externalAi.requestAttempted === true ||
          stringList(externalAi.transmitted).length > 0,
        wouldTransmit: stringList(
          externalAi.wouldTransmit ?? externalAi.transmitted,
        ),
        transmitted: stringList(externalAi.transmitted),
      },
    },
    diagnostics: toArray(root.diagnostics)
      .map((entry) => toStringValue(entry))
      .filter(Boolean),
  };
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function relativeRelevanceLabel(value: number, maximum: number): string {
  if (maximum <= 0) return "Exploratory";
  const relative = value / maximum;
  if (relative >= 0.9) return "Closest match";
  if (relative >= 0.65) return "Strongly related";
  if (relative >= 0.4) return "Related";
  return "Exploratory";
}

function sourceLabel(file: string, line?: number): string {
  return `${file}${line ? `:${line}` : ""}`;
}

const VIEWS: Array<{ id: View; label: string; short: string }> = [
  { id: "overview", label: "Overview", short: "01" },
  { id: "impact", label: "Impact", short: "02" },
  { id: "security", label: "Security", short: "03" },
  { id: "data", label: "Data map", short: "04" },
];

type AtlasTable = AtlasAnalysis["erd"]["tables"][number];
type AtlasRelationship = AtlasAnalysis["erd"]["relationships"][number];

export interface ErdGraphNodeLayout {
  id: string;
  table: AtlasTable;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ErdGraphEdgeLayout {
  id: string;
  relationship: AtlasRelationship;
  path: string;
  labelX: number;
  labelY: number;
}

export interface ErdGraphLayout {
  width: number;
  height: number;
  nodes: ErdGraphNodeLayout[];
  edges: ErdGraphEdgeLayout[];
}

/** Deterministic geometry keeps the ERD usable without a canvas dependency. */
export function buildErdGraphLayout(
  tables: readonly AtlasTable[],
  relationships: readonly AtlasRelationship[],
): ErdGraphLayout {
  const nodeWidth = 244;
  const nodeHeight = 208;
  const horizontalGap = 92;
  const verticalGap = 70;
  const padding = 34;
  const columnCount = Math.max(
    1,
    Math.min(4, Math.ceil(Math.sqrt(Math.max(1, tables.length) * 1.35))),
  );
  const nodes = tables.map((table, index) => ({
    id: `table-${index}-${table.name}`,
    table,
    x: padding + (index % columnCount) * (nodeWidth + horizontalGap),
    y: padding + Math.floor(index / columnCount) * (nodeHeight + verticalGap),
    width: nodeWidth,
    height: nodeHeight,
  }));
  const nodeByTable = new Map(
    nodes.map((node) => [node.table.name.toLocaleLowerCase(), node]),
  );
  const edges = relationships.flatMap((relationship, index) => {
    const from = nodeByTable.get(relationship.fromTable.toLocaleLowerCase());
    const to = nodeByTable.get(relationship.toTable.toLocaleLowerCase());
    if (!from || !to) return [];

    const fromCenter = {
      x: from.x + from.width / 2,
      y: from.y + from.height / 2,
    };
    const toCenter = {
      x: to.x + to.width / 2,
      y: to.y + to.height / 2,
    };
    const horizontal = Math.abs(toCenter.x - fromCenter.x) >= Math.abs(toCenter.y - fromCenter.y);
    const start = horizontal
      ? {
          x: toCenter.x >= fromCenter.x ? from.x + from.width : from.x,
          y: fromCenter.y,
        }
      : {
          x: fromCenter.x,
          y: toCenter.y >= fromCenter.y ? from.y + from.height : from.y,
        };
    const end = horizontal
      ? {
          x: toCenter.x >= fromCenter.x ? to.x : to.x + to.width,
          y: toCenter.y,
        }
      : {
          x: toCenter.x,
          y: toCenter.y >= fromCenter.y ? to.y : to.y + to.height,
        };
    const bend = horizontal
      ? `C ${(start.x + end.x) / 2} ${start.y}, ${(start.x + end.x) / 2} ${end.y}, ${end.x} ${end.y}`
      : `C ${start.x} ${(start.y + end.y) / 2}, ${end.x} ${(start.y + end.y) / 2}, ${end.x} ${end.y}`;
    return [{
      id: `relation-${index}-${relationship.fromTable}-${relationship.toTable}`,
      relationship,
      path: `M ${start.x} ${start.y} ${bend}`,
      labelX: (start.x + end.x) / 2,
      labelY: (start.y + end.y) / 2,
    }];
  });
  const rowCount = Math.max(1, Math.ceil(nodes.length / columnCount));
  return {
    width: Math.max(620, padding * 2 + columnCount * nodeWidth + (columnCount - 1) * horizontalGap),
    height: Math.max(320, padding * 2 + rowCount * nodeHeight + (rowCount - 1) * verticalGap),
    nodes,
    edges,
  };
}

export function AtlasWorkbench() {
  const [projectPath, setProjectPath] = useState("");
  const [question, setQuestion] = useState("");
  const [checkDependencies, setCheckDependencies] = useState(false);
  const [enableAi, setEnableAi] = useState(false);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("working-tree");
  const [baseRevision, setBaseRevision] = useState("");
  const [scanScope, setScanScope] = useState<"production" | "all">("production");
  const [analysis, setAnalysis] = useState<AtlasAnalysis | null>(null);
  const [analysisPayload, setAnalysisPayload] = useState<unknown>(null);
  const [activeView, setActiveView] = useState<View>("overview");
  const [status, setStatus] = useState<RequestStatus>("idle");
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [health, setHealth] = useState<AtlasHealth | null>(null);
  const [error, setError] = useState<AtlasUiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRunInput, setLastRunInput] = useState<AnalysisInput | null>(null);
  const [securityQuery, setSecurityQuery] = useState("");
  const [securitySeverity, setSecuritySeverity] =
    useState<SecuritySeverityFilter>("all");
  const [securityScope, setSecurityScope] = useState<AtlasSecurityScope | "all">("all");
  const [securitySourceKind, setSecuritySourceKind] =
    useState<AtlasSecuritySourceKind | "all">("all");
  const [securityRelevance, setSecurityRelevance] =
    useState<RelevanceFilter>("all");
  const [erdQuery, setErdQuery] = useState("");
  const [relationshipFilter, setRelationshipFilter] =
    useState<RelationshipFilter>("all");
  const [erdRelevance, setErdRelevance] = useState<RelevanceFilter>("all");
  const abortController = useRef<AbortController | null>(null);

  const probeApiStatus = useCallback(async (signal?: AbortSignal) => {
    setApiStatus("checking");
    try {
      const response = await fetch(HEALTH_URL, { signal });
      if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}.`);
      const payload: unknown = await response.json();
      if (!signal?.aborted) {
        setHealth(normalizeAtlasHealth(payload));
        setApiStatus("online");
      }
      return true;
    } catch {
      if (!signal?.aborted) {
        setHealth(null);
        setApiStatus("offline");
      }
      return false;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(HEALTH_URL, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Health check returned HTTP ${response.status}.`);
        }
        return normalizeAtlasHealth(await response.json());
      })
      .then((payload) => {
        if (!controller.signal.aborted) {
          setHealth(payload);
          setApiStatus("online");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHealth(null);
          setApiStatus("offline");
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const requestedProject = new URLSearchParams(window.location.search).get("project")?.trim();
    if (!requestedProject) return;
    const frame = requestAnimationFrame(() =>
      setProjectPath((current) => current || requestedProject),
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const sortedImpactFindings = useMemo(
    () =>
      [...(analysis?.impact.findings ?? [])].sort((a, b) => b.score - a.score),
    [analysis],
  );

  const maximumImpactScore = sortedImpactFindings[0]?.score ?? 0;

  const sortedSecurityFindings = useMemo(() => {
    const rank: Record<AtlasSeverity, number> = {
      critical: 5,
      high: 4,
      medium: 3,
      low: 2,
      info: 1,
    };
    const query = securityQuery.trim().toLocaleLowerCase();
    return [...(analysis?.security.findings ?? [])]
      .filter((finding) => securitySeverity === "all" || finding.severity === securitySeverity)
      .filter((finding) => securityScope === "all" || finding.scope === securityScope)
      .filter((finding) => securitySourceKind === "all" || finding.sourceKind === securitySourceKind)
      .filter((finding) => securityRelevance === "all" || finding.relevance === securityRelevance)
      .filter((finding) =>
        !query ||
        [finding.title, finding.category, finding.file, finding.evidence]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query),
      )
      .sort(
        (a, b) => rank[b.severity] - rank[a.severity] || b.confidence - a.confidence,
      );
  }, [analysis, securityQuery, securityRelevance, securityScope, securitySeverity, securitySourceKind]);

  const availableSecurityScopes = useMemo(
    () =>
      [...new Set((analysis?.security.findings ?? []).map((finding) => finding.scope))]
        .sort((left, right) => left.localeCompare(right)),
    [analysis],
  );

  const filteredRelationships = useMemo(
    () =>
      (analysis?.erd.relationships ?? []).filter(
        (relationship) =>
          (relationshipFilter === "all" || relationship.origin === relationshipFilter) &&
          (erdRelevance === "all" || relationship.relevance === erdRelevance),
      ),
    [analysis, erdRelevance, relationshipFilter],
  );

  const filteredTables = useMemo(() => {
    const tables = analysis?.erd.tables ?? [];
    const query = erdQuery.trim().toLocaleLowerCase();
    const matchingRelationshipTables = new Set(
      filteredRelationships
        .filter((relationship) =>
          [
            relationship.fromTable,
            relationship.fromColumn,
            relationship.toTable,
            relationship.toColumn,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
        )
        .flatMap((relationship) => [relationship.fromTable, relationship.toTable])
        .map((name) => name.toLocaleLowerCase()),
    );
    const relevantTables = tables.filter(
      (table) =>
        erdRelevance === "all" ||
        table.relevance === erdRelevance ||
        matchingRelationshipTables.has(table.name.toLocaleLowerCase()),
    );
    if (!query) return relevantTables;
    return relevantTables.filter(
      (table) =>
        table.name.toLocaleLowerCase().includes(query) ||
          table.columns.some((column) => column.name.toLocaleLowerCase().includes(query)) ||
          matchingRelationshipTables.has(table.name.toLocaleLowerCase()),
    );
  }, [analysis, erdQuery, erdRelevance, filteredRelationships]);

  const visibleRelationships = useMemo(() => {
    const visibleTableNames = new Set(
      filteredTables.map((table) => table.name.toLocaleLowerCase()),
    );
    return filteredRelationships.filter(
      (relationship) =>
        visibleTableNames.has(relationship.fromTable.toLocaleLowerCase()) &&
        visibleTableNames.has(relationship.toTable.toLocaleLowerCase()),
    );
  }, [filteredRelationships, filteredTables]);

  const erdGraph = useMemo(
    () => buildErdGraphLayout(filteredTables, visibleRelationships),
    [filteredTables, visibleRelationships],
  );

  const currentQuestion =
    question.trim() || "What is the impact surface of the current changes?";
  const comparisonChanged = Boolean(
    lastRunInput &&
      !lastRunInput.sample &&
      (lastRunInput.comparison.mode !== comparisonMode ||
        (comparisonMode === "base" &&
          lastRunInput.comparison.base !== baseRevision.trim())),
  );
  const inputChanged = Boolean(
    lastRunInput &&
      (lastRunInput.question !== currentQuestion ||
        lastRunInput.checkDependencies !== checkDependencies ||
        lastRunInput.enableAi !== enableAi ||
        lastRunInput.scope !== scanScope ||
        (lastRunInput.projectPath ?? "") !== projectPath.trim() ||
        comparisonChanged),
  );
  const analysisIsStale = Boolean(analysis && (analysis.stale || inputChanged));
  const externalTransferRecorded = Boolean(
    analysis &&
      (analysis.external.osv.transmitted.length > 0 ||
        analysis.external.ai.transmitted.length > 0),
  );
  const osvDisclosureFields =
    health?.external.osv.wouldTransmit ?? [...OSV_REQUEST_FIELDS];
  const aiDisclosureFields =
    health?.external.ai.wouldTransmit ?? [...AI_SYNTHESIS_REQUEST_FIELDS];
  const aiEndpointDisclosure =
    apiStatus === "checking"
      ? "Checking endpoint configuration"
      : health?.external.ai.configured
        ? `Endpoint ${health.external.ai.endpointOrigin ?? "configured by the local engine"}`
        : apiStatus === "offline"
          ? "Endpoint unavailable while the analyzer is offline"
          : "No model endpoint configured";
  const engineTrustWarnings = health
    ? [
        ...(!health.localOnly
          ? ["The analyzer is not bound to a loopback-only host."]
          : []),
        ...(!health.allowedRootsConfigured
          ? ["No ATLAS_ALLOWED_ROOTS boundary is configured."]
          : []),
      ]
    : [];

  async function requestAnalysis(input: AnalysisInput) {
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    setStatus("loading");
    setError(null);
    setNotice(null);
    let reachedApi = false;

    try {
      const healthy = await probeApiStatus(controller.signal);
      if (controller.signal.aborted) return;
      if (!healthy) {
        throw new AtlasRequestFailure({
          code: "ANALYZER_IDENTITY_UNVERIFIED",
          message:
            "Atlas did not send the project path because the configured endpoint did not present a valid Local Code Atlas health contract.",
        });
      }
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      reachedApi = true;

      const payload = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        throw new AtlasRequestFailure(normalizeAtlasApiError(payload, response.status));
      }

      setAnalysis(normalizeAtlasAnalysis(payload, input));
      setAnalysisPayload(payload);
      setLastRunInput(input);
      setApiStatus("online");
      setStatus("ready");
      setActiveView("overview");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;

      setApiStatus(reachedApi ? "online" : "offline");
      setStatus("error");
      setError(
        caught instanceof AtlasRequestFailure
          ? caught.detail
          : {
              code: reachedApi ? "ANALYSIS_FAILED" : "ANALYZER_OFFLINE",
              message: reachedApi
                ? caught instanceof Error
                  ? caught.message
                  : "Atlas could not complete this analysis."
                : "The local analyzer is not responding. Start it, then retry. The bundled sample also requires the analyzer.",
            },
      );
    } finally {
      if (abortController.current === controller) abortController.current = null;
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectPath.trim()) {
      setError({
        code: "PATH_REQUIRED",
        message: "Enter an absolute path to a local project before starting analysis.",
      });
      setStatus("error");
      return;
    }
    if (comparisonMode === "base" && !baseRevision.trim()) {
      setError({
        code: "BASE_REQUIRED",
        message: "Enter a branch, tag, or commit to use as the base revision.",
      });
      setStatus("error");
      return;
    }

    void requestAnalysis({
      projectPath: projectPath.trim(),
      question: question.trim() || "What is the impact surface of the current changes?",
      checkDependencies,
      enableAi,
      comparison: {
        mode: comparisonMode,
        base: comparisonMode === "base" ? baseRevision.trim() : undefined,
      },
      scope: scanScope,
    });
  }

  function handleSample() {
    setQuestion(SAMPLE_QUESTION);
    void requestAnalysis({
      sample: true,
      projectPath: projectPath.trim() || undefined,
      question: SAMPLE_QUESTION,
      checkDependencies,
      enableAi,
      comparison: { mode: "working-tree" },
      scope: scanScope,
    });
  }

  function cancelAnalysis() {
    abortController.current?.abort();
    abortController.current = null;
    setStatus(analysis ? "ready" : "idle");
    setNotice("Analysis cancelled. No project files were changed.");
  }

  async function retryConnection() {
    const online = await probeApiStatus();
    if (!online) return;
    setError(null);
    setStatus(analysis ? "ready" : "idle");
    setNotice("The local analyzer is connected. You can run an analysis now.");
  }

  async function copySourceLocation(file: string, line?: number) {
    const location = sourceLabel(file, line);
    try {
      await navigator.clipboard.writeText(location);
      setNotice(`Copied ${location}`);
    } catch {
      setNotice(`Source location: ${location}`);
    }
  }

  function downloadAnalysis() {
    if (!analysis) return;
    const fileStem = analysis.project.name
      .toLocaleLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "local-code-atlas";
    const blob = new Blob(
      [JSON.stringify(analysisPayload ?? analysis, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${fileStem}-analysis.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice("Analysis JSON downloaded. It may contain local project paths; review it before sharing.");
  }

  function handleViewKeyDown(event: KeyboardEvent<HTMLButtonElement>, view: View) {
    const currentIndex = VIEWS.findIndex((candidate) => candidate.id === view);
    let nextIndex: number | undefined;

    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % VIEWS.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + VIEWS.length) % VIEWS.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = VIEWS.length - 1;
    if (nextIndex === undefined) return;

    event.preventDefault();
    const nextView = VIEWS[nextIndex].id;
    setActiveView(nextView);
    requestAnimationFrame(() => document.getElementById(`atlas-tab-${nextView}`)?.focus());
  }

  return (
    <main
      className="atlas-app"
      data-atlas-workbench-version={APP_VERSION}
      data-atlas-api-url={API_URL}
    >
      <header className="atlas-header">
        <a className="atlas-brand" href="#atlas-workbench" aria-label="Code Atlas home">
          <span className="atlas-brand-mark" aria-hidden="true">
            CA
          </span>
          <span>
            <strong>LOCAL CODE ATLAS</strong>
            <small>EVIDENCE WORKBENCH</small>
          </span>
        </a>
        <div className="atlas-header-meta">
          <span
            className={`atlas-privacy-chip${health && !health.localOnly ? " atlas-privacy-chip--warning" : ""}`}
          >
            {health && !health.localOnly ? "Engine network-exposed" : "External checks opt-in"}
          </span>
          {health && !health.allowedRootsConfigured && (
            <span className="atlas-privacy-chip atlas-privacy-chip--warning">
              Roots unrestricted
            </span>
          )}
          <button
            type="button"
            className={`atlas-api-status atlas-api-status--${apiStatus}`}
            title={
              apiStatus === "offline"
                ? `Could not reach ${HEALTH_URL}. Activate to retry.`
                : "Check the local analyzer connection"
            }
            onClick={() => void probeApiStatus()}
            disabled={apiStatus === "checking"}
          >
            <span className="atlas-status-dot" aria-hidden="true" />
            {apiStatus === "online"
              ? "Analyzer connected"
              : apiStatus === "offline"
                ? "Analyzer offline"
                : "Checking analyzer"}
          </button>
        </div>
      </header>

      <div className="atlas-workbench" id="atlas-workbench">
        <section className="atlas-intro" aria-labelledby="atlas-title">
          <div className="atlas-eyebrow">
            <span>LOCAL-FIRST</span>
            <span>CODE · RISK · DATA</span>
          </div>
          <h1 id="atlas-title">
            Map the blast radius
            <span> before code moves.</span>
          </h1>
          <p className="atlas-lede">
            Ask one question across source, Git changes, security findings, and your
            database model. Every answer stays attached to inspectable evidence.
          </p>

          <form className="atlas-query-card" onSubmit={handleSubmit} aria-busy={status === "loading"}>
            <div className="atlas-form-heading">
              <div>
                <span className="atlas-step-label">ANALYSIS INPUT</span>
                <h2>Point Atlas at a project</h2>
              </div>
              <span className="atlas-read-only-badge">READ ONLY</span>
            </div>

            {engineTrustWarnings.length > 0 && (
              <div className="atlas-engine-warning" role="status">
                <strong>Review local engine exposure</strong>
                <span>
                  {engineTrustWarnings.join(" ")} Restrict the host and allowed roots before
                  using this engine on a shared machine or network.
                </span>
              </div>
            )}

            <label className="atlas-field" htmlFor="project-path">
              <span>Project path</span>
              <span className="atlas-input-shell">
                <span className="atlas-input-prompt" aria-hidden="true">
                  ~
                </span>
                <input
                  id="project-path"
                  name="projectPath"
                  type="text"
                  value={projectPath}
                  onChange={(event) => setProjectPath(event.target.value)}
                  placeholder="/absolute/path/to/project"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={status === "loading"}
                />
              </span>
            </label>

            <label className="atlas-field" htmlFor="project-question">
              <span>What do you need to understand?</span>
              <textarea
                id="project-question"
                name="question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="If I change session expiry, what code, tests, risks, and tables are affected?"
                rows={3}
                disabled={status === "loading"}
              />
            </label>

            <div className="atlas-scan-controls">
              <label>
                <span>Git comparison</span>
                <select
                  value={comparisonMode}
                  onChange={(event) => setComparisonMode(event.target.value as ComparisonMode)}
                  disabled={status === "loading"}
                >
                  <option value="working-tree">Working tree</option>
                  <option value="staged">Staged changes</option>
                  <option value="base">Base revision…</option>
                </select>
              </label>
              {comparisonMode === "base" && (
                <label>
                  <span>Base branch, tag, or commit</span>
                  <input
                    type="text"
                    value={baseRevision}
                    onChange={(event) => setBaseRevision(event.target.value)}
                    placeholder="main, origin/main, or a commit"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={status === "loading"}
                  />
                </label>
              )}
              <label>
                <span>Scan scope</span>
                <select
                  value={scanScope}
                  onChange={(event) => setScanScope(event.target.value as "production" | "all")}
                  disabled={status === "loading"}
                >
                  <option value="production">Production analysis + related tests</option>
                  <option value="all">All files, including examples and tests</option>
                </select>
              </label>
            </div>

            <div className="atlas-analysis-options">
              <label className="atlas-dependency-check">
                <input
                  type="checkbox"
                  checked={checkDependencies}
                  onChange={(event) => setCheckDependencies(event.target.checked)}
                  disabled={status === "loading"}
                />
                <span>
                  <strong>Check known dependency advisories with OSV</strong>
                  <small>Review the exact request fields below before opting in.</small>
                </span>
              </label>
              <label className="atlas-dependency-check">
                <input
                  type="checkbox"
                  checked={enableAi}
                  onChange={(event) => setEnableAi(event.target.checked)}
                  disabled={status === "loading"}
                />
                <span>
                  <strong>Use configured AI synthesis</strong>
                  <small>{aiEndpointDisclosure}. Review every evidence category below.</small>
                </span>
              </label>
            </div>

            <div className="atlas-external-disclosure" role="note" aria-label="External data disclosure">
              <div>
                <strong>Local analysis is the default</strong>
                <span>Network access happens only for the options you select.</span>
              </div>
              <ul>
                <li data-enabled={checkDependencies}>
                  <b>OSV {checkDependencies ? "selected" : "off"}</b>
                  <span>Would include: {osvDisclosureFields.join(", ")}</span>
                </li>
                <li data-enabled={enableAi}>
                  <b>AI {enableAi ? "selected" : "off"}</b>
                  <span>{aiEndpointDisclosure}. Would include: {aiDisclosureFields.join(", ")}</span>
                </li>
              </ul>
            </div>

            <div className="atlas-form-actions">
              {status === "loading" ? (
                <button className="atlas-button atlas-button--secondary" type="button" onClick={cancelAnalysis}>
                  Cancel scan
                </button>
              ) : (
                <button className="atlas-button atlas-button--primary" type="submit">
                  Analyze project <span aria-hidden="true">↗</span>
                </button>
              )}
              <button
                className="atlas-button atlas-button--ghost"
                type="button"
                onClick={handleSample}
                disabled={status === "loading"}
              >
                Run bundled sample
              </button>
              <p>
                Ignores dependencies, build output, and files excluded by your repository rules.
              </p>
            </div>
          </form>
        </section>

        <aside className="atlas-manifest" aria-label="Analysis capabilities">
          <div className="atlas-manifest-topline">
            <span>ANALYSIS MANIFEST</span>
            <span>v{APP_VERSION}</span>
          </div>
          <ol className="atlas-capability-list">
            <li>
              <span className="atlas-capability-index">01</span>
              <div>
                <strong>Change impact</strong>
                <p>Trace relevant files, symbols, tests, and Git changes.</p>
              </div>
              <span className="atlas-capability-state">READY</span>
            </li>
            <li>
              <span className="atlas-capability-index">02</span>
              <div>
                <strong>Security context</strong>
                <p>Rank deterministic findings with reachable code evidence.</p>
              </div>
              <span className="atlas-capability-state">READY</span>
            </li>
            <li>
              <span className="atlas-capability-index">03</span>
              <div>
                <strong>Data map</strong>
                <p>Derive tables and relationships from project schema sources.</p>
              </div>
              <span className="atlas-capability-state">READY</span>
            </li>
          </ol>
          <div className="atlas-manifest-foot">
            <p>Evidence over guesswork.</p>
            <div className="atlas-manifest-flow" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
        </aside>
      </div>

      <section className="atlas-status-region" aria-live="polite" aria-atomic="true">
        {status === "loading" && (
          <div className="atlas-loading-state">
            <div className="atlas-loader" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
            <div>
              <strong>Building the project map</strong>
              <p>Detecting structure, ranking impact, checking risk, and resolving schema relationships.</p>
            </div>
          </div>
        )}
        {error && status === "error" && (
          <div className="atlas-error-state" role="alert">
            <span className="atlas-error-code">{error.code}</span>
            <div>
              <strong>Atlas could not complete this scan.</strong>
              <p>{error.message}</p>
              {error.requestId && (
                <p className="atlas-request-id">
                  Request ID <code>{error.requestId}</code>
                </p>
              )}
              {apiStatus === "offline" && (
                <p>
                  Start the local analyzer, then retry the connection. The bundled sample also runs through this local process.
                </p>
              )}
            </div>
            {apiStatus === "offline" ? (
              <button className="atlas-text-button" type="button" onClick={() => void retryConnection()}>
                Retry connection <span aria-hidden="true">→</span>
              </button>
            ) : (
              <button className="atlas-text-button" type="button" onClick={handleSample}>
                Run bundled sample <span aria-hidden="true">→</span>
              </button>
            )}
          </div>
        )}
        {notice && <div className="atlas-notice">{notice}</div>}
      </section>

      {analysis ? (
        <section className="atlas-results" aria-label={`Analysis for ${analysis.project.name}`}>
          <div className="atlas-results-header">
            <div className="atlas-results-project">
              <span className="atlas-project-monogram" aria-hidden="true">
                {analysis.project.name.slice(0, 2).toUpperCase()}
              </span>
              <div>
                <div className="atlas-result-kicker">
                  <span>{analysisIsStale ? "RESULTS OUT OF DATE" : "LOCAL ANALYSIS COMPLETE"}</span>
                  <span>{formatDate(analysis.generatedAt)}</span>
                </div>
                <h2>{analysis.project.name}</h2>
                <p title={analysis.project.path}>{analysis.project.path}</p>
              </div>
            </div>
            <div className="atlas-results-meta">
              {analysisIsStale && <span className="atlas-stale-chip">STALE · RUN AGAIN</span>}
              {analysis.project.git?.branch && (
                <span>
                  <b>BRANCH</b> {analysis.project.git.branch}
                </span>
              )}
              {analysis.project.git?.comparison && (
                <span>
                  <b>COMPARE</b> {analysis.project.git.comparison.label}
                </span>
              )}
              {analysis.durationMs !== undefined && (
                <span>
                  <b>TIME</b> {(analysis.durationMs / 1_000).toFixed(2)}s
                </span>
              )}
              <button type="button" className="atlas-download-report" onClick={downloadAnalysis}>
                Download JSON ↓
              </button>
              <span>
                <b>SCAN</b> {analysis.id}
              </span>
            </div>
          </div>

          {(analysisIsStale || analysis.run.partial || analysis.run.stages.length > 0) && (
            <div className={`atlas-run-status${analysis.run.partial ? " atlas-run-status--partial" : ""}`}>
              <div>
                <strong>
                  {analysisIsStale
                    ? "Inputs changed after this report was generated."
                    : analysis.run.partial
                      ? "This report is partial."
                      : "Local analysis completed; review optional checks below."}
                </strong>
                <p>
                  {analysisIsStale
                    ? "Run the analysis again before using these results for a decision."
                    : analysis.run.partial
                      ? "Review skipped and incomplete stages before treating an absent finding as a clean result."
                      : `Scope: ${analysis.run.scope === "unknown" ? "not reported" : analysis.run.scope}.`}
                </p>
              </div>
              {analysis.run.stages.length > 0 && (
                <ul aria-label="Analysis stage status">
                  {analysis.run.stages.map((stage) => (
                    <li key={stage.id} data-status={stage.status} title={stage.detail}>
                      <span>{stage.id.replaceAll("-", " ")}</span>
                      <b>{stage.status}</b>
                      {(stage.analyzed !== undefined || stage.skipped !== undefined) && (
                        <small>
                          {stage.analyzed !== undefined ? `${stage.analyzed} analyzed` : ""}
                          {stage.analyzed !== undefined && stage.skipped !== undefined ? " · " : ""}
                          {stage.skipped !== undefined ? `${stage.skipped} skipped` : ""}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <nav className="atlas-view-tabs" aria-label="Analysis views" role="tablist">
            {VIEWS.map((view) => {
              const count =
                view.id === "impact"
                  ? analysis.impact.findings.length
                  : view.id === "security"
                    ? analysis.security.findings.length
                    : view.id === "data"
                      ? analysis.erd.tables.length
                      : undefined;
              return (
                <button
                  key={view.id}
                  id={`atlas-tab-${view.id}`}
                  type="button"
                  role="tab"
                  aria-selected={activeView === view.id}
                  aria-controls={`atlas-panel-${view.id}`}
                  tabIndex={activeView === view.id ? 0 : -1}
                  onClick={() => setActiveView(view.id)}
                  onKeyDown={(event) => handleViewKeyDown(event, view.id)}
                >
                  <span>{view.short}</span>
                  {view.label}
                  {count !== undefined && <b>{count}</b>}
                </button>
              );
            })}
          </nav>

          {activeView === "overview" && (
            <div
              className="atlas-view-panel atlas-overview"
              id="atlas-panel-overview"
              role="tabpanel"
              aria-labelledby="atlas-tab-overview"
            >
              <div className="atlas-summary-card">
                <span className="atlas-section-label">SYNTHESIS</span>
                <h3>{analysis.ai.summary || "The project map is ready for inspection."}</h3>
                <p className="atlas-question">“{analysis.impact.question}”</p>
                {!analysis.ai.enabled && (
                  <div className="atlas-mode-note">
                    AI synthesis is disabled. Deterministic project, security, and schema analysis is still available.
                  </div>
                )}
              </div>

              <div className="atlas-stat-grid" aria-label="Project statistics">
                <article>
                  <span>FILES INDEXED</span>
                  <strong>{formatNumber(analysis.project.files)}</strong>
                  <small>{analysis.project.rootKind || "Local project"}</small>
                </article>
                <article>
                  <span>LINES MAPPED</span>
                  <strong>{formatNumber(analysis.project.lines)}</strong>
                  <small>
                    {analysis.run.scope === "all"
                      ? "All selected source roles included"
                      : "Generated, vendor, and docs excluded"}
                  </small>
                </article>
                <article>
                  <span>IMPACT LEADS</span>
                  <strong>{analysis.impact.findings.length}</strong>
                  <small>{analysis.impact.suggestedTests.length} tests suggested</small>
                </article>
                <article>
                  <span>DATA ENTITIES</span>
                  <strong>{analysis.erd.tables.length}</strong>
                  <small>{analysis.erd.relationships.length} relationships</small>
                </article>
              </div>

              <details className="atlas-network-receipt">
                <summary>
                  <span>External access receipt</span>
                  <b>
                    {externalTransferRecorded ? "NETWORK REQUEST RECORDED" : "LOCAL ONLY"}
                  </b>
                </summary>
                <div>
                  <section>
                    <strong>Local analysis</strong>
                    <span>{analysis.external.localByDefault ? "default" : "server policy"}</span>
                    <p>Structure, impact, source findings, and schema analysis run through the local engine.</p>
                  </section>
                  <section>
                    <strong>OSV advisory lookup</strong>
                    <span>{analysis.external.osv.status.replaceAll("-", " ")}</span>
                    <p>
                      {analysis.external.osv.requested
                        ? `${analysis.external.osv.queriedPackages ?? 0} of ${analysis.external.osv.eligiblePackages ?? "unknown"} eligible packages queried.`
                        : "Not requested for this run."}
                    </p>
                    <small>
                      {analysis.external.osv.transmitted.length > 0
                        ? `Included in request: ${analysis.external.osv.transmitted.join(", ")}`
                        : "No dependency data was sent."}
                    </small>
                  </section>
                  <section>
                    <strong>AI synthesis</strong>
                    <span>{analysis.external.ai.status.replaceAll("-", " ")}</span>
                    <p>
                      {analysis.external.ai.requested
                        ? analysis.external.ai.configured
                          ? `Endpoint: ${analysis.external.ai.endpointOrigin ?? "configured endpoint"}`
                          : "Requested, but no model endpoint was configured."
                        : "Not requested for this run."}
                    </p>
                    <small>
                      {analysis.external.ai.transmitted.length > 0
                        ? `Included in request: ${analysis.external.ai.transmitted.join(", ")}`
                        : "No project evidence was sent."}
                    </small>
                  </section>
                </div>
              </details>

              <div className="atlas-overview-grid">
                <article className="atlas-detail-card">
                  <div className="atlas-card-heading">
                    <div>
                      <span className="atlas-section-label">PROJECT FINGERPRINT</span>
                      <h3>Detected stack</h3>
                    </div>
                    <span className="atlas-card-code">ENV</span>
                  </div>
                  {analysis.project.languages.length || analysis.project.frameworks.length ? (
                    <div className="atlas-stack-list">
                      {analysis.project.languages.map((language) => (
                        <div key={language.name}>
                          <span>{language.name}</span>
                          <b>{language.files ? `${language.files} files` : "detected"}</b>
                        </div>
                      ))}
                      {analysis.project.frameworks.map((framework) => (
                        <div key={framework}>
                          <span>{framework}</span>
                          <b>framework</b>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <EmptyState title="No stack metadata" body="The analyzer did not report languages or frameworks for this scan." />
                  )}
                </article>

                <article className="atlas-detail-card">
                  <div className="atlas-card-heading">
                    <div>
                      <span className="atlas-section-label">NEXT DECISIONS</span>
                      <h3>Recommended path</h3>
                    </div>
                    <span className="atlas-card-code">PLAN</span>
                  </div>
                  {analysis.ai.recommendations?.length ? (
                    <ol className="atlas-recommendation-list">
                      {analysis.ai.recommendations.map((recommendation, index) => (
                        <li key={`${recommendation}-${index}`}>
                          <span>{String(index + 1).padStart(2, "0")}</span>
                          <p>{recommendation}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <EmptyState title="No recommendations" body="Open Impact and Security to inspect the analyzer's direct evidence." />
                  )}
                </article>
              </div>

              {(analysis.project.git?.changes.length || analysis.diagnostics?.length) && (
                <details className="atlas-diagnostics">
                  <summary>Scan provenance and diagnostics</summary>
                  <div>
                    {analysis.project.git?.changes.length ? (
                      <section>
                        <h4>Changed files · {analysis.project.git.comparison?.label ?? "current comparison"}</h4>
                        <ul className="atlas-change-list">
                          {analysis.project.git.changes.map((change) => (
                            <li key={change.path}>
                              <code>{change.path}</code>
                              <span>{change.status}</span>
                              {(change.staged || change.unstaged) && (
                                <b>
                                  {change.staged && change.unstaged
                                    ? "staged + unstaged"
                                    : change.staged
                                      ? "staged"
                                      : "unstaged"}
                                </b>
                              )}
                              {(change.additions !== undefined || change.deletions !== undefined) && (
                                <small>
                                  +{change.additions ?? 0} / -{change.deletions ?? 0}
                                </small>
                              )}
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    {analysis.diagnostics?.length ? (
                      <section>
                        <h4>Diagnostics</h4>
                        <ul>
                          {analysis.diagnostics.map((diagnostic) => (
                            <li key={diagnostic}>{diagnostic}</li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </div>
                </details>
              )}
            </div>
          )}

          {activeView === "impact" && (
            <div
              className="atlas-view-panel"
              id="atlas-panel-impact"
              role="tabpanel"
              aria-labelledby="atlas-tab-impact"
            >
              <div className="atlas-view-heading">
                <div>
                  <span className="atlas-section-label">CHANGE SURFACE</span>
                  <h3>Most relevant code paths</h3>
                  <p>Ranked by structural relevance, reachable dependencies, and current change context.</p>
                </div>
                <div className="atlas-view-total">
                  <strong>{analysis.impact.findings.length}</strong>
                  <span>evidence-backed leads</span>
                </div>
              </div>

              <div className="atlas-impact-layout">
                <div className="atlas-impact-list">
                  {sortedImpactFindings.length ? (
                    sortedImpactFindings.map((finding, index) => {
                      const relevanceScore = Math.round(finding.score * 100);
                      const relevanceLabel = finding.changed
                        ? "Changed file"
                        : finding.relevance === "direct"
                          ? "Directly related"
                          : finding.relevance === "indirect"
                            ? "Indirectly related"
                            : finding.relevance === "project"
                              ? "Project context"
                              : relativeRelevanceLabel(finding.score, maximumImpactScore);
                      return (
                        <article
                          className="atlas-impact-item"
                          data-relevance={finding.relevance}
                          key={`${finding.file}-${finding.line || index}`}
                        >
                          <div className="atlas-impact-rank">{String(index + 1).padStart(2, "0")}</div>
                          <div className="atlas-impact-content">
                            <div className="atlas-source-row">
                              <code>{sourceLabel(finding.file, finding.line)}</code>
                              <span>
                                {relevanceLabel}
                                {finding.graphDistance !== undefined
                                  ? ` · ${finding.graphDistance} hop${finding.graphDistance === 1 ? "" : "s"}`
                                  : ""}
                              </span>
                            </div>
                            <h4>{finding.reason}</h4>
                            {finding.evidence && <p>{finding.evidence}</p>}
                            <div
                              className="atlas-confidence-track"
                              style={{ "--atlas-confidence": `${relevanceScore}%` } as CSSProperties}
                              role="img"
                              aria-label={`${relevanceScore} out of 100 relative relevance score`}
                            >
                              <span />
                            </div>
                          </div>
                          <strong className="atlas-confidence-value" title="Relative relevance score">
                            {relevanceScore}
                            <small>/100</small>
                          </strong>
                        </article>
                      );
                    })
                  ) : (
                    <EmptyState title="No impact findings" body="The analyzer did not connect this question to a specific source location." />
                  )}
                </div>

                <aside className="atlas-test-plan">
                  <div className="atlas-card-heading">
                    <div>
                      <span className="atlas-section-label">TEST CONTRACT</span>
                      <h3>Coverage to prove</h3>
                    </div>
                    <span className="atlas-card-code">QA</span>
                  </div>
                  {analysis.impact.suggestedTests.length ? (
                    <ol>
                      {analysis.impact.suggestedTests.map((test, index) => (
                        <li key={`${test}-${index}`}>
                          <span>{index + 1}</span>
                          <p>{test}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <EmptyState title="No tests suggested" body="Review the ranked code paths before defining verification coverage." />
                  )}
                </aside>
              </div>
            </div>
          )}

          {activeView === "security" && (
            <div
              className="atlas-view-panel"
              id="atlas-panel-security"
              role="tabpanel"
              aria-labelledby="atlas-tab-security"
            >
              <div className="atlas-view-heading">
                <div>
                  <span className="atlas-section-label">SECURITY CONTEXT</span>
                  <h3>Prioritized findings, with evidence</h3>
                  <p>Severity communicates impact; confidence communicates how strongly the project supports the finding.</p>
                </div>
                {analysis.security.dependencies && (
                  <div className="atlas-view-total" title="Dependency versions eligible for OSV advisory lookup">
                    <strong>{analysis.security.dependencies.eligibleForAdvisoryLookup ?? 0}</strong>
                    <span>OSV-eligible of {analysis.security.dependencies.total} dependencies</span>
                  </div>
                )}
              </div>

              <div className="atlas-severity-summary" aria-label="Security finding totals">
                {(["critical", "high", "medium", "low", "info"] as const).map((severity) => (
                  <article key={severity} className={`atlas-severity-card atlas-severity-card--${severity}`}>
                    <span>{severity.toUpperCase()}</span>
                    <strong>{analysis.security.summary[severity]}</strong>
                  </article>
                ))}
              </div>

              <div className="atlas-filter-bar atlas-security-filters" aria-label="Security finding filters">
                <label className="atlas-filter-search">
                  <span>Search findings</span>
                  <input
                    type="search"
                    value={securityQuery}
                    onChange={(event) => setSecurityQuery(event.target.value)}
                    placeholder="Rule, file, category…"
                  />
                </label>
                <label>
                  <span>Severity</span>
                  <select
                    value={securitySeverity}
                    onChange={(event) => setSecuritySeverity(event.target.value as SecuritySeverityFilter)}
                  >
                    <option value="all">All severities</option>
                    {(["critical", "high", "medium", "low", "info"] as const).map((severity) => (
                      <option value={severity} key={severity}>{severity}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Scope</span>
                  <select
                    value={securityScope}
                    onChange={(event) => setSecurityScope(event.target.value as AtlasSecurityScope | "all")}
                  >
                    <option value="all">All scopes</option>
                    {availableSecurityScopes.map((scope) => (
                      <option value={scope} key={scope}>{scope}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Source</span>
                  <select
                    value={securitySourceKind}
                    onChange={(event) => setSecuritySourceKind(event.target.value as AtlasSecuritySourceKind | "all")}
                  >
                    <option value="all">Source + dependencies</option>
                    <option value="source">Source analysis</option>
                    <option value="dependency">Dependencies</option>
                  </select>
                </label>
                <label>
                  <span>Review relevance</span>
                  <select
                    value={securityRelevance}
                    onChange={(event) => setSecurityRelevance(event.target.value as RelevanceFilter)}
                  >
                    <option value="all">All project context</option>
                    <option value="direct">Direct</option>
                    <option value="indirect">Indirect</option>
                    <option value="project">Project-wide</option>
                  </select>
                </label>
                <p><strong>{sortedSecurityFindings.length}</strong> of {analysis.security.findings.length} shown</p>
              </div>

              <div className="atlas-security-list">
                {sortedSecurityFindings.length ? (
                  sortedSecurityFindings.map((finding) => (
                    <details className="atlas-security-item" key={finding.id} open={finding.severity === "critical"}>
                      <summary>
                        <span className={`atlas-severity-pill atlas-severity-pill--${finding.severity}`}>
                          {finding.severity}
                        </span>
                        <span className="atlas-security-title">
                          <strong>{finding.title}</strong>
                          <small>{finding.category} · {sourceLabel(finding.file, finding.line)}</small>
                          <span className="atlas-finding-tags">
                            <b>{finding.scope}</b>
                            <b>{finding.sourceKind}</b>
                            {finding.relevance !== "unknown" && <b>{finding.relevance} relevance</b>}
                          </span>
                        </span>
                        <span className="atlas-security-confidence">
                          {Math.round(finding.confidence * 100)}%
                          <small>confidence</small>
                        </span>
                        <span className="atlas-disclosure" aria-hidden="true">+</span>
                      </summary>
                      <div className="atlas-security-detail">
                        <section>
                          <span>EVIDENCE</span>
                          <p>{finding.evidence}</p>
                        </section>
                        <section>
                          <span>REMEDIATION</span>
                          <p>{finding.remediation}</p>
                        </section>
                        <footer>
                          <div>
                            <code>{finding.id}</code>
                            {finding.advisoryUrl && (
                              <a href={finding.advisoryUrl} target="_blank" rel="noreferrer">
                                Open advisory ↗
                              </a>
                            )}
                          </div>
                          <button
                            type="button"
                            className="atlas-copy-source"
                            onClick={() => void copySourceLocation(finding.file, finding.line)}
                            aria-label={`Copy source location ${sourceLabel(finding.file, finding.line)}`}
                          >
                            Copy <code>{sourceLabel(finding.file, finding.line)}</code>
                          </button>
                        </footer>
                      </div>
                    </details>
                  ))
                ) : (
                  <EmptyState
                    title={analysis.security.findings.length ? "No matching findings" : "No security findings"}
                    body={
                      analysis.security.findings.length
                        ? "Adjust the search, severity, scope, source, or review relevance filters."
                        : "No findings were returned for the current project scope. This is not a guarantee that the project is vulnerability-free."
                    }
                  />
                )}
              </div>
            </div>
          )}

          {activeView === "data" && (
            <div
              className="atlas-view-panel"
              id="atlas-panel-data"
              role="tabpanel"
              aria-labelledby="atlas-tab-data"
            >
              <div className="atlas-view-heading atlas-view-heading--data">
                <div>
                  <span className="atlas-section-label">SCHEMA TOPOLOGY</span>
                  <h3>Data map / ERD</h3>
                  <p>Relationship origin comes from source provenance; confidence is shown separately and never decides whether a link is declared.</p>
                </div>
                <div className="atlas-erd-legend" aria-label="Data map legend">
                  <span><b>PK</b> primary key</span>
                  <span><b>FK</b> foreign key</span>
                  <span><i className="atlas-line-declared" /> declared</span>
                  <span><i className="atlas-line-inferred" /> inferred</span>
                </div>
              </div>

              {analysis.erd.tables.length ? (
                <div className="atlas-erd-workspace">
                  <div className="atlas-filter-bar atlas-erd-filters" aria-label="Data map filters">
                    <label className="atlas-filter-search">
                      <span>Find a table or column</span>
                      <input
                        type="search"
                        value={erdQuery}
                        onChange={(event) => setErdQuery(event.target.value)}
                        placeholder="users, customer_id…"
                      />
                    </label>
                    <label>
                      <span>Relationship origin</span>
                      <select
                        value={relationshipFilter}
                        onChange={(event) => setRelationshipFilter(event.target.value as RelationshipFilter)}
                      >
                        <option value="all">Declared + inferred</option>
                        <option value="declared">Declared only</option>
                        <option value="inferred">Inferred only</option>
                      </select>
                    </label>
                    <label>
                      <span>Review relevance</span>
                      <select
                        value={erdRelevance}
                        onChange={(event) => setErdRelevance(event.target.value as RelevanceFilter)}
                      >
                        <option value="all">All project context</option>
                        <option value="direct">Direct</option>
                        <option value="indirect">Indirect</option>
                        <option value="project">Project-wide</option>
                      </select>
                    </label>
                    <p aria-live="polite">
                      <strong>{filteredTables.length}</strong> tables · <strong>{visibleRelationships.length}</strong> links
                    </p>
                  </div>

                  {filteredTables.length ? (
                    <>
                      <div
                        className="atlas-erd-canvas-shell"
                        tabIndex={0}
                        role="region"
                        aria-label={`Entity relationship graph with ${filteredTables.length} tables and ${visibleRelationships.length} relationships. Scroll to explore.`}
                      >
                        <div
                          className="atlas-erd-canvas"
                          style={{ width: erdGraph.width, height: erdGraph.height }}
                        >
                          <svg
                            className="atlas-erd-edges"
                            width={erdGraph.width}
                            height={erdGraph.height}
                            viewBox={`0 0 ${erdGraph.width} ${erdGraph.height}`}
                            aria-hidden="true"
                          >
                            {erdGraph.edges.map((edge) => (
                              <g key={edge.id}>
                                <path
                                  d={edge.path}
                                  className={`atlas-erd-edge atlas-erd-edge--${edge.relationship.origin}`}
                                />
                                <circle
                                  cx={edge.labelX}
                                  cy={edge.labelY}
                                  r="9"
                                  className={`atlas-erd-edge-label atlas-erd-edge-label--${edge.relationship.origin}`}
                                />
                                <text x={edge.labelX} y={edge.labelY + 2.5} textAnchor="middle">
                                  {edge.relationship.origin === "declared"
                                    ? "D"
                                    : edge.relationship.origin === "inferred"
                                      ? "I"
                                      : "?"}
                                </text>
                              </g>
                            ))}
                          </svg>

                          {erdGraph.nodes.map((node) => (
                            <article
                              className="atlas-erd-node"
                              data-relevance={node.table.relevance}
                              key={node.id}
                              style={{
                                left: node.x,
                                top: node.y,
                                width: node.width,
                                height: node.height,
                              }}
                            >
                              <header>
                                <div>
                                  <span>TABLE</span>
                                  <h4>{node.table.name}</h4>
                                </div>
                                <span>{node.table.columns.length} COL</span>
                              </header>
                              {node.table.relevance !== "unknown" && (
                                <span className={`atlas-node-relevance atlas-node-relevance--${node.table.relevance}`}>
                                  {node.table.relevance}
                                </span>
                              )}
                              <div className="atlas-erd-columns" role="list" aria-label={`Columns in ${node.table.name}`}>
                                {node.table.columns.map((column) => (
                                  <div role="listitem" key={column.name}>
                                    <span>
                                      {column.primaryKey && <b className="atlas-key atlas-key--primary">PK</b>}
                                      {column.foreignKey && <b className="atlas-key">FK</b>}
                                    </span>
                                    <code>{column.name}</code>
                                    <small>{column.type}</small>
                                  </div>
                                ))}
                              </div>
                              <button
                                type="button"
                                className="atlas-erd-node-source"
                                onClick={() => void copySourceLocation(node.table.sourceFile, node.table.line)}
                                title={`Copy ${sourceLabel(node.table.sourceFile, node.table.line)}`}
                              >
                                {sourceLabel(node.table.sourceFile, node.table.line)}
                              </button>
                            </article>
                          ))}
                        </div>
                      </div>

                      <div className="atlas-relationship-ledger">
                        <div className="atlas-card-heading">
                          <div>
                            <span className="atlas-section-label">ACCESSIBLE RELATIONSHIP LEDGER</span>
                            <h3>Visible connections</h3>
                          </div>
                          <span className="atlas-card-code">{visibleRelationships.length}</span>
                        </div>
                        {visibleRelationships.length ? (
                          <ol>
                            {visibleRelationships.map((relationship, index) => (
                              <li key={`${relationship.fromTable}-${relationship.fromColumn}-${index}`}>
                                <div className="atlas-relation-topline">
                                  <span className={`atlas-relation-type atlas-relation-type--${relationship.origin}`}>
                                    {relationship.origin.toUpperCase()}
                                  </span>
                                  <span>{Math.round(relationship.confidence * 100)}% confidence</span>
                                </div>
                                <div className="atlas-relation-path">
                                  <code>{relationship.fromTable}.{relationship.fromColumn}</code>
                                  <span aria-hidden="true">→</span>
                                  <code>{relationship.toTable}.{relationship.toColumn}</code>
                                </div>
                                <p>
                                  {relationship.kind || "related"}
                                  {relationship.relevance !== "unknown" ? ` · ${relationship.relevance} relevance` : ""}
                                  {relationship.source ? ` · ${relationship.source}` : ""}
                                </p>
                              </li>
                            ))}
                          </ol>
                        ) : (
                          <EmptyState title="No visible relationships" body="The selected tables have no relationships matching the current origin and relevance filters." />
                        )}
                      </div>
                    </>
                  ) : (
                    <EmptyState title="No matching schema objects" body="Adjust the table search, relationship origin, or review relevance filter." />
                  )}
                </div>
              ) : (
                <EmptyState title="No schema detected" body="Atlas did not find a supported ORM schema, migration, or SQL definition in this project." />
              )}
            </div>
          )}
        </section>
      ) : (
        status === "idle" && (
          <section className="atlas-empty-preview" aria-label="Example questions">
            <span className="atlas-section-label">QUESTIONS ATLAS CAN TRACE</span>
            <div>
              <p>“Which tests need to change if session expiry moves to 24 hours?”</p>
              <p>“Can user input reach this dynamic SQL query?”</p>
              <p>“Which services depend on the customer_id relationship?”</p>
            </div>
          </section>
        )
      )}

      <footer className="atlas-footer">
        <span>LOCAL CODE ATLAS</span>
        <p>Local project intelligence. Evidence stays inspectable.</p>
        <a href="#atlas-workbench">New analysis ↑</a>
      </footer>
    </main>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="atlas-inline-empty">
      <span aria-hidden="true">···</span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

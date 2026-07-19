import type { SourceScope } from "../core/types";

export type AnalyzerDomain = "security" | "schema";

export type ConfidenceLevel = "low" | "medium" | "high";

export interface Confidence {
  score: number;
  level: ConfidenceLevel;
  rationale: string;
}

export interface SourcePoint {
  /** One-based line number. */
  line: number;
  /** One-based UTF-16 column number. */
  column: number;
  /** Zero-based UTF-16 offset into the source file. */
  offset: number;
}

export interface SourceRange {
  start: SourcePoint;
  end: SourcePoint;
}

export interface SourceProvenance {
  path: string;
  range: SourceRange;
}

export interface AnalysisFile {
  path: string;
  content: string;
  language?: string;
  /** Optional scanner classification; analyzers infer it from the path if absent. */
  sourceScope?: SourceScope;
}

export interface AnalyzerContext {
  files: readonly AnalysisFile[];
  signal?: AbortSignal;
}

export interface FileAnalyzer<TObservation> {
  readonly id: string;
  readonly domain: AnalyzerDomain;
  supports(file: AnalysisFile, context: AnalyzerContext): boolean;
  analyze(
    file: AnalysisFile,
    context: AnalyzerContext,
  ): readonly TObservation[] | Promise<readonly TObservation[]>;
}

export interface AnalyzerExecution {
  analyzerId: string;
  matchedFiles: string[];
  observationCount: number;
  durationMs: number;
}

export interface RegistryRun<TObservation> {
  observations: TObservation[];
  executions: AnalyzerExecution[];
}

export interface AnalysisDiagnostic {
  analyzerId: string;
  severity: "info" | "warning" | "error";
  message: string;
  path?: string;
}

import type { AnalysisFile } from "./types";
import {
  classifySourceScope,
  sourceScopeIncluded,
} from "../core/source-scope";
import type { SourceScope } from "../core/types";
import {
  analyzeSchema,
  type SchemaAnalysisResult,
  type SchemaAnalyzerOptions,
} from "./schema";
import {
  analyzeSecurity,
  type SecurityAnalysisResult,
  type SecurityAnalyzerOptions,
} from "./security";

export interface ProjectAnalyzerOptions {
  signal?: AbortSignal;
  security?: Omit<SecurityAnalyzerOptions, "signal">;
  schema?: Omit<SchemaAnalyzerOptions, "signal">;
  /** Schema sources follow the same production/all convention as security. */
  schemaSourceScope?: "production" | "all" | readonly SourceScope[];
}

export interface ProjectAnalysisResult {
  security: SecurityAnalysisResult;
  schema: SchemaAnalysisResult;
}

export async function analyzeProject(
  files: readonly AnalysisFile[],
  options: ProjectAnalyzerOptions = {},
): Promise<ProjectAnalysisResult> {
  const schemaScope = options.schemaSourceScope ?? "production";
  const schemaFiles = files.filter((file) =>
    sourceScopeIncluded(classifySourceScope({ path: file.path }), schemaScope),
  );
  const [security, schema] = await Promise.all([
    analyzeSecurity(files, { ...options.security, signal: options.signal }),
    analyzeSchema(schemaFiles, { ...options.schema, signal: options.signal }),
  ]);
  return { security, schema };
}

export * from "./types";
export * from "./registry";
export * from "./source";
export * from "./security";
export * from "./schema";

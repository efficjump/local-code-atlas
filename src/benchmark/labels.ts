import type { AtlasReport } from "../report/types.js";
import {
  BENCHMARK_DIMENSIONS,
  type BenchmarkLabels,
} from "./types.js";

export function impactBenchmarkLabel(file: string): string {
  return file.replaceAll("\\", "/");
}

export function securityBenchmarkLabel(finding: {
  category: string;
  file: string;
  line?: number;
}): string {
  return `${finding.category}:${finding.file.replaceAll("\\", "/")}:${finding.line ?? "-"}`;
}

export function schemaTableBenchmarkLabel(tableName: string): string {
  return `table:${tableName}`;
}

export function schemaColumnBenchmarkLabel(
  tableName: string,
  columnName: string,
): string {
  return `column:${tableName}.${columnName}`;
}

export function schemaRelationshipBenchmarkLabel(relationship: {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  origin: string;
}): string {
  return `relationship:${relationship.fromTable}.${relationship.fromColumn}->${relationship.toTable}.${relationship.toColumn}:${relationship.origin}`;
}

function sortedUnique(labels: readonly string[]): string[] {
  return [...new Set(labels)].sort((left, right) =>
    left.localeCompare(right, "en"),
  );
}

function defaultMigrationLabels(report: AtlasReport): string[] {
  const migration = (report as AtlasReport & {
    migration?: { findings?: unknown[]; risks?: unknown[] };
  }).migration;
  const observations = migration?.findings ?? migration?.risks ?? [];
  return observations.flatMap((observation) => {
    if (typeof observation === "string") return [observation];
    if (typeof observation !== "object" || observation === null) return [];
    const candidate = observation as Record<string, unknown>;
    for (const field of ["benchmarkLabel", "label"] as const) {
      if (typeof candidate[field] === "string" && candidate[field].trim()) {
        return [candidate[field].trim()];
      }
    }
    const category = candidate.category;
    const table = candidate.qualifiedTable ?? candidate.table;
    const column = candidate.column;
    if (
      typeof category === "string" &&
      category.trim() &&
      typeof table === "string" &&
      table.trim()
    ) {
      const namespace =
        typeof candidate.namespace === "string" && candidate.namespace.trim()
          ? candidate.namespace.trim()
          : undefined;
      const qualifiedTable =
        namespace && !table.includes(".")
          ? `${namespace}.${table.trim()}`
          : table.trim();
      return [
        `${category.trim()}:${qualifiedTable}${
          typeof column === "string" && column.trim()
            ? `.${column.trim()}`
            : ""
        }`,
      ];
    }
    if (typeof candidate.id === "string" && candidate.id.trim()) {
      return [candidate.id.trim()];
    }
    return [];
  });
}

export interface ExtractBenchmarkLabelsOptions {
  /** Adapter for a migration analyzer whose result contract is not yet part of AtlasReport. */
  migration?: (report: AtlasReport) => readonly string[];
}

/** Convert a report into stable, human-editable labels used by JSON manifests. */
export function extractBenchmarkLabels(
  report: AtlasReport,
  options: ExtractBenchmarkLabelsOptions = {},
): BenchmarkLabels {
  const labels: BenchmarkLabels = {
    impact: report.impact.findings.map((finding) =>
      impactBenchmarkLabel(finding.file),
    ),
    security: report.security.findings.map(securityBenchmarkLabel),
    schema: [
      ...report.erd.tables.flatMap((table) => [
        schemaTableBenchmarkLabel(table.name),
        ...table.columns.map((column) =>
          schemaColumnBenchmarkLabel(table.name, column.name),
        ),
      ]),
      ...report.erd.relationships.map(schemaRelationshipBenchmarkLabel),
    ],
    migration: [
      ...(options.migration?.(report) ?? defaultMigrationLabels(report)),
    ],
  };
  return Object.fromEntries(
    BENCHMARK_DIMENSIONS.map((dimension) => [
      dimension,
      sortedUnique(labels[dimension]),
    ]),
  ) as BenchmarkLabels;
}

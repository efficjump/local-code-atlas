import { AnalyzerRegistry } from "../registry";
import { confidence, stableId } from "../source";
import type { AnalysisFile, FileAnalyzer } from "../types";
import { OrmAnnotationSchemaAnalyzer } from "./orm-analyzer";
import { PrismaSchemaAnalyzer } from "./prisma-analyzer";
import { SqlSchemaAnalyzer } from "./sql-analyzer";
import type {
  SchemaAnalysisResult,
  SchemaColumn,
  SchemaObservation,
  SchemaRelationship,
  SchemaTable,
} from "./types";

export interface SchemaAnalyzerOptions {
  signal?: AbortSignal;
  includeDefaults?: boolean;
  inferRelationships?: boolean;
  analyzers?: readonly FileAnalyzer<SchemaObservation>[];
}

export function createSchemaRegistry(
  options: Omit<SchemaAnalyzerOptions, "signal" | "inferRelationships"> = {},
): AnalyzerRegistry<SchemaObservation> {
  const registry = new AnalyzerRegistry<SchemaObservation>("schema");
  if (options.includeDefaults !== false) {
    registry.register(new SqlSchemaAnalyzer());
    registry.register(new PrismaSchemaAnalyzer());
    registry.register(new OrmAnnotationSchemaAnalyzer());
  }
  for (const analyzer of options.analyzers ?? []) registry.register(analyzer);
  return registry;
}

export async function analyzeSchema(
  files: readonly AnalysisFile[],
  options: SchemaAnalyzerOptions = {},
): Promise<SchemaAnalysisResult> {
  const registry = createSchemaRegistry(options);
  const run = await registry.run(files, options.signal);
  const tables = mergeTables(
    run.observations
      .filter((observation) => observation.kind === "table")
      .map((observation) => observation.table),
  );
  const resolvedRelationships = run.observations
    .filter((observation) => observation.kind === "relationship")
    .map((observation) => resolveRelationship(observation.relationship, tables));
  const declaredRelationships = deduplicateRelationships(resolvedRelationships);
  const inferredRelationships =
    options.inferRelationships === false
      ? []
      : inferConventionRelationships(tables, declaredRelationships);
  const relationships = [...declaredRelationships, ...inferredRelationships].sort(
    compareRelationships,
  );
  tables.sort((left, right) => qualifiedName(left).localeCompare(qualifiedName(right)));

  return {
    tables,
    relationships,
    executions: run.executions,
    summary: {
      scannedFileCount: new Set(files.map((file) => file.path)).size,
      tableCount: tables.length,
      columnCount: tables.reduce((count, table) => count + table.columns.length, 0),
      declaredRelationshipCount: declaredRelationships.length,
      inferredRelationshipCount: inferredRelationships.length,
    },
  };
}

function mergeTables(fragments: readonly SchemaTable[]): SchemaTable[] {
  const merged = new Map<string, SchemaTable>();
  for (const fragment of fragments) {
    const key = tableKey(fragment.namespace, fragment.name);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, cloneTable(fragment));
      continue;
    }
    existing.logicalName ??= fragment.logicalName;
    existing.sourceKind =
      existing.sourceKind === fragment.sourceKind ? existing.sourceKind : "mixed";
    if (fragment.declaration === "declared") existing.declaration = "declared";
    if (fragment.confidence.score > existing.confidence.score) {
      existing.confidence = fragment.confidence;
    }
    existing.provenance = uniqueProvenance([
      ...existing.provenance,
      ...fragment.provenance,
    ]);
    for (const column of fragment.columns) mergeColumn(existing.columns, column);
    existing.primaryKey = uniqueStrings([
      ...existing.primaryKey,
      ...fragment.primaryKey,
    ]);
    existing.uniqueKeys = uniqueStringArrays([
      ...existing.uniqueKeys,
      ...fragment.uniqueKeys,
    ]);
  }
  return [...merged.values()];
}

function mergeColumn(target: SchemaColumn[], incoming: SchemaColumn): void {
  const existing = target.find(
    (column) => column.name.toLowerCase() === incoming.name.toLowerCase(),
  );
  if (!existing) {
    target.push({ ...incoming });
    return;
  }
  existing.logicalName ??= incoming.logicalName;
  existing.primaryKey ||= incoming.primaryKey;
  existing.unique ||= incoming.unique;
  existing.generated ||= incoming.generated;
  existing.nullable &&= incoming.nullable;
  if (incoming.confidence.score > existing.confidence.score) {
    existing.dataType = incoming.dataType;
    existing.confidence = incoming.confidence;
    existing.provenance = incoming.provenance;
    existing.declaration = incoming.declaration;
  }
}

function resolveRelationship(
  relationship: SchemaRelationship,
  tables: readonly SchemaTable[],
): SchemaRelationship {
  const fromTable = resolveTable(
    relationship.from.table,
    relationship.from.namespace,
    tables,
  );
  const toTable = resolveTable(
    relationship.to.table,
    relationship.to.namespace,
    tables,
  );
  const fromColumns = resolveColumns(
    relationship.from.columns,
    fromTable?.columns ?? [],
  );
  const toColumns = resolveColumns(
    relationship.to.columns,
    toTable?.columns ?? [],
  );
  return {
    ...relationship,
    from: {
      table: fromTable?.name ?? relationship.from.table,
      namespace: fromTable?.namespace ?? relationship.from.namespace,
      columns: fromColumns,
    },
    to: {
      table: toTable?.name ?? relationship.to.table,
      namespace: toTable?.namespace ?? relationship.to.namespace,
      columns: toColumns,
    },
  };
}

function resolveTable(
  name: string,
  namespace: string | undefined,
  tables: readonly SchemaTable[],
): SchemaTable | undefined {
  const exact = tables.find(
    (table) =>
      table.name.toLowerCase() === name.toLowerCase() &&
      (namespace === undefined ||
        (table.namespace ?? "").toLowerCase() === namespace.toLowerCase()),
  );
  if (exact) return exact;
  const logical = tables.filter(
    (table) => table.logicalName?.toLowerCase() === name.toLowerCase(),
  );
  if (namespace) {
    const sameNamespace = logical.find(
      (table) => (table.namespace ?? "").toLowerCase() === namespace.toLowerCase(),
    );
    if (sameNamespace) return sameNamespace;
  }
  return logical.length === 1 ? logical[0] : undefined;
}

function resolveColumns(
  names: readonly string[],
  columns: readonly SchemaColumn[],
): string[] {
  return names.map(
    (name) =>
      columns.find(
        (column) =>
          column.name.toLowerCase() === name.toLowerCase() ||
          column.logicalName?.toLowerCase() === name.toLowerCase(),
      )?.name ?? name,
  );
}

function deduplicateRelationships(
  relationships: readonly SchemaRelationship[],
): SchemaRelationship[] {
  const withOwningSides = relationships.filter((relationship) => {
    if (relationship.from.columns.length > 0) return true;
    return !relationships.some(
      (other) =>
        other !== relationship &&
        other.from.columns.length > 0 &&
        sameTablePair(relationship, other),
    );
  });
  const merged = new Map<string, SchemaRelationship>();
  for (const relationship of withOwningSides) {
    const key = relationshipKey(relationship);
    const existing = merged.get(key);
    if (!existing || relationship.confidence.score > existing.confidence.score) {
      merged.set(key, relationship);
    }
  }
  return [...merged.values()];
}

function inferConventionRelationships(
  tables: readonly SchemaTable[],
  declared: readonly SchemaRelationship[],
): SchemaRelationship[] {
  const inferred: SchemaRelationship[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (!/_id$/i.test(column.name)) continue;
      if (
        declared.some(
          (relationship) =>
            tableKey(relationship.from.namespace, relationship.from.table) ===
              tableKey(table.namespace, table.name) &&
            relationship.from.columns.some(
              (name) => name.toLowerCase() === column.name.toLowerCase(),
            ),
        )
      ) {
        continue;
      }
      const target = findConventionTarget(column.name, table, tables);
      if (!target) continue;
      const targetColumn =
        target.primaryKey.length === 1
          ? target.primaryKey[0]
          : target.columns.find((candidate) => candidate.name.toLowerCase() === "id")
              ?.name;
      if (!targetColumn) continue;
      inferred.push({
        id: `relationship-${stableId(
          table.namespace ?? "",
          table.name,
          column.name,
          target.namespace ?? "",
          target.name,
          targetColumn,
          "inferred",
        )}`,
        from: {
          table: table.name,
          namespace: table.namespace,
          columns: [column.name],
        },
        to: {
          table: target.name,
          namespace: target.namespace,
          columns: [targetColumn],
        },
        cardinality:
          column.unique || column.primaryKey ? "one-to-one" : "many-to-one",
        declaration: "inferred",
        confidence: confidence(
          0.62,
          "The column uses an *_id naming convention and a matching table with a singular primary key exists, but no foreign-key declaration was found.",
        ),
        provenance: column.provenance,
      });
    }
  }
  return inferred;
}

function findConventionTarget(
  columnName: string,
  sourceTable: SchemaTable,
  tables: readonly SchemaTable[],
): SchemaTable | undefined {
  const prefix = columnName.replace(/_id$/i, "").toLowerCase();
  const components = prefix.split("_");
  const candidates: string[] = [];
  for (let index = 0; index < components.length; index += 1) {
    const base = components.slice(index).join("_");
    candidates.push(base, `${base}s`, `${base}es`);
    if (base.endsWith("y")) candidates.push(`${base.slice(0, -1)}ies`);
  }
  return tables.find(
    (table) =>
      table !== sourceTable &&
      (table.namespace ?? "").toLowerCase() ===
        (sourceTable.namespace ?? "").toLowerCase() &&
      candidates.includes(table.name.toLowerCase()),
  );
}

function relationshipKey(relationship: SchemaRelationship): string {
  if (relationship.from.columns.length === 0 && relationship.to.columns.length === 0) {
    return [endpointTableKey(relationship.from), endpointTableKey(relationship.to)]
      .sort()
      .join("<->");
  }
  return `${endpointTableKey(relationship.from)}:${[...relationship.from.columns]
    .sort()
    .join(",")}->${endpointTableKey(relationship.to)}:${[
    ...relationship.to.columns,
  ]
    .sort()
    .join(",")}`;
}

function sameTablePair(
  left: SchemaRelationship,
  right: SchemaRelationship,
): boolean {
  const leftPair = [endpointTableKey(left.from), endpointTableKey(left.to)].sort();
  const rightPair = [endpointTableKey(right.from), endpointTableKey(right.to)].sort();
  return leftPair[0] === rightPair[0] && leftPair[1] === rightPair[1];
}

function endpointTableKey(endpoint: {
  table: string;
  namespace?: string;
}): string {
  return tableKey(endpoint.namespace, endpoint.table);
}

function tableKey(namespace: string | undefined, name: string): string {
  return `${namespace?.toLowerCase() ?? ""}.${name.toLowerCase()}`;
}

function qualifiedName(table: SchemaTable): string {
  return table.namespace ? `${table.namespace}.${table.name}` : table.name;
}

function compareRelationships(
  left: SchemaRelationship,
  right: SchemaRelationship,
): number {
  return relationshipKey(left).localeCompare(relationshipKey(right));
}

function cloneTable(table: SchemaTable): SchemaTable {
  return {
    ...table,
    provenance: [...table.provenance],
    columns: table.columns.map((column) => ({ ...column })),
    primaryKey: [...table.primaryKey],
    uniqueKeys: table.uniqueKeys.map((key) => [...key]),
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function uniqueStringArrays(values: readonly string[][]): string[][] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = [...value].sort().join("\u001f");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueProvenance(
  values: readonly SchemaTable["provenance"][number][],
): SchemaTable["provenance"] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.path}:${value.range.start.offset}:${value.range.end.offset}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export * from "./types";
export * from "./sql-analyzer";
export * from "./prisma-analyzer";
export * from "./orm-analyzer";

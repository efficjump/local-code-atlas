import type {
  AnalysisFile,
  AnalyzerContext,
  FileAnalyzer,
} from "../types";
import { confidence, provenance, stableId } from "../source";
import type {
  SchemaColumn,
  SchemaObservation,
  SchemaRelationship,
  SchemaTable,
} from "./types";

interface ModelBlock {
  name: string;
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
}

interface PrismaField {
  logicalName: string;
  physicalName: string;
  type: string;
  baseType: string;
  optional: boolean;
  list: boolean;
  attributes: string;
  start: number;
  end: number;
}

const PRISMA_SCALARS = new Set([
  "String",
  "Boolean",
  "Int",
  "BigInt",
  "Float",
  "Decimal",
  "DateTime",
  "Json",
  "Bytes",
]);

export class PrismaSchemaAnalyzer implements FileAnalyzer<SchemaObservation> {
  readonly id = "schema.prisma";
  readonly domain = "schema" as const;

  supports(file: AnalysisFile): boolean {
    return /\.prisma$/i.test(file.path) && file.content.length <= 10_000_000;
  }

  analyze(file: AnalysisFile, context: AnalyzerContext): readonly SchemaObservation[] {
    const modelNames = new Set(
      context.files
        .filter((candidate) => /\.prisma$/i.test(candidate.path))
        .flatMap((candidate) => findModelBlocks(candidate.content).map((block) => block.name)),
    );
    const observations: SchemaObservation[] = [];
    for (const block of findModelBlocks(file.content)) {
      const parsed = parseModel(file, block, modelNames, context);
      observations.push({ kind: "table", table: parsed.table });
      observations.push(
        ...parsed.relationships.map((relationship) => ({
          kind: "relationship" as const,
          relationship,
        })),
      );
    }
    return observations;
  }
}

function parseModel(
  file: AnalysisFile,
  block: ModelBlock,
  modelNames: ReadonlySet<string>,
  context: AnalyzerContext,
): { table: SchemaTable; relationships: SchemaRelationship[] } {
  const body = file.content.slice(block.bodyStart, block.bodyEnd);
  const mappedTable = body.match(/@@map\s*\(\s*["']([^"']+)["']\s*\)/)?.[1];
  const namespace = body.match(/@@schema\s*\(\s*["']([^"']+)["']\s*\)/)?.[1];
  const fields = parseFields(file.content, block);
  const physicalName = mappedTable ?? block.name;
  const scalarFields = fields.filter(
    (field) =>
      !modelNames.has(field.baseType) &&
      !/@relation\b/.test(field.attributes),
  );
  const columns = scalarFields.map((field) => fieldToColumn(file, field));
  const compositePrimary = parseCompositeAttribute(body, "id");
  const compositeUnique = parseAllCompositeAttributes(body, "unique");
  const primaryKey = uniqueStrings([
    ...columns.filter((column) => column.primaryKey).map((column) => column.name),
    ...resolveFieldNames(compositePrimary, scalarFields),
  ]);
  const uniqueKeys = uniqueStringArrays([
    ...columns.filter((column) => column.unique).map((column) => [column.name]),
    ...compositeUnique.map((key) => resolveFieldNames(key, scalarFields)),
  ]).filter((key) => key.length > 0);
  for (const column of columns) {
    if (primaryKey.includes(column.name)) {
      column.primaryKey = true;
      column.nullable = false;
    }
    if (uniqueKeys.some((key) => key.length === 1 && key[0] === column.name)) {
      column.unique = true;
    }
  }

  const table: SchemaTable = {
    id: `table-${stableId(namespace ?? "", physicalName)}`,
    name: physicalName,
    logicalName: block.name,
    namespace,
    sourceKind: "prisma",
    declaration: "declared",
    confidence: confidence(0.99, "A Prisma model explicitly declares this entity."),
    provenance: [provenance(file, block.start, block.end)],
    columns,
    primaryKey,
    uniqueKeys,
  };

  const relationships = fields
    .filter(
      (field) =>
        modelNames.has(field.baseType) || /@relation\b/.test(field.attributes),
    )
    .map((field) =>
      fieldToRelationship(file, field, table, scalarFields, context),
    )
    .filter((value): value is SchemaRelationship => Boolean(value));

  return { table, relationships };
}

function parseFields(content: string, block: ModelBlock): PrismaField[] {
  const fields: PrismaField[] = [];
  let offset = block.bodyStart;
  const body = content.slice(block.bodyStart, block.bodyEnd);
  for (const line of body.split("\n")) {
    const withoutComment = line.replace(/\/\/.*$/, "");
    const trimmed = withoutComment.trim();
    const leading = withoutComment.length - withoutComment.trimStart().length;
    if (!trimmed || trimmed.startsWith("@@")) {
      offset += line.length + 1;
      continue;
    }
    const match = trimmed.match(/^([A-Za-z_][\w]*)\s+([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) {
      offset += line.length + 1;
      continue;
    }
    const rawType = match[2];
    const optional = rawType.endsWith("?");
    const list = rawType.replace(/\?$/, "").endsWith("[]");
    const baseType = rawType.replace(/\?$/, "").replace(/\[\]$/, "").replace(/^Unsupported\(.+\)$/, "Unsupported");
    const attributes = match[3] ?? "";
    const mappedName = attributes.match(/@map\s*\(\s*["']([^"']+)["']\s*\)/)?.[1];
    const start = offset + leading;
    fields.push({
      logicalName: match[1],
      physicalName: mappedName ?? match[1],
      type: rawType,
      baseType,
      optional,
      list,
      attributes,
      start,
      end: offset + withoutComment.trimEnd().length,
    });
    offset += line.length + 1;
  }
  return fields;
}

function fieldToColumn(file: AnalysisFile, field: PrismaField): SchemaColumn {
  const primaryKey = /(?:^|\s)@id(?:\s|\(|$)/.test(field.attributes);
  return {
    name: field.physicalName,
    logicalName:
      field.physicalName === field.logicalName ? undefined : field.logicalName,
    dataType: field.type,
    nullable: field.optional && !primaryKey,
    primaryKey,
    unique: /(?:^|\s)@unique(?:\s|\(|$)/.test(field.attributes),
    generated: /@default\s*\(\s*(?:autoincrement|uuid|cuid|ulid|now)\s*\(/.test(
      field.attributes,
    ),
    declaration: "declared",
    confidence: confidence(0.99, "A scalar field is explicitly declared by the Prisma model."),
    provenance: provenance(file, field.start, field.end),
  };
}

function fieldToRelationship(
  file: AnalysisFile,
  field: PrismaField,
  table: SchemaTable,
  scalarFields: readonly PrismaField[],
  context: AnalyzerContext,
): SchemaRelationship | undefined {
  const relationArguments = relationAttributeArguments(field.attributes);
  const logicalFromColumns = namedArrayArgument(relationArguments, "fields");
  const targetColumns = namedArrayArgument(relationArguments, "references");
  const fromColumns = resolveFieldNames(logicalFromColumns, scalarFields);
  const hasUniqueForeignKey =
    fromColumns.length > 0 &&
    (sameStringSet(fromColumns, table.primaryKey) ||
      table.uniqueKeys.some((key) => sameStringSet(fromColumns, key)));
  let cardinality: SchemaRelationship["cardinality"];
  if (field.list) {
    cardinality = targetHasListBackReference(
      context,
      field.baseType,
      table.logicalName ?? table.name,
    )
      ? "many-to-many"
      : "one-to-many";
  } else {
    cardinality = hasUniqueForeignKey ? "one-to-one" : "many-to-one";
  }
  const relationName =
    relationArguments.match(/^\s*["']([^"']+)["']/)?.[1] ?? undefined;
  return {
    id: `relationship-${stableId(
      table.namespace ?? "",
      table.name,
      fromColumns.join(",") || field.logicalName,
      field.baseType,
      targetColumns.join(","),
    )}`,
    name: relationName,
    from: {
      table: table.name,
      namespace: table.namespace,
      columns: fromColumns,
    },
    to: {
      // The merge stage resolves this logical model name through @@map.
      table: field.baseType,
      columns: targetColumns,
    },
    cardinality,
    declaration: "declared",
    confidence: confidence(
      relationArguments || field.list ? 0.97 : 0.9,
      relationArguments
        ? "A Prisma @relation attribute explicitly defines the association."
        : "A Prisma relation field explicitly names the related model; physical keys are implicit.",
    ),
    provenance: provenance(file, field.start, field.end),
    onDelete: namedScalarArgument(relationArguments, "onDelete"),
    onUpdate: namedScalarArgument(relationArguments, "onUpdate"),
  };
}

function findModelBlocks(content: string): ModelBlock[] {
  const blocks: ModelBlock[] = [];
  const expression = /\bmodel\s+([A-Za-z_][\w]*)\s*\{/g;
  for (const match of content.matchAll(expression)) {
    if (match.index === undefined) continue;
    const open = match.index + match[0].lastIndexOf("{");
    const close = findMatchingBrace(content, open);
    if (close < 0) continue;
    blocks.push({
      name: match[1],
      start: match.index,
      bodyStart: open + 1,
      bodyEnd: close,
      end: close + 1,
    });
  }
  return blocks;
}

function findMatchingBrace(content: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let index = open; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote && content[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function relationAttributeArguments(attributes: string): string {
  const marker = attributes.indexOf("@relation");
  if (marker < 0) return "";
  const open = attributes.indexOf("(", marker);
  if (open < 0) return "";
  let depth = 0;
  let quote = "";
  for (let index = open; index < attributes.length; index += 1) {
    const character = attributes[index];
    if (quote) {
      if (character === quote && attributes[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return attributes.slice(open + 1, index);
    }
  }
  return "";
}

function namedArrayArgument(argumentsText: string, name: string): string[] {
  const match = argumentsText.match(
    new RegExp(`\\b${name}\\s*:\\s*\\[([^\\]]*)]`, "i"),
  );
  return match ? match[1].split(",").map((value) => value.trim()).filter(Boolean) : [];
}

function namedScalarArgument(argumentsText: string, name: string): string | undefined {
  return argumentsText.match(
    new RegExp(`\\b${name}\\s*:\\s*([A-Za-z_][\\w]*)`, "i"),
  )?.[1];
}

function parseCompositeAttribute(body: string, name: string): string[] {
  return (
    body
      .match(new RegExp(`@@${name}\\s*\\(\\s*\\[([^\\]]+)]`, "i"))?.[1]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? []
  );
}

function parseAllCompositeAttributes(body: string, name: string): string[][] {
  const values: string[][] = [];
  const expression = new RegExp(`@@${name}\\s*\\(\\s*\\[([^\\]]+)]`, "gi");
  for (const match of body.matchAll(expression)) {
    values.push(match[1].split(",").map((value) => value.trim()).filter(Boolean));
  }
  return values;
}

function resolveFieldNames(
  logicalNames: readonly string[],
  fields: readonly PrismaField[],
): string[] {
  return logicalNames.map(
    (name) => fields.find((field) => field.logicalName === name)?.physicalName ?? name,
  );
}

function targetHasListBackReference(
  context: AnalyzerContext,
  targetModel: string,
  sourceModel: string,
): boolean {
  for (const file of context.files) {
    if (!/\.prisma$/i.test(file.path)) continue;
    const block = findModelBlocks(file.content).find((candidate) => candidate.name === targetModel);
    if (!block) continue;
    const fields = parseFields(file.content, block);
    if (fields.some((field) => field.baseType === sourceModel && field.list)) return true;
  }
  return false;
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

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((value, index) => value === sortedRight[index]);
}

export { PRISMA_SCALARS };

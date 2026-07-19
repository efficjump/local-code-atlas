import type {
  AnalysisFile,
  FileAnalyzer,
} from "../types";
import { confidence, provenance, stableId } from "../source";
import type {
  SchemaColumn,
  SchemaObservation,
  SchemaRelationship,
  SchemaTable,
} from "./types";

interface ClassBlock {
  logicalName: string;
  physicalName: string;
  namespace?: string;
  start: number;
  bodyStart: number;
  bodyEnd: number;
  end: number;
  explicitTableName: boolean;
}

interface DecoratedField {
  name: string;
  type: string;
  optional: boolean;
  decorators: string;
  start: number;
  end: number;
}

type SupportedOrm = "typeorm" | "jpa";

export class OrmAnnotationSchemaAnalyzer
  implements FileAnalyzer<SchemaObservation>
{
  readonly id = "schema.orm-annotations";
  readonly domain = "schema" as const;

  supports(file: AnalysisFile): boolean {
    return (
      (/\.(?:[cm]?[jt]sx?)$/i.test(file.path) && /@Entity\b/.test(file.content)) ||
      (/\.(?:java|kt)$/i.test(file.path) && /@Entity\b/.test(file.content))
    );
  }

  analyze(file: AnalysisFile): readonly SchemaObservation[] {
    const orm: SupportedOrm = /\.(?:java|kt)$/i.test(file.path) ? "jpa" : "typeorm";
    const observations: SchemaObservation[] = [];
    for (const block of findEntityBlocks(file.content, orm)) {
      const parsed = parseEntity(file, block, orm);
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

function parseEntity(
  file: AnalysisFile,
  block: ClassBlock,
  orm: SupportedOrm,
): { table: SchemaTable; relationships: SchemaRelationship[] } {
  const fields = findDecoratedFields(file.content, block, orm);
  const columns: SchemaColumn[] = [];
  const relationships: SchemaRelationship[] = [];
  for (const field of fields) {
    const column = orm === "typeorm"
      ? typeOrmColumn(file, field)
      : jpaColumn(file, field);
    if (column) columns.push(column);
  }
  const table: SchemaTable = {
    id: `table-${stableId(block.namespace ?? "", block.physicalName)}`,
    name: block.physicalName,
    logicalName:
      block.physicalName === block.logicalName ? undefined : block.logicalName,
    namespace: block.namespace,
    sourceKind: orm,
    declaration: block.explicitTableName ? "declared" : "inferred",
    confidence: confidence(
      block.explicitTableName ? 0.96 : 0.7,
      block.explicitTableName
        ? `The ${orm === "typeorm" ? "@Entity" : "@Table"} annotation explicitly names the physical table.`
        : "An entity is explicit, but the physical table name depends on the ORM naming strategy and is represented by the class name.",
    ),
    provenance: [provenance(file, block.start, block.end)],
    columns,
    primaryKey: columns.filter((column) => column.primaryKey).map((column) => column.name),
    uniqueKeys: columns.filter((column) => column.unique).map((column) => [column.name]),
  };

  for (const field of fields) {
    const relation = orm === "typeorm"
      ? typeOrmRelationship(file, field, table)
      : jpaRelationship(file, field, table);
    if (!relation) continue;
    relationships.push(relation);
    for (const name of relation.from.columns) {
      if (columns.some((column) => column.name === name)) continue;
      columns.push({
        name,
        logicalName: field.name,
        dataType: "unknown",
        nullable: field.optional || /nullable\s*[:=]\s*true/i.test(field.decorators),
        primaryKey: false,
        unique: relation.cardinality === "one-to-one",
        declaration: "inferred",
        confidence: confidence(
          0.66,
          "The join annotation identifies the physical foreign-key column, but its scalar type is managed by the ORM.",
        ),
        provenance: provenance(file, field.start, field.end),
      });
    }
  }
  return { table, relationships };
}

function findEntityBlocks(content: string, orm: SupportedOrm): ClassBlock[] {
  const blocks: ClassBlock[] = [];
  const expression = orm === "typeorm"
    ? /@Entity(?:\s*\(([\s\S]*?)\))?\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)[^\{]*\{/g
    : /@Entity(?:\s*\([^)]*\))?([\s\S]{0,1200}?)\b(?:class|data\s+class)\s+([A-Za-z_$][\w$]*)[^\{]*\{/g;
  for (const match of content.matchAll(expression)) {
    if (match.index === undefined) continue;
    const open = match.index + match[0].lastIndexOf("{");
    const close = findMatchingBrace(content, open);
    if (close < 0) continue;
    const className = match[2];
    let physicalName: string | undefined;
    let namespace: string | undefined;
    if (orm === "typeorm") {
      physicalName = firstString(match[1] ?? "") ??
        namedString(match[1] ?? "", "name");
    } else {
      const annotations = match[1] ?? "";
      const tableAnnotation = annotations.match(/@Table\s*\(([^)]*)\)/)?.[1] ?? "";
      physicalName = namedString(tableAnnotation, "name");
      namespace = namedString(tableAnnotation, "schema");
    }
    blocks.push({
      logicalName: className,
      physicalName: physicalName ?? className,
      namespace,
      start: match.index,
      bodyStart: open + 1,
      bodyEnd: close,
      end: close + 1,
      explicitTableName: Boolean(physicalName),
    });
  }
  return blocks;
}

function findDecoratedFields(
  content: string,
  block: ClassBlock,
  orm: SupportedOrm,
): DecoratedField[] {
  const body = content.slice(block.bodyStart, block.bodyEnd);
  const fields: DecoratedField[] = [];
  const expression = orm === "typeorm"
    ? /((?:\s*@[A-Za-z_$][\w$.]*(?:\s*\([^\n]*\))?\s*)+)(?:(?:public|private|protected|readonly|declare|static)\s+)*([A-Za-z_$][\w$]*)([!?]?)\s*:\s*([^;=\n]+)[;=]?/g
    : /((?:\s*@[A-Za-z_$][\w$.]*(?:\s*\([^\n]*\))?\s*)+)(?:(?:public|private|protected|internal|lateinit|final|transient|static)\s+)*(?:(?:val|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$<>, ?.\[\]]*)|([A-Za-z_$][\w$<>, ?.\[\]]*)\s+([A-Za-z_$][\w$]*))\s*[;=]?/g;
  for (const match of body.matchAll(expression)) {
    if (match.index === undefined) continue;
    if (orm === "typeorm") {
      const name = match[2];
      fields.push({
        name,
        type: match[4].trim(),
        optional: match[3] === "?",
        decorators: match[1],
        start: block.bodyStart + match.index,
        end: block.bodyStart + match.index + match[0].length,
      });
    } else {
      const name = match[2] ?? match[5];
      const type = match[3] ?? match[4];
      if (!name || !type) continue;
      fields.push({
        name,
        type: type.trim(),
        optional: type.includes("?") || /nullable\s*=\s*true/i.test(match[1]),
        decorators: match[1],
        start: block.bodyStart + match.index,
        end: block.bodyStart + match.index + match[0].length,
      });
    }
  }
  return fields;
}

function typeOrmColumn(
  file: AnalysisFile,
  field: DecoratedField,
): SchemaColumn | undefined {
  const columnDecorator = field.decorators.match(
    /@(PrimaryGeneratedColumn|PrimaryColumn|Column|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn)(?:\s*\(([^\n]*)\))?/,
  );
  if (!columnDecorator) return undefined;
  const argumentsText = columnDecorator[2] ?? "";
  const primaryKey = columnDecorator[1].startsWith("Primary");
  return {
    name: namedString(argumentsText, "name") ?? field.name,
    logicalName: namedString(argumentsText, "name") ? field.name : undefined,
    dataType: firstString(argumentsText) ?? field.type,
    nullable:
      !primaryKey &&
      (field.optional || /nullable\s*:\s*true/i.test(argumentsText)),
    primaryKey,
    unique: /unique\s*:\s*true/i.test(argumentsText),
    generated: columnDecorator[1] === "PrimaryGeneratedColumn",
    declaration: "declared",
    confidence: confidence(0.94, "A TypeORM column decorator explicitly declares this field."),
    provenance: provenance(file, field.start, field.end),
  };
}

function jpaColumn(
  file: AnalysisFile,
  field: DecoratedField,
): SchemaColumn | undefined {
  if (
    !/@(?:Column|Id|EmbeddedId|GeneratedValue|Basic|CreationTimestamp|UpdateTimestamp)\b/.test(
      field.decorators,
    ) ||
    /@(?:Transient|ManyToOne|OneToMany|OneToOne|ManyToMany)\b/.test(field.decorators)
  ) {
    return undefined;
  }
  const columnArguments = field.decorators.match(/@Column\s*\(([^)]*)\)/)?.[1] ?? "";
  const primaryKey = /@(?:Id|EmbeddedId)\b/.test(field.decorators);
  const physicalName = namedString(columnArguments, "name");
  return {
    name: physicalName ?? field.name,
    logicalName: physicalName ? field.name : undefined,
    dataType: field.type,
    nullable:
      !primaryKey && !/nullable\s*=\s*false/i.test(columnArguments),
    primaryKey,
    unique: /unique\s*=\s*true/i.test(columnArguments),
    generated: /@GeneratedValue\b/.test(field.decorators),
    declaration: "declared",
    confidence: confidence(0.94, "JPA annotations explicitly declare this persistent field."),
    provenance: provenance(file, field.start, field.end),
  };
}

function typeOrmRelationship(
  file: AnalysisFile,
  field: DecoratedField,
  table: SchemaTable,
): SchemaRelationship | undefined {
  const relation = field.decorators.match(
    /@(ManyToOne|OneToMany|OneToOne|ManyToMany)\s*\(([^\n]*)\)/,
  );
  if (!relation) return undefined;
  const target = relation[2].match(/=>\s*([A-Za-z_$][\w$]*)/)?.[1] ??
    baseType(field.type);
  const join = field.decorators.match(/@JoinColumn\s*(?:\(([^\n]*)\))?/);
  const joinArguments = join?.[1] ?? "";
  const fromColumns = join || relation[1] === "ManyToOne"
    ? [namedString(joinArguments, "name") ?? `${field.name}Id`]
    : [];
  return ormRelationship(
    file,
    field,
    table,
    target,
    fromColumns,
    namedString(joinArguments, "referencedColumnName")
      ? [namedString(joinArguments, "referencedColumnName")!]
      : [],
    cardinalityForDecorator(relation[1]),
    namedString(relation[2], "onDelete"),
    namedString(relation[2], "onUpdate"),
    fromColumns.length > 0 ? 0.9 : 0.82,
  );
}

function jpaRelationship(
  file: AnalysisFile,
  field: DecoratedField,
  table: SchemaTable,
): SchemaRelationship | undefined {
  const relation = field.decorators.match(/@(ManyToOne|OneToMany|OneToOne|ManyToMany)\b/);
  if (!relation) return undefined;
  const joinArguments = field.decorators.match(/@JoinColumn\s*\(([^)]*)\)/)?.[1] ?? "";
  const owning = relation[1] === "ManyToOne" || /@JoinColumn\b/.test(field.decorators);
  return ormRelationship(
    file,
    field,
    table,
    baseType(field.type),
    owning ? [namedString(joinArguments, "name") ?? `${field.name}_id`] : [],
    namedString(joinArguments, "referencedColumnName")
      ? [namedString(joinArguments, "referencedColumnName")!]
      : [],
    cardinalityForDecorator(relation[1]),
    undefined,
    undefined,
    /@JoinColumn\b/.test(field.decorators) ? 0.91 : 0.78,
  );
}

function ormRelationship(
  file: AnalysisFile,
  field: DecoratedField,
  table: SchemaTable,
  target: string,
  fromColumns: string[],
  targetColumns: string[],
  cardinality: SchemaRelationship["cardinality"],
  onDelete: string | undefined,
  onUpdate: string | undefined,
  score: number,
): SchemaRelationship {
  return {
    id: `relationship-${stableId(table.name, field.name, target, fromColumns.join(","))}`,
    from: {
      table: table.name,
      namespace: table.namespace,
      columns: fromColumns,
    },
    to: { table: target, columns: targetColumns },
    cardinality,
    declaration: "declared",
    confidence: confidence(
      score,
      fromColumns.length > 0
        ? "An ORM relationship and its owning join column are declared by annotations."
        : "An ORM relationship is explicit, while its physical foreign key is implicit or owned by the other side.",
    ),
    provenance: provenance(file, field.start, field.end),
    onDelete,
    onUpdate,
  };
}

function cardinalityForDecorator(
  name: string,
): SchemaRelationship["cardinality"] {
  if (name === "OneToOne") return "one-to-one";
  if (name === "OneToMany") return "one-to-many";
  if (name === "ManyToMany") return "many-to-many";
  return "many-to-one";
}

function firstString(input: string): string | undefined {
  return input.match(/^[\s{]*["']([^"']+)["']/)?.[1];
}

function namedString(input: string, name: string): string | undefined {
  return input.match(
    new RegExp(`\\b${name}\\s*[:=]\\s*["']([^"']+)["']`, "i"),
  )?.[1];
}

function baseType(type: string): string {
  const generic = type.match(/<\s*([A-Za-z_$][\w$]*)\s*>/)?.[1];
  return (generic ?? type).replace(/[?\[\]]/g, "").trim().split(/[.\s]/).pop() ?? type;
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
    if (character === '"' || character === "'" || character === "`") {
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

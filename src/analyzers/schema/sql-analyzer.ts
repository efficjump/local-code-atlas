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

interface QualifiedIdentifier {
  name: string;
  namespace?: string;
  end: number;
}

interface ParsedColumn {
  column: SchemaColumn;
  inlineRelationship?: SchemaRelationship;
}

const TABLE_PREFIX = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/gi;
const ALTER_PREFIX = /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?/gi;

export class SqlSchemaAnalyzer implements FileAnalyzer<SchemaObservation> {
  readonly id = "schema.sql";
  readonly domain = "schema" as const;

  supports(file: AnalysisFile): boolean {
    return /\.sql$/i.test(file.path) && file.content.length <= 10_000_000;
  }

  analyze(file: AnalysisFile): readonly SchemaObservation[] {
    return [...parseCreateTables(file), ...parseAlterTables(file)];
  }
}

function parseCreateTables(file: AnalysisFile): SchemaObservation[] {
  const observations: SchemaObservation[] = [];
  const searchable = maskSqlComments(file.content);
  const expression = new RegExp(TABLE_PREFIX.source, TABLE_PREFIX.flags);
  for (const match of searchable.matchAll(expression)) {
    if (match.index === undefined) continue;
    const tableIdentifier = readQualifiedIdentifier(
      file.content,
      match.index + match[0].length,
    );
    if (!tableIdentifier) continue;
    const open = skipWhitespace(file.content, tableIdentifier.end);
    if (file.content[open] !== "(") continue;
    const close = findMatchingParenthesis(file.content, open);
    if (close < 0) continue;

    const table = makeTable(
      file,
      tableIdentifier,
      match.index,
      close + 1,
      "declared",
    );
    const relationships: SchemaRelationship[] = [];
    const segments = splitSqlList(file.content, open + 1, close);

    for (const segment of segments) {
      const trimmed = trimRange(file.content, segment.start, segment.end);
      if (trimmed.start >= trimmed.end) continue;
      const text = file.content.slice(trimmed.start, trimmed.end);
      const constraint = stripConstraintPrefix(text);
      const structural = constraint.rest.trimStart();
      const structuralOffset =
        trimmed.start + constraint.restOffset +
        (constraint.rest.length - constraint.rest.trimStart().length);

      if (/^PRIMARY\s+KEY\b/i.test(structural)) {
        const columns = parenthesizedIdentifiers(structural);
        table.primaryKey = uniqueStrings([...table.primaryKey, ...columns]);
        continue;
      }
      if (/^UNIQUE\b/i.test(structural)) {
        const columns = parenthesizedIdentifiers(structural);
        if (columns.length > 0) table.uniqueKeys.push(columns);
        continue;
      }
      if (/^FOREIGN\s+KEY\b/i.test(structural)) {
        const relation = parseForeignKey(
          file,
          structural,
          structuralOffset,
          tableIdentifier,
          constraint.name,
          table,
        );
        if (relation) relationships.push(relation);
        continue;
      }
      if (/^(?:CHECK|EXCLUDE)\b/i.test(structural)) continue;

      const parsed = parseColumn(
        file,
        text,
        trimmed.start,
        tableIdentifier,
      );
      if (!parsed) continue;
      table.columns.push(parsed.column);
      if (parsed.column.primaryKey) table.primaryKey.push(parsed.column.name);
      if (parsed.column.unique) table.uniqueKeys.push([parsed.column.name]);
      if (parsed.inlineRelationship) relationships.push(parsed.inlineRelationship);
    }

    table.primaryKey = uniqueStrings(table.primaryKey);
    table.uniqueKeys = uniqueStringArrays(table.uniqueKeys);
    for (const column of table.columns) {
      if (table.primaryKey.includes(column.name)) {
        column.primaryKey = true;
        column.nullable = false;
      }
      if (table.uniqueKeys.some((key) => key.length === 1 && key[0] === column.name)) {
        column.unique = true;
      }
    }
    for (const relationship of relationships) {
      relationship.cardinality = relationshipCardinality(
        relationship.from.columns,
        table,
      );
    }
    observations.push({ kind: "table", table });
    observations.push(
      ...relationships.map((relationship) => ({
        kind: "relationship" as const,
        relationship,
      })),
    );
  }
  return observations;
}

function parseAlterTables(file: AnalysisFile): SchemaObservation[] {
  const observations: SchemaObservation[] = [];
  const searchable = maskSqlComments(file.content);
  const expression = new RegExp(ALTER_PREFIX.source, ALTER_PREFIX.flags);
  for (const match of searchable.matchAll(expression)) {
    if (match.index === undefined) continue;
    const tableIdentifier = readQualifiedIdentifier(
      file.content,
      match.index + match[0].length,
    );
    if (!tableIdentifier) continue;
    const statementEnd = findStatementEnd(file.content, tableIdentifier.end);
    const actionStart = skipWhitespace(file.content, tableIdentifier.end);
    const actionText = file.content.slice(actionStart, statementEnd).trim();
    if (!actionText) continue;
    const table = makeTable(
      file,
      tableIdentifier,
      match.index,
      statementEnd,
      "inferred",
    );

    const addColumn = actionText.match(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]+)$/i);
    const looksLikeConstraint = /^ADD\s+(?:CONSTRAINT\b|FOREIGN\s+KEY\b|PRIMARY\s+KEY\b|UNIQUE\b)/i.test(
      actionText,
    );
    if (addColumn && !looksLikeConstraint) {
      const columnText = addColumn[1].replace(/;\s*$/, "");
      const columnOffset = file.content.indexOf(columnText, actionStart);
      const parsed = parseColumn(
        file,
        columnText,
        columnOffset < 0 ? actionStart : columnOffset,
        tableIdentifier,
      );
      if (parsed) {
        table.columns.push(parsed.column);
        if (parsed.column.primaryKey) table.primaryKey.push(parsed.column.name);
        if (parsed.column.unique) table.uniqueKeys.push([parsed.column.name]);
        if (parsed.inlineRelationship) {
          observations.push({
            kind: "relationship",
            relationship: parsed.inlineRelationship,
          });
        }
        observations.push({ kind: "table", table });
      }
      continue;
    }

    const constraintText = actionText.replace(/^ADD\s+/i, "");
    const stripped = stripConstraintPrefix(constraintText);
    const foreignText = stripped.rest.trimStart();
    if (/^FOREIGN\s+KEY\b/i.test(foreignText)) {
      const relative = actionText.indexOf(foreignText);
      const relation = parseForeignKey(
        file,
        foreignText,
        actionStart + Math.max(0, relative),
        tableIdentifier,
        stripped.name,
        table,
      );
      if (relation) {
        observations.push({ kind: "table", table });
        observations.push({ kind: "relationship", relationship: relation });
      }
    }
  }
  return observations;
}

function makeTable(
  file: AnalysisFile,
  identifier: QualifiedIdentifier,
  start: number,
  end: number,
  declaration: "declared" | "inferred",
): SchemaTable {
  return {
    id: `table-${stableId(identifier.namespace ?? "", identifier.name)}`,
    name: identifier.name,
    namespace: identifier.namespace,
    sourceKind: "sql",
    declaration,
    confidence: confidence(
      declaration === "declared" ? 0.99 : 0.7,
      declaration === "declared"
        ? "A CREATE TABLE statement explicitly declares this table."
        : "An ALTER TABLE statement refers to a table declared elsewhere.",
    ),
    provenance: [provenance(file, start, end)],
    columns: [],
    primaryKey: [],
    uniqueKeys: [],
  };
}

function parseColumn(
  file: AnalysisFile,
  text: string,
  absoluteOffset: number,
  table: QualifiedIdentifier,
): ParsedColumn | undefined {
  const identifier = readIdentifierToken(text, 0);
  if (!identifier) return undefined;
  const rest = text.slice(identifier.end).trimStart();
  if (!rest || /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(identifier.value)) {
    return undefined;
  }
  const restOffset =
    absoluteOffset + identifier.end +
    (text.slice(identifier.end).length - text.slice(identifier.end).trimStart().length);
  const constraintIndex = firstConstraintIndex(rest);
  const dataType = normalizeWhitespace(
    rest.slice(0, constraintIndex < 0 ? rest.length : constraintIndex),
  );
  if (!dataType) return undefined;
  const constraints = constraintIndex < 0 ? "" : rest.slice(constraintIndex);
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(constraints);
  const unique = /\bUNIQUE\b/i.test(constraints);
  const nullable = !primaryKey && !/\bNOT\s+NULL\b/i.test(constraints);
  const columnStart = absoluteOffset + identifier.start;
  const column: SchemaColumn = {
    name: identifier.value,
    dataType,
    nullable,
    primaryKey,
    unique,
    generated: /\b(?:GENERATED|IDENTITY|AUTO_INCREMENT|AUTOINCREMENT)\b/i.test(
      constraints,
    ),
    declaration: "declared",
    confidence: confidence(0.98, "The SQL column definition is explicit."),
    provenance: provenance(file, columnStart, absoluteOffset + text.length),
  };

  const reference = constraints.match(
    /\bREFERENCES\s+((?:["`\[]?[A-Za-z_$][\w$-]*["`\]]?)(?:\s*\.\s*(?:["`\[]?[A-Za-z_$][\w$-]*["`\]]?))?)\s*\(([^)]+)\)([\s\S]*)/i,
  );
  let inlineRelationship: SchemaRelationship | undefined;
  if (reference && reference.index !== undefined) {
    const target = parseQualifiedIdentifierText(reference[1]);
    const targetColumns = parseIdentifierList(reference[2]);
    if (target && targetColumns.length > 0) {
      const relationOffset = restOffset + constraintIndex + reference.index;
      inlineRelationship = makeRelationship(
        file,
        table,
        [identifier.value],
        target,
        targetColumns,
        relationOffset,
        relationOffset + reference[0].length,
        undefined,
        reference[3],
        unique || primaryKey ? "one-to-one" : "many-to-one",
      );
    }
  }
  return { column, inlineRelationship };
}

function parseForeignKey(
  file: AnalysisFile,
  text: string,
  absoluteOffset: number,
  fromTable: QualifiedIdentifier,
  constraintName: string | undefined,
  table: SchemaTable,
): SchemaRelationship | undefined {
  const match = text.match(
    /^FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+((?:["`\[]?[A-Za-z_$][\w$-]*["`\]]?)(?:\s*\.\s*(?:["`\[]?[A-Za-z_$][\w$-]*["`\]]?))?)\s*\(([^)]+)\)([\s\S]*)/i,
  );
  if (!match) return undefined;
  const fromColumns = parseIdentifierList(match[1]);
  const target = parseQualifiedIdentifierText(match[2]);
  const targetColumns = parseIdentifierList(match[3]);
  if (!target || fromColumns.length === 0 || targetColumns.length === 0) {
    return undefined;
  }
  return makeRelationship(
    file,
    fromTable,
    fromColumns,
    target,
    targetColumns,
    absoluteOffset,
    absoluteOffset + match[0].length,
    constraintName,
    match[4],
    relationshipCardinality(fromColumns, table),
  );
}

function makeRelationship(
  file: AnalysisFile,
  fromTable: QualifiedIdentifier,
  fromColumns: string[],
  target: QualifiedIdentifier,
  targetColumns: string[],
  start: number,
  end: number,
  name: string | undefined,
  trailingClause: string,
  cardinality: SchemaRelationship["cardinality"],
): SchemaRelationship {
  return {
    id: `relationship-${stableId(
      fromTable.namespace ?? "",
      fromTable.name,
      fromColumns.join(","),
      target.namespace ?? "",
      target.name,
      targetColumns.join(","),
    )}`,
    name,
    from: {
      table: fromTable.name,
      namespace: fromTable.namespace,
      columns: fromColumns,
    },
    to: {
      table: target.name,
      namespace: target.namespace,
      columns: targetColumns,
    },
    cardinality,
    declaration: "declared",
    confidence: confidence(0.99, "A SQL FOREIGN KEY or REFERENCES clause explicitly declares this relationship."),
    provenance: provenance(file, start, end),
    onDelete: actionValue(trailingClause, "DELETE"),
    onUpdate: actionValue(trailingClause, "UPDATE"),
  };
}

function stripConstraintPrefix(text: string): {
  name?: string;
  rest: string;
  restOffset: number;
} {
  const match = text.match(
    /^\s*CONSTRAINT\s+(["`\[]?[A-Za-z_$][\w$-]*["`\]]?)\s+/i,
  );
  if (!match) return { rest: text, restOffset: 0 };
  return {
    name: normalizeIdentifier(match[1]),
    rest: text.slice(match[0].length),
    restOffset: match[0].length,
  };
}

function relationshipCardinality(
  columns: readonly string[],
  table: SchemaTable,
): SchemaRelationship["cardinality"] {
  if (
    sameStringSet(columns, table.primaryKey) ||
    table.uniqueKeys.some((key) => sameStringSet(columns, key))
  ) {
    return "one-to-one";
  }
  return "many-to-one";
}

function firstConstraintIndex(rest: string): number {
  const expression =
    /\b(?:NOT\s+NULL|NULL|PRIMARY\s+KEY|UNIQUE|REFERENCES|DEFAULT|CHECK|GENERATED|COLLATE|CONSTRAINT|AUTO_INCREMENT|AUTOINCREMENT)\b/gi;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest[index];
    if (quote) {
      if (character === quote && rest[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    if (depth !== 0) continue;
    expression.lastIndex = index;
    const match = expression.exec(rest);
    if (match?.index === index) return index;
  }
  return -1;
}

function readQualifiedIdentifier(
  content: string,
  offset: number,
): QualifiedIdentifier | undefined {
  const first = readIdentifierToken(content, skipWhitespace(content, offset));
  if (!first) return undefined;
  let cursor = skipWhitespace(content, first.end);
  if (content[cursor] !== ".") return { name: first.value, end: first.end };
  cursor = skipWhitespace(content, cursor + 1);
  const second = readIdentifierToken(content, cursor);
  if (!second) return { name: first.value, end: first.end };
  return { namespace: first.value, name: second.value, end: second.end };
}

function readIdentifierToken(
  content: string,
  offset: number,
): { value: string; start: number; end: number } | undefined {
  const start = skipWhitespace(content, offset);
  const opener = content[start];
  const closer = opener === "[" ? "]" : opener;
  if (opener === '"' || opener === "`" || opener === "[") {
    let cursor = start + 1;
    while (cursor < content.length && content[cursor] !== closer) cursor += 1;
    if (cursor >= content.length) return undefined;
    return {
      value: content.slice(start + 1, cursor).replaceAll(`${closer}${closer}`, closer),
      start,
      end: cursor + 1,
    };
  }
  const match = content.slice(start).match(/^[A-Za-z_$][\w$-]*/);
  if (!match) return undefined;
  return { value: match[0], start, end: start + match[0].length };
}

function parseQualifiedIdentifierText(
  input: string,
): QualifiedIdentifier | undefined {
  return readQualifiedIdentifier(input, 0);
}

function parseIdentifierList(input: string): string[] {
  return input
    .split(",")
    .map((value) => normalizeIdentifier(value.trim()))
    .filter(Boolean);
}

function parenthesizedIdentifiers(input: string): string[] {
  const open = input.indexOf("(");
  if (open < 0) return [];
  const close = findMatchingParenthesis(input, open);
  return close < 0 ? [] : parseIdentifierList(input.slice(open + 1, close));
}

function normalizeIdentifier(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitSqlList(
  content: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let segmentStart = start;
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < end; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === quote && content[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) {
      ranges.push({ start: segmentStart, end: index });
      segmentStart = index + 1;
    }
  }
  ranges.push({ start: segmentStart, end });
  return ranges;
}

function findMatchingParenthesis(content: string, open: number): number {
  let depth = 0;
  let quote = "";
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (content[index + 1] === quote) index += 1;
        else if (content[index - 1] !== "\\") quote = "";
      }
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findStatementEnd(content: string, start: number): number {
  let quote = "";
  let depth = 0;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (quote) {
      if (character === quote && content[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth = Math.max(0, depth - 1);
    else if (character === ";" && depth === 0) return index + 1;
  }
  const lineEnd = content.indexOf("\n", start);
  return lineEnd < 0 ? content.length : lineEnd;
}

function maskSqlComments(content: string): string {
  const output = [...content];
  let quote = "";
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    const next = content[index + 1];
    if (quote) {
      if (character === quote && content[index - 1] !== "\\") quote = "";
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "-" && next === "-") {
      while (index < content.length && content[index] !== "\n") {
        output[index] = " ";
        index += 1;
      }
      continue;
    }
    if (character === "/" && next === "*") {
      output[index] = " ";
      output[index + 1] = " ";
      index += 2;
      while (index < content.length) {
        if (content[index] === "*" && content[index + 1] === "/") {
          output[index] = " ";
          output[index + 1] = " ";
          index += 1;
          break;
        }
        if (content[index] !== "\n") output[index] = " ";
        index += 1;
      }
    }
  }
  return output.join("");
}

function actionValue(clause: string, action: "DELETE" | "UPDATE"): string | undefined {
  return clause
    .match(new RegExp(`\\bON\\s+${action}\\s+(CASCADE|RESTRICT|NO\\s+ACTION|SET\\s+NULL|SET\\s+DEFAULT)`, "i"))?.[1]
    ?.toUpperCase()
    .replace(/\s+/g, " ");
}

function trimRange(
  content: string,
  start: number,
  end: number,
): { start: number; end: number } {
  while (start < end && /\s/.test(content[start])) start += 1;
  while (end > start && /\s/.test(content[end - 1])) end -= 1;
  return { start, end };
}

function skipWhitespace(content: string, offset: number): number {
  while (offset < content.length && /\s/.test(content[offset])) offset += 1;
  return offset;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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
  return (
    left.length > 0 &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

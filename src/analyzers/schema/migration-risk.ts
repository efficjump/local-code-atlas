import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeRelativePath } from "../../core/path-utils";
import type {
  AnalysisFile,
  SourcePoint,
  SourceProvenance,
} from "../types";

export type MigrationRiskCategory =
  | "create-table"
  | "add-column"
  | "add-index"
  | "add-constraint"
  | "drop-table"
  | "drop-column"
  | "drop-constraint"
  | "set-not-null"
  | "type-change"
  | "rename"
  | "cascade-change"
  | "data-change"
  | "truncate";

export type MigrationRiskSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info";

export interface MigrationRiskTarget {
  namespace?: string;
  table: string;
  column?: string;
  nextName?: string;
}

export interface MigrationRisk {
  id: string;
  label: string;
  semanticKey: string;
  category: MigrationRiskCategory;
  operation: string;
  target: MigrationRiskTarget;
  namespace?: string;
  table: string;
  qualifiedTable: string;
  column?: string;
  nextName?: string;
  severity: MigrationRiskSeverity;
  destructive: boolean;
  safe: boolean;
  confidence: number;
  explanation: string;
  remediation: string;
  details: Record<string, string | boolean | number | string[] | undefined>;
  provenance: SourceProvenance;
}

export interface MigrationRiskAnalysisResult {
  risks: MigrationRisk[];
  diagnostics: string[];
  partial: boolean;
  summary: {
    files: number;
    statements: number;
    operations: number;
    unsupportedStatements: number;
    byCategory: Partial<Record<MigrationRiskCategory, number>>;
    bySeverity: Record<MigrationRiskSeverity, number>;
  };
}

export interface MigrationStatement {
  path: string;
  source: string;
  text: string;
  startOffset: number;
  endOffset: number;
}

export interface MigrationRiskDraft {
  category: MigrationRiskCategory;
  target: MigrationRiskTarget;
  severity: MigrationRiskSeverity;
  destructive: boolean;
  safe: boolean;
  confidence: number;
  explanation: string;
  remediation: string;
  details?: MigrationRisk["details"];
}

export interface MigrationRiskRule {
  id: string;
  evaluate(statement: MigrationStatement): readonly MigrationRiskDraft[] | undefined;
}

export interface MigrationRiskAnalyzerOptions {
  signal?: AbortSignal;
  includeDefaultRules?: boolean;
  rules?: readonly MigrationRiskRule[];
  maxStatementsPerFile?: number;
  maxStatementCharacters?: number;
}

const SQL_IDENTIFIER =
  String.raw`(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:[^"]|"")*"|\x60(?:[^\x60]|\x60\x60)*\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*))*`;

function normalizedPath(filePath: string): string {
  const normalized = normalizeRelativePath(filePath);
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return path.posix.basename(filePath.replaceAll("\\", "/")) || "migration.sql";
  }
  return normalized;
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1).replaceAll("``", "`");
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).replaceAll("]]", "]");
  }
  return trimmed;
}

function splitQualifiedIdentifier(value: string): {
  namespace?: string;
  table: string;
} {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "`" | "]" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote) {
        const next = value[index + 1];
        if ((quote === '"' || quote === "`") && next === quote) {
          current += next;
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      current += character;
      continue;
    }
    if (character === ".") {
      segments.push(unquoteIdentifier(current));
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(unquoteIdentifier(current));
  const table = segments.pop()?.trim() || "unknown_table";
  const namespace = segments.map((segment) => segment.trim()).filter(Boolean).join(".");
  return { table, ...(namespace ? { namespace } : {}) };
}

function qualifiedTable(target: MigrationRiskTarget): string {
  return target.namespace ? `${target.namespace}.${target.table}` : target.table;
}

function operationTarget(target: MigrationRiskTarget): string {
  return `${qualifiedTable(target)}${target.column ? `.${target.column}` : ""}`;
}

function draft(
  category: MigrationRiskCategory,
  target: MigrationRiskTarget,
  values: Omit<
    MigrationRiskDraft,
    "category" | "target" | "explanation" | "remediation"
  > & { explanation: string; remediation: string },
): MigrationRiskDraft {
  return { category, target, ...values };
}

function tableTarget(rawTable: string): MigrationRiskTarget {
  return splitQualifiedIdentifier(rawTable);
}

function withColumn(
  target: MigrationRiskTarget,
  rawColumn: string,
): MigrationRiskTarget {
  return { ...target, column: unquoteIdentifier(rawColumn) };
}

function splitTopLevel(value: string, delimiter = ","): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      current += character;
      if (character === quote) {
        if (value[index + 1] === quote && quote !== "]") {
          current += value[index + 1];
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      current += character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth = Math.max(0, depth - 1);
    if (character === delimiter && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function normalizeType(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function columnTypeFrom(action: string): string | undefined {
  const match = action.match(
    new RegExp(
      `^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${SQL_IDENTIFIER}\\s+(.+)$`,
      "isu",
    ),
  );
  if (!match?.[1]) return undefined;
  const type = match[1].split(
    /\s+(?=NOT\s+NULL\b|NULL\b|DEFAULT\b|PRIMARY\s+KEY\b|UNIQUE\b|REFERENCES\b|CHECK\b|CONSTRAINT\b|COLLATE\b|GENERATED\b)/iu,
    1,
  )[0];
  return type ? normalizeType(type) : undefined;
}

function indexColumnsFrom(value: string): string[] {
  return splitTopLevel(value)
    .map((part) => part.match(new RegExp(`^(${SQL_IDENTIFIER})`, "iu"))?.[1])
    .filter((column): column is string => Boolean(column))
    .map((column) => unquoteIdentifier(column));
}

const createTableRule: MigrationRiskRule = {
  id: "create-table",
  evaluate(statement) {
    const match = statement.text.match(
      new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})\\b`, "iu"),
    );
    if (!match?.[1]) return undefined;
    const target = tableTarget(match[1]);
    return [
      draft("create-table", target, {
        severity: "info",
        destructive: false,
        safe: true,
        confidence: 0.99,
        explanation: `Creates the ${qualifiedTable(target)} table without removing existing schema objects.`,
        remediation: "Verify naming, ownership, and rollback behavior before applying the migration.",
      }),
    ];
  },
};

const dropTableRule: MigrationRiskRule = {
  id: "drop-table",
  evaluate(statement) {
    const match = statement.text.match(
      new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})([\\s\\S]*)$`, "iu"),
    );
    if (!match?.[1]) return undefined;
    const target = tableTarget(match[1]);
    const cascade = /\bCASCADE\b/iu.test(match[2] ?? "");
    return [
      draft("drop-table", target, {
        severity: "critical",
        destructive: true,
        safe: false,
        confidence: 0.99,
        explanation: `Drops ${qualifiedTable(target)} and can permanently remove its data${cascade ? " and dependent objects" : ""}.`,
        remediation: "Confirm data retention, dependent objects, backups, rollback, and a staged deployment plan before execution.",
        details: { cascade },
      }),
    ];
  },
};

const createIndexRule: MigrationRiskRule = {
  id: "create-index",
  evaluate(statement) {
    const match = statement.text.match(
      new RegExp(
        `^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?${SQL_IDENTIFIER}\\s+ON\\s+(${SQL_IDENTIFIER})\\b`,
        "iu",
      ),
    );
    if (!match?.[2]) return undefined;
    const target = tableTarget(match[2]);
    const concurrently = /\bCONCURRENTLY\b/iu.test(statement.text);
    return [
      draft("add-index", target, {
        severity: concurrently ? "info" : "low",
        destructive: false,
        safe: concurrently,
        confidence: 0.98,
        explanation: `Adds an index to ${qualifiedTable(target)}${concurrently ? " using a concurrent build" : ", which may hold a write-blocking lock on a populated table"}.`,
        remediation: concurrently
          ? "Verify the database supports concurrent index creation and account for its transaction restrictions."
          : "Estimate build time and locking on production-sized data; use an online or concurrent strategy when supported.",
        details: { concurrently, unique: Boolean(match[1]) },
      }),
    ];
  },
};

function alterActionDrafts(
  table: MigrationRiskTarget,
  action: string,
): MigrationRiskDraft[] | undefined {
  const addIndex = action.match(
    new RegExp(
      String.raw`^ADD\s+(?:(UNIQUE|FULLTEXT|SPATIAL)\s+)?(INDEX|KEY)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(${SQL_IDENTIFIER})\s*)?\(([\s\S]+)\)(?:\s+[\s\S]*)?$`,
      "iu",
    ),
  );
  if (addIndex?.[2] && addIndex[4]) {
    const modifier = addIndex[1]?.toLocaleLowerCase();
    const syntax = addIndex[2].toLocaleLowerCase();
    const index = addIndex[3] ? unquoteIdentifier(addIndex[3]) : "unnamed";
    const columns = indexColumnsFrom(addIndex[4]);
    return [
      draft("add-index", table, {
        severity: "low",
        destructive: false,
        safe: false,
        confidence: 0.98,
        explanation: `Adds index ${index} to ${qualifiedTable(table)}; building it may hold locks or consume substantial resources on a populated table.`,
        remediation: "Estimate build time and lock behavior on production-sized data, and use an online index strategy when supported.",
        details: {
          index,
          indexKind: modifier ? `${modifier}-${syntax}` : syntax,
          unique: modifier === "unique",
          columns,
        },
      }),
    ];
  }

  const dropIndex = action.match(
    new RegExp(
      String.raw`^DROP\s+(INDEX|KEY)\s+(?:IF\s+EXISTS\s+)?(${SQL_IDENTIFIER})(?:\s+[\s\S]*)?$`,
      "iu",
    ),
  );
  if (dropIndex?.[1] && dropIndex[2]) {
    const constraint = unquoteIdentifier(dropIndex[2]);
    return [
      draft("drop-constraint", table, {
        severity: "medium",
        destructive: false,
        safe: false,
        confidence: 0.98,
        explanation: `Removes index ${constraint} from ${qualifiedTable(table)}, which may weaken uniqueness guarantees or degrade query performance.`,
        remediation: "Confirm the index is not enforcing a required invariant and compare production query plans before removal.",
        details: {
          constraint,
          constraintKind: "index",
          syntax: dropIndex[1].toLocaleLowerCase(),
          action: "drop",
        },
      }),
    ];
  }

  const dropForeignKey = action.match(
    new RegExp(
      String.raw`^DROP\s+FOREIGN\s+KEY\s+(?:IF\s+EXISTS\s+)?(${SQL_IDENTIFIER})(?:\s+[\s\S]*)?$`,
      "iu",
    ),
  );
  if (dropForeignKey?.[1]) {
    const constraint = unquoteIdentifier(dropForeignKey[1]);
    return [
      draft("drop-constraint", table, {
        severity: "medium",
        destructive: false,
        safe: false,
        confidence: 0.99,
        explanation: `Removes foreign key ${constraint} from ${qualifiedTable(table)}, weakening referential integrity enforced by the database.`,
        remediation: "Confirm the relationship is no longer required and deploy compensating validation before removing the foreign key.",
        details: {
          constraint,
          constraintKind: "foreign-key",
          action: "drop",
        },
      }),
    ];
  }

  const addColumn = action.match(
    new RegExp(
      `^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})(?:\\s+[\\s\\S]+)?$`,
      "iu",
    ),
  );
  if (
    addColumn?.[1] &&
    !/^ADD\s+(?:(?:UNIQUE|FULLTEXT|SPATIAL)\s+)?(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|KEY)\b/iu.test(
      action,
    )
  ) {
    const target = withColumn(table, addColumn[1]);
    const notNull = /\bNOT\s+NULL\b/iu.test(action);
    const hasDefault = /\bDEFAULT\b/iu.test(action);
    const newType = columnTypeFrom(action);
    const safe = !notNull || hasDefault;
    return [
      draft("add-column", target, {
        severity: safe ? "low" : "high",
        destructive: false,
        safe,
        confidence: 0.97,
        explanation: safe
          ? `Adds ${operationTarget(target)} without requiring every existing row to provide a new value.`
          : `Adds required column ${operationTarget(target)} without an explicit default; populated tables may reject the migration or require a table rewrite.`,
        remediation: safe
          ? "Verify application compatibility and the rollback path before deployment."
          : "Use an expand-and-contract rollout: add a nullable column, backfill in bounded batches, then enforce the constraint.",
        details: { notNull, hasDefault, ...(newType ? { newType } : {}) },
      }),
    ];
  }

  const dropColumn = action.match(
    new RegExp(`^DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})([\\s\\S]*)$`, "iu"),
  );
  if (
    dropColumn?.[1] &&
    !/^DROP\s+(?:CONSTRAINT|INDEX|KEY|FOREIGN|PRIMARY|CHECK)\b/iu.test(action)
  ) {
    const target = withColumn(table, dropColumn[1]);
    const cascade = /\bCASCADE\b/iu.test(dropColumn[2] ?? "");
    return [
      draft("drop-column", target, {
        severity: cascade ? "critical" : "high",
        destructive: true,
        safe: false,
        confidence: 0.99,
        explanation: `Drops ${operationTarget(target)} and can permanently remove stored data${cascade ? " together with dependent objects" : ""}.`,
        remediation: "Remove application reads and writes first, preserve required data, and validate dependencies and rollback before dropping the column.",
        details: { cascade },
      }),
    ];
  }

  const setNotNull = action.match(
    new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${SQL_IDENTIFIER})\\s+SET\\s+NOT\\s+NULL\\b`, "iu"),
  );
  if (setNotNull?.[1]) {
    const target = withColumn(table, setNotNull[1]);
    return [
      draft("set-not-null", target, {
        severity: "high",
        destructive: false,
        safe: false,
        confidence: 0.99,
        explanation: `Makes ${operationTarget(target)} required; existing null rows can fail the migration and older application versions may still write null values.`,
        remediation: "Backfill and validate null rows first, then deploy compatible writers before enforcing the constraint.",
        details: { nullable: false },
      }),
    ];
  }

  const typeChange = action.match(
    new RegExp(
      `^ALTER\\s+(?:COLUMN\\s+)?(${SQL_IDENTIFIER})\\s+(?:SET\\s+DATA\\s+TYPE|TYPE)\\s+([\\s\\S]+)$`,
      "iu",
    ),
  );
  if (typeChange?.[1] && typeChange[2]) {
    const target = withColumn(table, typeChange[1]);
    const newType = normalizeType(typeChange[2].split(/\s+USING\s+/iu, 1)[0] ?? typeChange[2]);
    const hasUsing = /\bUSING\b/iu.test(typeChange[2]);
    return [
      draft("type-change", target, {
        severity: "high",
        destructive: false,
        safe: false,
        confidence: 0.96,
        explanation: `Changes the storage type of ${operationTarget(target)} to ${newType}; compatibility and possible data loss cannot be proven statically.`,
        remediation: "Test the conversion against production-shaped data, check index and lock behavior, and prepare a reversible expand-and-contract migration.",
        details: { newType, hasUsing },
      }),
    ];
  }

  const renameColumn = action.match(
    new RegExp(`^RENAME\\s+(?:COLUMN\\s+)?(${SQL_IDENTIFIER})\\s+TO\\s+(${SQL_IDENTIFIER})\\s*$`, "iu"),
  );
  if (renameColumn?.[1] && renameColumn[2]) {
    const nextName = unquoteIdentifier(renameColumn[2]);
    const target = {
      ...withColumn(table, renameColumn[1]),
      nextName,
    };
    return [
      draft("rename", target, {
        severity: "medium",
        destructive: false,
        safe: false,
        confidence: 0.99,
        explanation: `Renames ${operationTarget(target)} to ${nextName}; independently deployed code may reference either name during rollout.`,
        remediation: "Use an expand-and-contract transition or a compatibility view, and deploy readers and writers in a coordinated order.",
        details: { nextName, objectKind: "column" },
      }),
    ];
  }

  const renameTable = action.match(
    new RegExp(`^RENAME\\s+TO\\s+(${SQL_IDENTIFIER})\\s*$`, "iu"),
  );
  if (renameTable?.[1]) {
    const nextName = unquoteIdentifier(renameTable[1]);
    const target = { ...table, nextName };
    return [
      draft("rename", target, {
        severity: "medium",
        destructive: false,
        safe: false,
        confidence: 0.99,
        explanation: `Renames ${qualifiedTable(target)} to ${nextName}; older application versions may continue to use the previous table name.`,
        remediation: "Coordinate deployments or provide a compatibility layer until every reader and writer uses the new name.",
        details: { nextName, objectKind: "table" },
      }),
    ];
  }

  const dropConstraint = action.match(
    new RegExp(`^DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?(${SQL_IDENTIFIER})([\\s\\S]*)$`, "iu"),
  );
  if (dropConstraint?.[1]) {
    const constraint = unquoteIdentifier(dropConstraint[1]);
    const cascade = /\bCASCADE\b/iu.test(dropConstraint[2] ?? "");
    return [
      draft(cascade ? "cascade-change" : "drop-constraint", table, {
        severity: cascade ? "high" : "medium",
        destructive: cascade,
        safe: false,
        confidence: 0.96,
        explanation: `Removes constraint ${constraint} from ${qualifiedTable(table)}${cascade ? " with cascading dependency removal" : ""}, weakening a database-enforced invariant.`,
        remediation: "Confirm the invariant is no longer required, audit dependent objects, and deploy compensating validation before removal.",
        details: { constraint, cascade, action: "drop" },
      }),
    ];
  }

  if (/^ADD\s+(?:CONSTRAINT\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|UNIQUE\b|CHECK\b)/iu.test(action)) {
    const constraintMatch = action.match(
      new RegExp(`^ADD\\s+CONSTRAINT\\s+(${SQL_IDENTIFIER})`, "iu"),
    );
    const constraint = constraintMatch?.[1]
      ? unquoteIdentifier(constraintMatch[1])
      : "unnamed";
    const cascadeActions = [
      ...action.matchAll(/\bON\s+(DELETE|UPDATE)\s+CASCADE\b/giu),
    ].map((match) => match[1]?.toLocaleLowerCase()).filter((value): value is string => Boolean(value));
    const cascade = cascadeActions.length > 0;
    return [
      draft(cascade ? "cascade-change" : "add-constraint", table, {
        severity: cascade ? "high" : "medium",
        destructive: cascade,
        safe: false,
        confidence: 0.95,
        explanation: cascade
          ? `Introduces cascading ${cascadeActions.join(" and ")} behavior on ${qualifiedTable(table)}, allowing a parent mutation to affect related rows.`
          : `Adds a database constraint to ${qualifiedTable(table)}; existing rows and deployment-time locks may prevent it from being applied safely.`,
        remediation: cascade
          ? "Verify every cascade path, retention requirement, and application delete/update flow with production-shaped data."
          : "Validate existing data first and use the database's online or deferred validation mechanism when available.",
        details: { constraint, cascadeActions, action: "add" },
      }),
    ];
  }
  return undefined;
}

const alterTableRule: MigrationRiskRule = {
  id: "alter-table",
  evaluate(statement) {
    const match = statement.text.match(
      new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(${SQL_IDENTIFIER})\\s+([\\s\\S]+)$`, "iu"),
    );
    if (!match?.[1] || !match[2]) return undefined;
    const table = tableTarget(match[1]);
    const actions = splitTopLevel(match[2]);
    const observations: MigrationRiskDraft[] = [];
    for (const action of actions) {
      const matched = alterActionDrafts(table, action);
      if (!matched) return undefined;
      observations.push(...matched);
    }
    return observations.length > 0 ? observations : undefined;
  },
};

const dataChangeRule: MigrationRiskRule = {
  id: "data-change",
  evaluate(statement) {
    const truncate = statement.text.match(
      new RegExp(`^TRUNCATE(?:\\s+TABLE)?\\s+(${SQL_IDENTIFIER})\\b`, "iu"),
    );
    if (truncate?.[1]) {
      const target = tableTarget(truncate[1]);
      return [
        draft("truncate", target, {
          severity: "critical",
          destructive: true,
          safe: false,
          confidence: 0.99,
          explanation: `Truncates ${qualifiedTable(target)} and removes its rows without a row-by-row rollback path.`,
          remediation: "Require an explicit data-retention decision, backup, dependency review, and tested restore procedure.",
        }),
      ];
    }
    const mutation = statement.text.match(
      new RegExp(`^(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(${SQL_IDENTIFIER})\\b`, "iu"),
    );
    if (!mutation?.[1] || !mutation[2]) return undefined;
    const target = tableTarget(mutation[2]);
    const action = mutation[1].replace(/\s+/gu, " ").toLocaleLowerCase();
    const destructive = action.startsWith("delete");
    return [
      draft("data-change", target, {
        severity: destructive ? "high" : "medium",
        destructive,
        safe: false,
        confidence: 0.9,
        explanation: `Runs a ${action} data migration against ${qualifiedTable(target)}; affected row count, runtime, and reversibility depend on live data.`,
        remediation: "Estimate affected rows, batch large mutations, make the operation restartable, and define verification and rollback queries.",
        details: { action },
      }),
    ];
  },
};

export const DEFAULT_MIGRATION_RISK_RULES: readonly MigrationRiskRule[] = [
  dropTableRule,
  createTableRule,
  createIndexRule,
  alterTableRule,
  dataChangeRule,
];

function stripSqlComments(source: string): string {
  let result = "";
  let state: "normal" | "single" | "double" | "backtick" | "line" | "block" =
    "normal";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (character === "\n") {
        state = "normal";
        result += "\n";
      } else {
        result += " ";
      }
      continue;
    }
    if (state === "block") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "normal";
      } else {
        result += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "normal") {
      if (character === "-" && next === "-") {
        result += "  ";
        index += 1;
        state = "line";
        continue;
      }
      if (character === "/" && next === "*") {
        result += "  ";
        index += 1;
        state = "block";
        continue;
      }
      if (character === "'") state = "single";
      if (character === '"') state = "double";
      if (character === "`") state = "backtick";
      result += character;
      continue;
    }
    result += character;
    const quote = state === "single" ? "'" : state === "double" ? '"' : "`";
    if (character === quote) {
      if (next === quote) {
        result += next;
        index += 1;
      } else {
        state = "normal";
      }
    }
  }
  return result;
}

function splitStatements(file: AnalysisFile): MigrationStatement[] {
  const source = stripSqlComments(file.content);
  const statements: MigrationStatement[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | undefined;
  let dollarTag: string | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (dollarTag) {
      if (source.startsWith(dollarTag, index)) {
        index += dollarTag.length - 1;
        dollarTag = undefined;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "$") {
      const tag = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u)?.[0];
      if (tag) {
        dollarTag = tag;
        index += tag.length - 1;
        continue;
      }
    }
    if (character !== ";") continue;
    pushStatement(file, source, start, index, statements);
    start = index + 1;
  }
  pushStatement(file, source, start, source.length, statements);
  return statements;
}

function pushStatement(
  file: AnalysisFile,
  source: string,
  rawStart: number,
  rawEnd: number,
  statements: MigrationStatement[],
): void {
  const segment = source.slice(rawStart, rawEnd);
  const leading = segment.search(/\S/u);
  if (leading < 0) return;
  const text = segment.slice(leading).trimEnd();
  statements.push({
    path: normalizedPath(file.path),
    source: file.content,
    text,
    startOffset: rawStart + leading,
    endOffset: rawStart + leading + text.length,
  });
}

function sourcePoint(source: string, offset: number): SourcePoint {
  const bounded = Math.max(0, Math.min(offset, source.length));
  const before = source.slice(0, bounded);
  const lastLineBreak = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: bounded - lastLineBreak,
    offset: bounded,
  };
}

function canonicalDetails(details: MigrationRisk["details"]): string {
  return Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, value]) =>
      `${key}=${Array.isArray(value) ? [...value].sort().join(",") : String(value)}`,
    )
    .join("|");
}

export function migrationRiskLabel(risk: Pick<MigrationRisk, "category" | "target">): string {
  return `${risk.category}:${operationTarget(risk.target)}`;
}

export function migrationRiskSemanticKey(
  risk: Pick<MigrationRisk, "category" | "target" | "details">,
): string {
  return [
    risk.category,
    risk.target.namespace ?? "",
    risk.target.table,
    risk.target.column ?? "",
    risk.target.nextName ?? "",
    canonicalDetails(risk.details),
  ].join("\u0000");
}

function operationSummary(draftRisk: MigrationRiskDraft): string {
  const target = operationTarget(draftRisk.target);
  const suffix = draftRisk.target.nextName ? ` -> ${draftRisk.target.nextName}` : "";
  return `${draftRisk.category.replaceAll("-", " ")} ${target}${suffix}`;
}

function unsupportedStatement(text: string): boolean {
  return /^(?:ALTER|CREATE|DROP|RENAME|TRUNCATE|DO|CALL|EXEC(?:UTE)?|MERGE|GRANT|REVOKE)\b/iu.test(
    text,
  );
}

function ignoredControlStatement(text: string): boolean {
  return /^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|USE|PRAGMA|DELIMITER)\b/iu.test(
    text,
  );
}

export function supportsMigrationRiskFile(file: Pick<AnalysisFile, "path">): boolean {
  return /\.sql$/iu.test(file.path);
}

export function analyzeMigrationRisks(
  files: readonly AnalysisFile[],
  options: MigrationRiskAnalyzerOptions = {},
): MigrationRiskAnalysisResult {
  const rules = [
    ...(options.includeDefaultRules === false ? [] : DEFAULT_MIGRATION_RISK_RULES),
    ...(options.rules ?? []),
  ];
  const maxStatements = Math.max(1, options.maxStatementsPerFile ?? 2_000);
  const maxStatementCharacters = Math.max(
    1_000,
    options.maxStatementCharacters ?? 250_000,
  );
  const diagnostics: string[] = [];
  const risks: MigrationRisk[] = [];
  const duplicateOrdinals = new Map<string, number>();
  let statementCount = 0;
  let unsupportedStatements = 0;
  const sqlFiles = files.filter(supportsMigrationRiskFile);

  for (const file of sqlFiles) {
    options.signal?.throwIfAborted();
    const statements = splitStatements(file);
    if (statements.length > maxStatements) {
      diagnostics.push(
        `${normalizedPath(file.path)}: migration analysis stopped at the ${maxStatements.toLocaleString("en-US")}-statement safety limit.`,
      );
    }
    for (const statement of statements.slice(0, maxStatements)) {
      options.signal?.throwIfAborted();
      statementCount += 1;
      const line = sourcePoint(statement.source, statement.startOffset).line;
      if (statement.text.length > maxStatementCharacters) {
        unsupportedStatements += 1;
        diagnostics.push(
          `${statement.path}:${line}: migration statement exceeded the analysis size limit and requires manual review.`,
        );
        continue;
      }
      let matched: readonly MigrationRiskDraft[] | undefined;
      for (const rule of rules) {
        const evaluated = rule.evaluate(statement);
        if (evaluated && evaluated.length > 0) {
          matched = evaluated;
          break;
        }
      }
      if (!matched) {
        if (unsupportedStatement(statement.text) || !ignoredControlStatement(statement.text)) {
          unsupportedStatements += 1;
          diagnostics.push(
            `${statement.path}:${line}: unsupported migration statement requires manual review.`,
          );
        }
        continue;
      }
      const provenance: SourceProvenance = {
        path: statement.path,
        range: {
          start: sourcePoint(statement.source, statement.startOffset),
          end: sourcePoint(statement.source, statement.endOffset),
        },
      };
      for (const observation of matched) {
        const details = observation.details ?? {};
        const base = {
          category: observation.category,
          target: observation.target,
          details,
        };
        const semanticKey = migrationRiskSemanticKey(base);
        const duplicateKey = `${statement.path}\u0000${semanticKey}`;
        const ordinal = (duplicateOrdinals.get(duplicateKey) ?? 0) + 1;
        duplicateOrdinals.set(duplicateKey, ordinal);
        const id = `migration-${createHash("sha256")
          .update(`${duplicateKey}\u0000${ordinal}`)
          .digest("hex")
          .slice(0, 16)}`;
        const table = qualifiedTable(observation.target);
        risks.push({
          id,
          label: migrationRiskLabel(base),
          semanticKey,
          category: observation.category,
          operation: operationSummary(observation),
          target: observation.target,
          namespace: observation.target.namespace,
          table: observation.target.table,
          qualifiedTable: table,
          column: observation.target.column,
          nextName: observation.target.nextName,
          severity: observation.severity,
          destructive: observation.destructive,
          safe: observation.safe,
          confidence: observation.confidence,
          explanation: observation.explanation,
          remediation: observation.remediation,
          details,
          provenance,
        });
      }
    }
  }

  risks.sort(
    (left, right) =>
      left.provenance.path.localeCompare(right.provenance.path, "en") ||
      left.provenance.range.start.line - right.provenance.range.start.line ||
      left.semanticKey.localeCompare(right.semanticKey, "en") ||
      left.id.localeCompare(right.id, "en"),
  );
  const byCategory: MigrationRiskAnalysisResult["summary"]["byCategory"] = {};
  const bySeverity: MigrationRiskAnalysisResult["summary"]["bySeverity"] = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const risk of risks) {
    byCategory[risk.category] = (byCategory[risk.category] ?? 0) + 1;
    bySeverity[risk.severity] += 1;
  }
  return {
    risks,
    diagnostics,
    partial:
      unsupportedStatements > 0 ||
      files.some(
        (file) =>
          supportsMigrationRiskFile(file) && splitStatements(file).length > maxStatements,
      ),
    summary: {
      files: sqlFiles.length,
      statements: statementCount,
      operations: risks.length,
      unsupportedStatements,
      byCategory,
      bySeverity,
    },
  };
}

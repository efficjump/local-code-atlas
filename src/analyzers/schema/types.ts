import type {
  AnalyzerExecution,
  Confidence,
  SourceProvenance,
} from "../types";

export type SchemaSourceKind = "sql" | "prisma" | "typeorm" | "jpa" | "sqlalchemy" | "django" | "mixed";
export type DeclarationKind = "declared" | "inferred";

export interface SchemaColumn {
  name: string;
  logicalName?: string;
  dataType: string;
  nullable: boolean;
  primaryKey: boolean;
  unique: boolean;
  generated?: boolean;
  declaration: DeclarationKind;
  confidence: Confidence;
  provenance: SourceProvenance;
}
export interface SchemaTable {
  id: string;
  name: string;
  logicalName?: string;
  namespace?: string;
  sourceKind: SchemaSourceKind;
  declaration: DeclarationKind;
  confidence: Confidence;
  provenance: SourceProvenance[];
  columns: SchemaColumn[];
  primaryKey: string[];
  uniqueKeys: string[][];
}

export interface RelationshipEndpoint {
  table: string;
  namespace?: string;
  columns: string[];
}

export type RelationshipCardinality =
  | "one-to-one"
  | "one-to-many"
  | "many-to-one"
  | "many-to-many"
  | "unknown";

export interface SchemaRelationship {
  id: string;
  name?: string;
  from: RelationshipEndpoint;
  to: RelationshipEndpoint;
  cardinality: RelationshipCardinality;
  declaration: DeclarationKind;
  confidence: Confidence;
  provenance: SourceProvenance;
  onDelete?: string;
  onUpdate?: string;
}

export interface SchemaTableObservation {
  kind: "table";
  table: SchemaTable;
}

export interface SchemaRelationshipObservation {
  kind: "relationship";
  relationship: SchemaRelationship;
}

export type SchemaObservation =
  | SchemaTableObservation
  | SchemaRelationshipObservation;

export interface SchemaAnalysisResult {
  tables: SchemaTable[];
  relationships: SchemaRelationship[];
  executions: AnalyzerExecution[];
  summary: {
    scannedFileCount: number;
    tableCount: number;
    columnCount: number;
    declaredRelationshipCount: number;
    inferredRelationshipCount: number;
  };
}

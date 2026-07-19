import type {
  AnalyzerExecution,
  Confidence,
  SourceProvenance,
} from "../types";
import type { SourceScope } from "../../core/types";

export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

export type SecurityCategory =
  | "exposed-secret"
  | "injection"
  | "unsafe-execution"
  | "cryptography"
  | "transport-security"
  | "access-control"
  | "unsafe-deserialization"
  | "configuration"
  | "supply-chain";

export interface SecurityEvidence {
  provenance: SourceProvenance;
  /** A generated explanation. Source text is intentionally not included. */
  summary: string;
  /** Present only for secrets and never contains any characters from the value. */
  redactedValue?: string;
}

export interface SecurityFinding {
  kind: "finding";
  id: string;
  analyzerId: string;
  ruleId: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  title: string;
  description: string;
  confidence: Confidence;
  evidence: SecurityEvidence;
  remediation: string;
  cwe?: string;
  sourceScope?: SourceScope;
}

export type DependencyEcosystem =
  | "npm"
  | "python"
  | "maven"
  | "gradle"
  | "cargo"
  | "go";

export type DependencyPinning =
  | "exact"
  | "range"
  | "floating"
  | "source"
  | "managed"
  | "unknown";

export interface DependencyInventoryItem {
  kind: "dependency";
  id: string;
  analyzerId: string;
  ecosystem: DependencyEcosystem;
  name: string;
  versionSpec: string;
  scope: string;
  pinning: DependencyPinning;
  direct: boolean;
  provenance: SourceProvenance;
  sourceScope?: SourceScope;
}

export type SecurityObservation = SecurityFinding | DependencyInventoryItem;

export interface SecurityAnalysisResult {
  findings: SecurityFinding[];
  dependencies: DependencyInventoryItem[];
  executions: AnalyzerExecution[];
  summary: {
    scannedFileCount: number;
    inputFileCount?: number;
    excludedFileCount?: number;
    sourceScope?: "production" | "all" | "custom";
    scannedFileCountByScope?: Partial<Record<SourceScope, number>>;
    findingCountBySeverity: Record<SecuritySeverity, number>;
    dependencyCountByEcosystem: Partial<Record<DependencyEcosystem, number>>;
  };
}

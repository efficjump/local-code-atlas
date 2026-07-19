/**
 * Serializable domain types shared by the local analysis pipeline.
 *
 * The core intentionally returns relative project paths and short, redacted
 * excerpts. Absolute paths are kept only on ScannedFile for internal I/O and
 * can be removed at an API boundary with `toPublicScanResult`.
 */

export type Confidence = "high" | "medium" | "low";

export type SourceScope =
  | "production"
  | "test"
  | "example"
  | "fixture"
  | "documentation"
  | "generated"
  | "vendor";

export interface SourceScopeRule {
  id: string;
  scope: SourceScope;
  pathSegments?: readonly string[];
  pathPatterns?: readonly RegExp[];
  fileNamePatterns?: readonly RegExp[];
  kinds?: readonly FileKind[];
}

export type FileKind =
  | "source"
  | "test"
  | "schema"
  | "migration"
  | "manifest"
  | "configuration"
  | "documentation"
  | "asset"
  | "unknown";

export interface SourceLocation {
  path: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface AnalysisEvidence {
  location: SourceLocation;
  reason: string;
  /** A bounded excerpt with likely credentials and secret values redacted. */
  excerpt?: string;
}

export interface ScanWarning {
  code:
    | "permission-denied"
    | "read-failed"
    | "outside-root"
    | "limit-reached"
    | "symlink-cycle"
    | "invalid-ignore-pattern";
  path?: string;
  message: string;
}

export interface ScannedFile {
  path: string;
  /** Internal-only absolute path used by the filesystem analysis stages. */
  absolutePath: string;
  extension: string;
  sizeBytes: number;
  modifiedAtMs: number;
  lineCount?: number;
  language?: string;
  kind: FileKind;
  /** Repository role inferred from configurable, generic path conventions. */
  sourceScope?: SourceScope;
  isBinary: boolean;
}

export interface ScanStats {
  visitedDirectories: number;
  visitedFiles: number;
  ignoredEntries: number;
  binaryFiles: number;
  totalBytes: number;
}

export interface ScanResult {
  root: string;
  files: ScannedFile[];
  warnings: ScanWarning[];
  truncated: boolean;
  stats: ScanStats;
}

export type PublicScannedFile = Omit<ScannedFile, "absolutePath">;

export interface PublicScanResult extends Omit<ScanResult, "files" | "root"> {
  files: PublicScannedFile[];
}

export interface LanguageDefinition {
  id: string;
  name: string;
  extensions: readonly string[];
  fileNames?: readonly string[];
  shebangPatterns?: readonly RegExp[];
}

export interface LanguageStat {
  id: string;
  name: string;
  fileCount: number;
  lineCount: number;
  bytes: number;
  percentage: number;
}

export interface DetectionEvidence {
  kind: "dependency" | "file" | "content" | "language";
  path?: string;
  sourceScope?: SourceScope;
  detail: string;
}

export interface FrameworkDetection {
  id: string;
  name: string;
  category:
    | "web"
    | "ui"
    | "api"
    | "orm"
    | "database"
    | "test"
    | "build"
    | "mobile"
    | "other";
  confidence: Confidence;
  evidence: DetectionEvidence[];
}

export interface FrameworkRule {
  id: string;
  name: string;
  category: FrameworkDetection["category"];
  dependencyNames?: readonly string[];
  fileNames?: readonly string[];
  fileExtensions?: readonly string[];
  /** Bounded manifest/config contents are tested; matching text is never returned. */
  contentPatterns?: readonly RegExp[];
}

export interface ManifestSummary {
  path: string;
  ecosystem: string;
  dependencyNames: string[];
  sourceScope?: SourceScope;
}

export interface ProjectDiscovery {
  root: string;
  name: string;
  languages: LanguageStat[];
  frameworks: FrameworkDetection[];
  manifests: ManifestSummary[];
  packageManagers: string[];
  buildSystems: string[];
  databases: string[];
}

export type GitChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "unknown";

export interface GitChangedFile {
  path: string;
  previousPath?: string;
  status: GitChangeStatus;
  staged: boolean;
  unstaged: boolean;
  additions?: number;
  deletions?: number;
}

export interface GitMetadata {
  isRepository: boolean;
  root?: string;
  branch?: string;
  head?: string;
  upstream?: string;
  detached: boolean;
  dirty: boolean;
  changedFiles: GitChangedFile[];
}

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "module"
  | "table"
  | "view"
  | "unknown";

export interface FileNode {
  id: string;
  type: "file";
  path: string;
  language?: string;
  kind: FileKind;
}

export interface SymbolNode {
  id: string;
  type: "symbol";
  name: string;
  symbolKind: SymbolKind;
  exported: boolean;
  location: SourceLocation;
  fileId: string;
}

export interface ExternalModuleNode {
  id: string;
  type: "external-module";
  name: string;
}

export type CodeGraphNode = FileNode | SymbolNode | ExternalModuleNode;

export type CodeGraphEdgeKind =
  | "contains"
  | "imports"
  | "references"
  | "calls";

export interface CodeGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: CodeGraphEdgeKind;
  evidence?: SourceLocation;
}

export interface CodeGraph {
  nodes: CodeGraphNode[];
  edges: CodeGraphEdge[];
  warnings: ScanWarning[];
}

export interface ImpactCandidate {
  path: string;
  score: number;
  confidence: Confidence;
  reasons: string[];
  evidence: AnalysisEvidence[];
  matchedSymbols: string[];
  graphDistance: number;
  changed: boolean;
}

export interface SuggestedTest {
  kind: "existing" | "new";
  path?: string;
  title: string;
  reason: string;
  relatedPaths: string[];
  score: number;
}

export interface ImpactAnalysis {
  question: string;
  queryTerms: string[];
  candidates: ImpactCandidate[];
  suggestedTests: SuggestedTest[];
  limitations: string[];
}

export interface LocalProjectAnalysis {
  scan: ScanResult;
  discovery: ProjectDiscovery;
  git: GitMetadata;
  graph: CodeGraph;
  impact?: ImpactAnalysis;
}

export type PublicProjectDiscovery = Omit<ProjectDiscovery, "root">;
export type PublicGitMetadata = Omit<GitMetadata, "root">;

/** Safe shape for browser/API responses; host filesystem roots are omitted. */
export interface PublicLocalProjectAnalysis {
  scan: PublicScanResult;
  discovery: PublicProjectDiscovery;
  git: PublicGitMetadata;
  graph: CodeGraph;
  impact?: ImpactAnalysis;
}

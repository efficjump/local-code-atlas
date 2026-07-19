import path from "node:path";
import { discoverProject, type DiscoveryOptions } from "./discovery";
import { getGitMetadata, type ChangedFilesOptions } from "./git";
import { extractCodeGraph, type GraphOptions } from "./graph";
import { rankChangeImpact, type ImpactRankingInput } from "./impact";
import { normalizeRelativePath } from "./path-utils";
import { scanProject, toPublicScanResult, type ScanOptions } from "./scanner";
import type {
  GitChangedFile,
  GitMetadata,
  LocalProjectAnalysis,
  PublicLocalProjectAnalysis,
} from "./types";

export interface LocalProjectAnalysisOptions {
  signal?: AbortSignal;
  scan?: ScanOptions;
  discovery?: DiscoveryOptions;
  git?: ChangedFilesOptions;
  /** Optional trusted metadata for archives, examples, or editor snapshots without their own Git worktree. */
  gitMetadataOverride?: GitMetadata;
  graph?: GraphOptions;
  question?: string;
  impact?: Omit<
    ImpactRankingInput,
    "question" | "scan" | "graph" | "changedFiles"
  >;
}

function rebaseChange(
  change: GitChangedFile,
  prefix: string,
): GitChangedFile | undefined {
  if (!prefix) return change;
  if (change.path !== prefix && !change.path.startsWith(`${prefix}/`)) return undefined;
  const strip = (value: string): string | undefined => {
    if (value !== prefix && !value.startsWith(`${prefix}/`)) return undefined;
    return value === prefix
      ? ""
      : normalizeRelativePath(value.slice(prefix.length).replace(/^\//u, ""));
  };
  const rebasedPath = strip(change.path);
  if (!rebasedPath) return undefined;
  const previousPath = change.previousPath ? strip(change.previousPath) : undefined;
  return {
    ...change,
    path: rebasedPath,
    previousPath: previousPath || undefined,
  };
}

/** Align repository-relative Git paths with the analyzed project root. */
export function rebaseGitMetadata(
  metadata: GitMetadata,
  projectRoot: string,
): GitMetadata {
  if (!metadata.root) return metadata;
  const rawPrefix = path.relative(metadata.root, projectRoot);
  if (rawPrefix.startsWith("..") || path.isAbsolute(rawPrefix)) return metadata;
  const prefix = normalizeRelativePath(rawPrefix);
  const changedFiles = metadata.changedFiles
    .map((change) => rebaseChange(change, prefix))
    .filter((change): change is GitChangedFile => Boolean(change));
  return {
    ...metadata,
    dirty: changedFiles.some(
      (file) => file.staged || file.unstaged || file.status === "untracked",
    ),
    changedFiles,
  };
}

/**
 * Run the complete deterministic local pipeline. Semantic query expansion can
 * be injected through `impact.semanticTerms`; the core never requires a remote
 * model and never returns unredacted source contents.
 */
export async function analyzeLocalProject(
  projectRoot: string,
  options: LocalProjectAnalysisOptions = {},
): Promise<LocalProjectAnalysis> {
  options.signal?.throwIfAborted();
  const scanOptions = {
    ...options.scan,
    signal: options.scan?.signal ?? options.signal,
  };
  const gitOptions = {
    ...options.git,
    signal: options.git?.signal ?? options.signal,
  };
  const [scan, rawGit] = await Promise.all([
    scanProject(projectRoot, scanOptions),
    options.gitMetadataOverride
      ? Promise.resolve(options.gitMetadataOverride)
      : getGitMetadata(projectRoot, gitOptions).catch((error): GitMetadata => {
          // An explicitly requested comparison must fail visibly; silently falling
          // back to a structure-only scan would make an invalid base look clean.
          if (gitOptions.base) throw error;
          return {
            isRepository: false,
            detached: false,
            dirty: false,
            changedFiles: [],
          };
        }),
  ]);
  const git = rebaseGitMetadata(rawGit, scan.root);
  options.signal?.throwIfAborted();
  const [discovery, graph] = await Promise.all([
    discoverProject(scan, {
      ...options.discovery,
      signal: options.discovery?.signal ?? options.signal,
    }),
    extractCodeGraph(scan, {
      ...options.graph,
      signal: options.graph?.signal ?? options.signal,
    }),
  ]);
  const question = options.question?.trim();
  const impact = question
    ? await rankChangeImpact({
        ...options.impact,
        question,
        scan,
        graph,
        changedFiles: git.changedFiles,
        signal: options.impact?.signal ?? options.signal,
      })
    : undefined;
  return { scan, discovery, git, graph, impact };
}

export function toPublicLocalProjectAnalysis(
  analysis: LocalProjectAnalysis,
): PublicLocalProjectAnalysis {
  const { root: _discoveryRoot, ...discovery } = analysis.discovery;
  const { root: _gitRoot, ...git } = analysis.git;
  void _discoveryRoot;
  void _gitRoot;
  return {
    scan: toPublicScanResult(analysis.scan),
    discovery,
    git,
    graph: analysis.graph,
    impact: analysis.impact,
  };
}

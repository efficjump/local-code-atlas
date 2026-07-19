import { promises as fs } from "node:fs";
import path from "node:path";
import { comparePaths, splitIdentifier, stableUnique } from "./path-utils";
import { redactSensitiveText } from "./redaction";
import type {
  AnalysisEvidence,
  CodeGraph,
  CodeGraphEdge,
  CodeGraphNode,
  GitChangedFile,
  ImpactAnalysis,
  ImpactCandidate,
  ScanResult,
  SourceLocation,
  SuggestedTest,
  SymbolNode,
} from "./types";

export interface ImpactRankingInput {
  signal?: AbortSignal;
  question: string;
  scan: ScanResult;
  graph: CodeGraph;
  changedFiles?: readonly GitChangedFile[];
  /** Semantic/code terms supplied by an LLM, embedding search, or the user. */
  semanticTerms?: readonly string[];
  includeChangedFilesAsSeeds?: boolean;
  maxCandidates?: number;
  maxEvidencePerCandidate?: number;
  maxSuggestedTests?: number;
  propagationDepth?: number;
  minimumScore?: number;
}

interface MutableCandidate {
  path: string;
  rawScore: number;
  reasons: Set<string>;
  evidence: AnalysisEvidence[];
  matchedSymbols: Set<string>;
  graphDistance: number;
  changed: boolean;
}

interface FileRelation {
  targetPath: string;
  weight: number;
  edge: CodeGraphEdge;
  description: string;
}

function nodeFilePath(
  node: CodeGraphNode | undefined,
  filePathById: ReadonlyMap<string, string>,
): string | undefined {
  if (!node) return undefined;
  if (node.type === "file") return node.path;
  if (node.type === "symbol") return filePathById.get(node.fileId);
  return undefined;
}

export function extractQueryTerms(
  question: string,
  semanticTerms: readonly string[] = [],
): string[] {
  const values = [question, ...semanticTerms]
    .flatMap(splitIdentifier)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !/^\d+$/u.test(term));
  return stableUnique(values).sort(comparePaths);
}

function scoreToPercentage(rawScore: number): number {
  return Math.round((1 - Math.exp(-Math.max(0, rawScore) / 9)) * 1_000) / 10;
}

function confidenceFor(score: number): ImpactCandidate["confidence"] {
  if (score >= 65) return "high";
  if (score >= 35) return "medium";
  return "low";
}

function ensureCandidate(
  candidates: Map<string, MutableCandidate>,
  filePath: string,
  changedPaths: ReadonlySet<string>,
): MutableCandidate {
  const current = candidates.get(filePath);
  if (current) return current;
  const candidate: MutableCandidate = {
    path: filePath,
    rawScore: 0,
    reasons: new Set<string>(),
    evidence: [],
    matchedSymbols: new Set<string>(),
    graphDistance: Number.POSITIVE_INFINITY,
    changed: changedPaths.has(filePath),
  };
  candidates.set(filePath, candidate);
  return candidate;
}

function addEvidence(candidate: MutableCandidate, evidence: AnalysisEvidence): void {
  const duplicate = candidate.evidence.some(
    (item) =>
      item.location.path === evidence.location.path &&
      item.location.line === evidence.location.line &&
      item.reason === evidence.reason,
  );
  if (!duplicate) candidate.evidence.push(evidence);
}

function createFileRelations(graph: CodeGraph): Map<string, FileRelation[]> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const filePathById = new Map(
    graph.nodes
      .filter((node): node is Extract<CodeGraphNode, { type: "file" }> => node.type === "file")
      .map((node) => [node.id, node.path]),
  );
  const relations = new Map<string, FileRelation[]>();
  const add = (sourcePath: string, relation: FileRelation) => {
    if (sourcePath === relation.targetPath) return;
    const list = relations.get(sourcePath) ?? [];
    if (!list.some((item) => item.targetPath === relation.targetPath && item.edge.kind === relation.edge.kind)) {
      list.push(relation);
      relations.set(sourcePath, list);
    }
  };

  for (const edge of graph.edges) {
    if (edge.kind === "contains") continue;
    const sourcePath = nodeFilePath(nodes.get(edge.source), filePathById);
    const targetPath = nodeFilePath(nodes.get(edge.target), filePathById);
    if (!sourcePath || !targetPath || sourcePath === targetPath) continue;
    const forwardWeight = edge.kind === "calls" ? 0.62 : edge.kind === "references" ? 0.52 : 0.46;
    const reverseWeight = edge.kind === "calls" ? 0.86 : edge.kind === "references" ? 0.8 : 0.76;
    add(sourcePath, {
      targetPath,
      weight: forwardWeight,
      edge,
      description: `${sourcePath} depends on this file through a ${edge.kind} relationship.`,
    });
    add(targetPath, {
      targetPath: sourcePath,
      weight: reverseWeight,
      edge,
      description: `${sourcePath} may be affected because it ${edge.kind} this file.`,
    });
  }
  for (const list of relations.values()) {
    list.sort((a, b) => comparePaths(a.targetPath, b.targetPath) || comparePaths(a.edge.kind, b.edge.kind));
  }
  return relations;
}

async function hydrateEvidenceExcerpts(
  evidence: readonly AnalysisEvidence[],
  scan: ScanResult,
  signal?: AbortSignal,
): Promise<AnalysisEvidence[]> {
  const fileByPath = new Map(scan.files.map((file) => [file.path, file]));
  const linesByPath = new Map<string, string[]>();
  const result: AnalysisEvidence[] = [];
  for (const item of evidence) {
    signal?.throwIfAborted();
    const file = fileByPath.get(item.location.path);
    if (!file || file.isBinary || file.sizeBytes > 1024 * 1024) {
      result.push(item);
      continue;
    }
    let lines = linesByPath.get(file.path);
    if (!lines) {
      try {
        lines = (await fs.readFile(file.absolutePath, "utf8")).split(/\r?\n/u);
        linesByPath.set(file.path, lines);
      } catch {
        result.push(item);
        continue;
      }
    }
    const line = lines[item.location.line - 1];
    result.push(
      line === undefined
        ? item
        : { ...item, excerpt: redactSensitiveText(line, { maxLength: 240 }) },
    );
  }
  return result;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const intersection = [...left].filter((value) => right.has(value)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function suggestTests(
  candidates: readonly ImpactCandidate[],
  scan: ScanResult,
  graph: CodeGraph,
  maxSuggestions: number,
): SuggestedTest[] {
  const tests = scan.files.filter((file) => file.kind === "test");
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const directRelations = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") continue;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const sourcePath = source?.type === "file" ? source.path : undefined;
    const targetPath = target?.type === "file"
      ? target.path
      : target?.type === "symbol"
        ? (nodeById.get(target.fileId) as Extract<CodeGraphNode, { type: "file" }> | undefined)?.path
        : undefined;
    if (sourcePath && targetPath) directRelations.add(`${sourcePath}\0${targetPath}`);
  }

  const suggestions: SuggestedTest[] = [];
  const usedTests = new Set<string>();
  for (const candidate of candidates.filter((item) => scan.files.find((file) => file.path === item.path)?.kind !== "test").slice(0, 8)) {
    const candidateTerms = new Set(splitIdentifier(candidate.path));
    const rankedTests = tests
      .map((test) => {
        const similarity = jaccard(candidateTerms, new Set(splitIdentifier(test.path)));
        const related =
          directRelations.has(`${test.path}\0${candidate.path}`) ||
          directRelations.has(`${candidate.path}\0${test.path}`);
        return { test, score: similarity * 55 + (related ? 45 : 0) };
      })
      .filter(({ score }) => score >= 12)
      .sort((a, b) => b.score - a.score || comparePaths(a.test.path, b.test.path));
    const existing = rankedTests.find(({ test }) => !usedTests.has(test.path));
    if (existing) {
      usedTests.add(existing.test.path);
      suggestions.push({
        kind: "existing",
        path: existing.test.path,
        title: `Extend ${path.basename(existing.test.path)}`,
        reason: `This test is structurally or lexically related to ${candidate.path}.`,
        relatedPaths: [candidate.path],
        score: Math.round(Math.min(100, existing.score) * 10) / 10,
      });
    } else {
      const subject = candidate.matchedSymbols[0] ?? path.basename(candidate.path, path.extname(candidate.path));
      suggestions.push({
        kind: "new",
        title: `Add regression coverage for ${subject}`,
        reason: `No existing test was strongly connected to ${candidate.path}; add coverage using the project's established test conventions.`,
        relatedPaths: [candidate.path],
        score: Math.round(candidate.score * 10) / 10,
      });
    }
    if (suggestions.length >= maxSuggestions) break;
  }
  return suggestions.sort((a, b) => b.score - a.score || comparePaths(a.path ?? a.title, b.path ?? b.title));
}

export async function rankChangeImpact(input: ImpactRankingInput): Promise<ImpactAnalysis> {
  input.signal?.throwIfAborted();
  const maxCandidates = Math.max(1, input.maxCandidates ?? 20);
  const maxEvidence = Math.max(1, input.maxEvidencePerCandidate ?? 4);
  const propagationDepth = Math.max(0, Math.min(5, input.propagationDepth ?? 2));
  const minimumScore = Math.max(0, input.minimumScore ?? 8);
  const changedPaths = new Set((input.changedFiles ?? []).map((file) => file.path));
  const safeQuestion = redactSensitiveText(input.question, { maxLength: 2_000 });
  const safeSemanticTerms = (input.semanticTerms ?? []).map((term) =>
    redactSensitiveText(term, { maxLength: 200 }),
  );
  const terms = extractQueryTerms(safeQuestion, safeSemanticTerms).filter(
    (term) => term !== "redacted",
  );
  const nodes = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const symbolsByFile = new Map<string, SymbolNode[]>();
  for (const node of input.graph.nodes) {
    if (node.type !== "symbol") continue;
    const file = nodes.get(node.fileId);
    if (file?.type !== "file") continue;
    symbolsByFile.set(file.path, [...(symbolsByFile.get(file.path) ?? []), node]);
  }

  const searchableTerms = new Map<string, Set<string>>();
  for (const file of input.scan.files) {
    input.signal?.throwIfAborted();
    searchableTerms.set(
      file.path,
      new Set([
        ...splitIdentifier(file.path),
        ...(symbolsByFile.get(file.path) ?? []).flatMap((symbol) => splitIdentifier(symbol.name)),
      ]),
    );
  }
  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    documentFrequency.set(
      term,
      [...searchableTerms.values()].filter((document) => document.has(term)).length,
    );
  }

  const candidates = new Map<string, MutableCandidate>();
  const sourceSeeds = new Map<string, number>();
  for (const file of input.scan.files) {
    const document = searchableTerms.get(file.path) ?? new Set<string>();
    const candidate = ensureCandidate(candidates, file.path, changedPaths);
    const pathTerms = new Set(splitIdentifier(file.path));
    for (const term of terms) {
      const frequency = documentFrequency.get(term) ?? 0;
      const idf = Math.log((input.scan.files.length + 1) / (frequency + 1)) + 1;
      if (pathTerms.has(term)) {
        candidate.rawScore += 2.8 * idf;
        candidate.reasons.add(`The path matches the query term "${term}".`);
        candidate.graphDistance = 0;
        addEvidence(candidate, {
          location: { path: file.path, line: 1 },
          reason: `Path match for "${term}".`,
        });
      } else if (term.length >= 3 && [...pathTerms].some((part) => part.includes(term) || term.includes(part))) {
        candidate.rawScore += 1.1 * idf;
        candidate.reasons.add(`The path partially matches "${term}".`);
        candidate.graphDistance = 0;
      }
      if (!document.has(term)) continue;
      for (const symbol of symbolsByFile.get(file.path) ?? []) {
        const symbolTerms = splitIdentifier(symbol.name);
        if (!symbolTerms.includes(term) && symbol.name.toLocaleLowerCase() !== term) continue;
        candidate.rawScore += 4.5 * idf;
        candidate.matchedSymbols.add(symbol.name);
        candidate.reasons.add(`Symbol "${symbol.name}" matches the query.`);
        candidate.graphDistance = 0;
        addEvidence(candidate, {
          location: symbol.location,
          reason: `Matching ${symbol.symbolKind} "${symbol.name}".`,
        });
      }
    }
    if (candidate.rawScore > 0) sourceSeeds.set(file.path, candidate.rawScore);
  }

  if (input.includeChangedFilesAsSeeds !== false) {
    for (const change of input.changedFiles ?? []) {
      const file = input.scan.files.find((item) => item.path === change.path);
      if (!file) continue;
      const candidate = ensureCandidate(candidates, file.path, changedPaths);
      candidate.rawScore += 3;
      candidate.graphDistance = 0;
      candidate.reasons.add(`The file is ${change.status} in the current Git comparison.`);
      addEvidence(candidate, {
        location: { path: file.path, line: 1 },
        reason: `Git reports this file as ${change.status}.`,
      });
      sourceSeeds.set(file.path, candidate.rawScore);
    }
  }

  const relations = createFileRelations(input.graph);
  for (const [seedPath, seedScore] of [...sourceSeeds.entries()].sort(([a], [b]) => comparePaths(a, b))) {
    input.signal?.throwIfAborted();
    const queue: { path: string; depth: number; factor: number }[] = [{ path: seedPath, depth: 0, factor: 1 }];
    const bestFactor = new Map<string, number>([[seedPath, 1]]);
    while (queue.length) {
      const current = queue.shift();
      if (!current || current.depth >= propagationDepth) continue;
      for (const relation of relations.get(current.path) ?? []) {
        const factor = current.factor * relation.weight;
        if (factor <= (bestFactor.get(relation.targetPath) ?? 0)) continue;
        bestFactor.set(relation.targetPath, factor);
        const depth = current.depth + 1;
        const candidate = ensureCandidate(candidates, relation.targetPath, changedPaths);
        candidate.rawScore += seedScore * factor * 0.72;
        candidate.graphDistance = Math.min(candidate.graphDistance, depth);
        candidate.reasons.add(relation.description);
        const evidenceLocation: SourceLocation = relation.edge.evidence ?? {
          path: relation.targetPath,
          line: 1,
        };
        addEvidence(candidate, {
          location: evidenceLocation,
          reason: `Graph ${relation.edge.kind} relationship at distance ${depth}.`,
        });
        queue.push({ path: relation.targetPath, depth, factor });
      }
    }
  }

  const ranked = [...candidates.values()]
    .map((candidate) => {
      const score = scoreToPercentage(candidate.rawScore);
      return {
        candidate,
        score,
      };
    })
    .filter(({ score }) => score >= minimumScore)
    .sort((a, b) => b.score - a.score || comparePaths(a.candidate.path, b.candidate.path))
    .slice(0, maxCandidates);

  const output: ImpactCandidate[] = [];
  for (const { candidate, score } of ranked) {
    input.signal?.throwIfAborted();
    const selectedEvidence = candidate.evidence.slice(0, maxEvidence);
    output.push({
      path: candidate.path,
      score,
      confidence: confidenceFor(score),
      reasons: [...candidate.reasons].sort(comparePaths).slice(0, 8),
      evidence: await hydrateEvidenceExcerpts(selectedEvidence, input.scan, input.signal),
      matchedSymbols: [...candidate.matchedSymbols].sort(comparePaths),
      graphDistance: Number.isFinite(candidate.graphDistance) ? candidate.graphDistance : 0,
      changed: candidate.changed,
    });
  }

  const limitations = [
    "Static import and symbol relationships are best-effort and may not include runtime reflection or dynamically constructed module paths.",
  ];
  if (!input.semanticTerms?.length) {
    limitations.push("Ranking is lexical unless semanticTerms are supplied by a model or embedding search.");
  }
  if (input.scan.truncated) {
    limitations.push("The project scan reached a configured limit, so the result covers only the indexed files.");
  }
  if (output.length === 0) {
    limitations.push("No indexed file met the configured relevance threshold for this question.");
  }

  return {
    question: safeQuestion,
    queryTerms: terms,
    candidates: output,
    suggestedTests: suggestTests(
      output,
      input.scan,
      input.graph,
      Math.max(1, input.maxSuggestedTests ?? 5),
    ),
    limitations,
  };
}

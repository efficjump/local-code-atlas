import type {
  AnalysisFile,
  AnalyzerContext,
  AnalyzerDomain,
  AnalyzerExecution,
  FileAnalyzer,
  RegistryRun,
} from "./types";

export class AnalyzerRegistry<TObservation> {
  readonly #domain: AnalyzerDomain;
  readonly #analyzers = new Map<string, FileAnalyzer<TObservation>>();

  constructor(domain: AnalyzerDomain) {
    this.#domain = domain;
  }

  register(analyzer: FileAnalyzer<TObservation>): this {
    if (analyzer.domain !== this.#domain) {
      throw new Error(
        `Analyzer ${analyzer.id} belongs to ${analyzer.domain}, expected ${this.#domain}`,
      );
    }
    if (this.#analyzers.has(analyzer.id)) {
      throw new Error(`Analyzer ${analyzer.id} is already registered`);
    }
    this.#analyzers.set(analyzer.id, analyzer);
    return this;
  }

  unregister(analyzerId: string): boolean {
    return this.#analyzers.delete(analyzerId);
  }

  list(): readonly FileAnalyzer<TObservation>[] {
    return [...this.#analyzers.values()];
  }

  async run(
    files: readonly AnalysisFile[],
    signal?: AbortSignal,
  ): Promise<RegistryRun<TObservation>> {
    const normalizedFiles = files.map(normalizeAnalysisFile);
    const context: AnalyzerContext = { files: normalizedFiles, signal };
    const observations: TObservation[] = [];
    const executions: AnalyzerExecution[] = [];

    for (const analyzer of this.#analyzers.values()) {
      throwIfAborted(signal);
      const matchedFiles = normalizedFiles.filter((file) =>
        analyzer.supports(file, context),
      );
      if (matchedFiles.length === 0) continue;

      const startedAt = performance.now();
      let observationCount = 0;
      for (const file of matchedFiles) {
        throwIfAborted(signal);
        const found = await analyzer.analyze(file, context);
        observations.push(...found);
        observationCount += found.length;
      }
      executions.push({
        analyzerId: analyzer.id,
        matchedFiles: matchedFiles.map((file) => file.path),
        observationCount,
        durationMs: Math.max(0, performance.now() - startedAt),
      });
    }

    return { observations, executions };
  }
}

function normalizeAnalysisFile(file: AnalysisFile): AnalysisFile {
  return {
    ...file,
    path: file.path.replaceAll("\\", "/"),
    // Preserve source bytes represented by the string so reported offsets remain
    // valid for the caller's original content, including CRLF files.
    content: file.content,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Analysis was aborted");
  }
}

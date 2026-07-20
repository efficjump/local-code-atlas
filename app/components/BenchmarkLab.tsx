"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import packageMetadata from "../../package.json";
import type {
  BenchmarkCaseResult,
  BenchmarkDimension,
  BenchmarkDimensionMetrics,
  BenchmarkMetric,
  BenchmarkRunResult,
} from "../../src/benchmark/types";

const DIMENSIONS: readonly BenchmarkDimension[] = [
  "impact",
  "security",
  "schema",
  "migration",
];
const DIMENSION_LABELS: Record<BenchmarkDimension, string> = {
  impact: "Impact ranking",
  security: "Security findings",
  schema: "Schema map",
  migration: "Migration risk",
};
const DEFAULT_ANALYZE_API_URL = "http://127.0.0.1:4317/api/analyze";
const ANALYZE_API_URL =
  process.env.NEXT_PUBLIC_ATLAS_API_URL || DEFAULT_ANALYZE_API_URL;
const APP_VERSION = packageMetadata.version;

type RequestStatus = "idle" | "running" | "ready" | "error";
type ApiStatus = "checking" | "online" | "offline";

export interface BenchmarkUiError {
  code: string;
  message: string;
  requestId?: string;
}

export interface BenchmarkHealth {
  service: "local-code-atlas-engine";
  status: "ok";
  version: string;
  localOnly: boolean;
  allowedRootsConfigured: boolean;
  capabilities: {
    benchmark: true;
  };
  external: {
    localByDefault: true;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}

function metricScore(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries = value.map(nonEmptyString);
  if (entries.some((entry) => entry === undefined)) return undefined;
  const strings = entries as string[];
  return new Set(strings).size === strings.length ? strings : undefined;
}

function roundedScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function sameScore(
  actual: number | null,
  expected: number | null,
): boolean {
  return actual === expected;
}

export class BenchmarkContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchmarkContractError";
  }
}

function normalizeMetric(value: unknown, path: string): BenchmarkMetric {
  if (!isRecord(value)) {
    throw new BenchmarkContractError(`${path} must be an object.`);
  }
  const expectedCount = nonNegativeInteger(value.expectedCount);
  const predictedCount = nonNegativeInteger(value.predictedCount);
  const truePositives = nonNegativeInteger(value.truePositives);
  const falsePositives = nonNegativeInteger(value.falsePositives);
  const falseNegatives = nonNegativeInteger(value.falseNegatives);
  const precision = metricScore(value.precision);
  const recall = metricScore(value.recall);
  const f1 = metricScore(value.f1);
  const truePositiveLabels = stringList(value.truePositiveLabels);
  const falsePositiveLabels = stringList(value.falsePositiveLabels);
  const falseNegativeLabels = stringList(value.falseNegativeLabels);

  if (
    expectedCount === undefined ||
    predictedCount === undefined ||
    truePositives === undefined ||
    falsePositives === undefined ||
    falseNegatives === undefined ||
    precision === undefined ||
    recall === undefined ||
    f1 === undefined ||
    !truePositiveLabels ||
    !falsePositiveLabels ||
    !falseNegativeLabels ||
    truePositives + falsePositives !== predictedCount ||
    truePositives + falseNegatives !== expectedCount ||
    truePositiveLabels.length !== truePositives ||
    falsePositiveLabels.length !== falsePositives ||
    falseNegativeLabels.length !== falseNegatives
  ) {
    throw new BenchmarkContractError(
      `${path} contains inconsistent metric counts or scores.`,
    );
  }

  const expectedPrecision =
    predictedCount === 0 ? null : roundedScore(truePositives / predictedCount);
  const expectedRecall =
    expectedCount === 0 ? null : roundedScore(truePositives / expectedCount);
  const f1Denominator = 2 * truePositives + falsePositives + falseNegatives;
  const expectedF1 =
    f1Denominator === 0
      ? null
      : roundedScore((2 * truePositives) / f1Denominator);
  if (
    !sameScore(precision, expectedPrecision) ||
    !sameScore(recall, expectedRecall) ||
    !sameScore(f1, expectedF1)
  ) {
    throw new BenchmarkContractError(
      `${path} scores do not match its confusion counts.`,
    );
  }

  return {
    expectedCount,
    predictedCount,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    truePositiveLabels,
    falsePositiveLabels,
    falseNegativeLabels,
  };
}

function normalizeDimensions(
  value: unknown,
  path: string,
): BenchmarkDimensionMetrics {
  if (!isRecord(value)) {
    throw new BenchmarkContractError(`${path} must be an object.`);
  }
  return Object.fromEntries(
    DIMENSIONS.map((dimension) => [
      dimension,
      normalizeMetric(value[dimension], `${path}.${dimension}`),
    ]),
  ) as BenchmarkDimensionMetrics;
}

function assertAggregateCounts(
  aggregate: BenchmarkMetric,
  dimensions: BenchmarkDimensionMetrics,
  path: string,
): void {
  for (const field of [
    "expectedCount",
    "predictedCount",
    "truePositives",
    "falsePositives",
    "falseNegatives",
  ] as const) {
    const dimensionTotal = DIMENSIONS.reduce(
      (total, dimension) => total + dimensions[dimension][field],
      0,
    );
    if (aggregate[field] !== dimensionTotal) {
      throw new BenchmarkContractError(
        `${path}.${field} does not match its dimension totals.`,
      );
    }
  }
}

function normalizeCase(value: unknown, index: number): BenchmarkCaseResult {
  const path = `cases[${index}]`;
  if (!isRecord(value)) {
    throw new BenchmarkContractError(`${path} must be an object.`);
  }
  const id = nonEmptyString(value.id);
  const name = nonEmptyString(value.name);
  const manifestPath = nonEmptyString(value.manifestPath);
  const fixturePath = nonEmptyString(value.fixturePath);
  const durationMs = nonNegativeNumber(value.durationMs);
  if (
    !id ||
    !name ||
    !manifestPath ||
    !fixturePath ||
    durationMs === undefined ||
    typeof value.partial !== "boolean"
  ) {
    throw new BenchmarkContractError(`${path} is missing required case metadata.`);
  }
  const normalizedDimensions = normalizeDimensions(
    value.dimensions,
    `${path}.dimensions`,
  );
  const aggregate = normalizeMetric(value.aggregate, `${path}.aggregate`);
  assertAggregateCounts(aggregate, normalizedDimensions, `${path}.aggregate`);
  return {
    id,
    name,
    ...(nonEmptyString(value.description)
      ? { description: nonEmptyString(value.description) }
      : {}),
    manifestPath,
    fixturePath,
    durationMs,
    partial: value.partial,
    dimensions: normalizedDimensions,
    aggregate,
  };
}

/** Fail closed so missing coverage or metrics cannot look like a clean benchmark. */
export function normalizeBenchmarkRun(payload: unknown): BenchmarkRunResult {
  if (!isRecord(payload) || payload.schemaVersion !== 1) {
    throw new BenchmarkContractError(
      "The analyzer returned an unrecognized benchmark contract.",
    );
  }
  const caseCount = nonNegativeInteger(payload.caseCount);
  const partialCaseCount = nonNegativeInteger(payload.partialCaseCount);
  const durationMs = nonNegativeNumber(payload.durationMs);
  if (
    caseCount === undefined ||
    partialCaseCount === undefined ||
    durationMs === undefined ||
    typeof payload.partial !== "boolean" ||
    !Array.isArray(payload.cases)
  ) {
    throw new BenchmarkContractError(
      "The benchmark response is missing run coverage metadata.",
    );
  }
  const cases = payload.cases.map(normalizeCase);
  const observedPartialCases = cases.filter((entry) => entry.partial).length;
  if (
    caseCount !== cases.length ||
    partialCaseCount !== observedPartialCases ||
    payload.partial !== (observedPartialCases > 0)
  ) {
    throw new BenchmarkContractError(
      "The benchmark response contains inconsistent case coverage.",
    );
  }
  const normalizedDimensions = normalizeDimensions(payload.dimensions, "dimensions");
  const aggregate = normalizeMetric(payload.aggregate, "aggregate");
  assertAggregateCounts(aggregate, normalizedDimensions, "aggregate");
  for (const dimension of DIMENSIONS) {
    for (const field of [
      "expectedCount",
      "predictedCount",
      "truePositives",
      "falsePositives",
      "falseNegatives",
    ] as const) {
      const caseTotal = cases.reduce(
        (total, caseResult) => total + caseResult.dimensions[dimension][field],
        0,
      );
      if (normalizedDimensions[dimension][field] !== caseTotal) {
        throw new BenchmarkContractError(
          `dimensions.${dimension}.${field} does not match its case totals.`,
        );
      }
    }
  }
  return {
    schemaVersion: 1,
    caseCount,
    durationMs,
    partial: payload.partial,
    partialCaseCount,
    cases,
    dimensions: normalizedDimensions,
    aggregate,
  };
}

export function normalizeBenchmarkHealth(payload: unknown): BenchmarkHealth {
  const root = isRecord(payload) ? payload : {};
  const capabilities = isRecord(root.capabilities) ? root.capabilities : {};
  const external = isRecord(root.external) ? root.external : {};
  if (
    root.service !== "local-code-atlas-engine" ||
    root.status !== "ok" ||
    !nonEmptyString(root.version) ||
    typeof root.localOnly !== "boolean" ||
    typeof root.allowedRootsConfigured !== "boolean" ||
    capabilities.benchmark !== true ||
    external.localByDefault !== true
  ) {
    throw new BenchmarkContractError(
      "The configured endpoint does not advertise a trusted local benchmark capability.",
    );
  }
  return {
    service: "local-code-atlas-engine",
    status: "ok",
    version: nonEmptyString(root.version) as string,
    localOnly: root.localOnly,
    allowedRootsConfigured: root.allowedRootsConfigured,
    capabilities: { benchmark: true },
    external: { localByDefault: true },
  };
}

export function benchmarkUrlFor(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    url.pathname = "/api/benchmark";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return apiUrl.replace(/\/api\/analyze\/?$/u, "/api/benchmark");
  }
}

export function benchmarkHealthUrlFor(apiUrl: string): string {
  try {
    const url = new URL(apiUrl);
    url.pathname = "/api/health";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return apiUrl.replace(/\/api\/(?:analyze|benchmark)\/?$/u, "/api/health");
  }
}

const BENCHMARK_URL = benchmarkUrlFor(ANALYZE_API_URL);
const HEALTH_URL = benchmarkHealthUrlFor(ANALYZE_API_URL);

function apiError(payload: unknown, status: number): BenchmarkUiError {
  const root = isRecord(payload) ? payload : {};
  const error = isRecord(root.error) ? root.error : {};
  return {
    code: nonEmptyString(error.code) ?? `HTTP_${status}`,
    message:
      nonEmptyString(error.message) ??
      `The local analyzer returned HTTP ${status}.`,
    requestId: nonEmptyString(error.requestId),
  };
}

function formatScore(value: number | null): string {
  return value === null
    ? "N/A"
    : new Intl.NumberFormat("en-US", {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);
}

function formatDuration(value: number): string {
  return value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(2)} s`;
}

function differenceCount(metric: BenchmarkMetric): number {
  return metric.falsePositives + metric.falseNegatives;
}

function caseState(result: BenchmarkCaseResult): string {
  if (result.partial) return "Partial";
  return differenceCount(result.aggregate) === 0 ? "Exact match" : "Review";
}

export function BenchmarkLab() {
  const [status, setStatus] = useState<RequestStatus>("idle");
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");
  const [health, setHealth] = useState<BenchmarkHealth | null>(null);
  const [result, setResult] = useState<BenchmarkRunResult | null>(null);
  const [error, setError] = useState<BenchmarkUiError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const checkHealth = useCallback(async (signal?: AbortSignal) => {
    setApiStatus("checking");
    try {
      const response = await fetch(HEALTH_URL, { signal });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(`Health check returned HTTP ${response.status}.`);
      const normalized = normalizeBenchmarkHealth(payload);
      if (!signal?.aborted) {
        setHealth(normalized);
        setApiStatus("online");
      }
      return normalized;
    } catch (caught) {
      if (!signal?.aborted) {
        setHealth(null);
        setApiStatus("offline");
      }
      throw caught;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(HEALTH_URL, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Health check returned HTTP ${response.status}.`);
        }
        return normalizeBenchmarkHealth(await response.json());
      })
      .then((normalized) => {
        if (!controller.signal.aborted) {
          setHealth(normalized);
          setApiStatus("online");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setHealth(null);
          setApiStatus("offline");
        }
      });
    return () => controller.abort();
  }, []);

  const totalDifferences = result ? differenceCount(result.aggregate) : 0;
  const domainRows = useMemo(
    () =>
      result
        ? DIMENSIONS.map((dimension) => ({
            dimension,
            metric: result.dimensions[dimension],
          }))
        : [],
    [result],
  );

  async function runBenchmark() {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setStatus("running");
    setError(null);
    setNotice(null);
    let reachedApi = false;
    try {
      await checkHealth(controller.signal);
      if (controller.signal.aborted) return;
      const response = await fetch(BENCHMARK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suite: "bundled" }),
        signal: controller.signal,
      });
      reachedApi = true;
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) throw apiError(payload, response.status);
      setResult(normalizeBenchmarkRun(payload));
      setStatus("ready");
      setApiStatus("online");
    } catch (caught) {
      if (controller.signal.aborted) return;
      const detail = isRecord(caught) && nonEmptyString(caught.message)
        ? {
            code: nonEmptyString(caught.code) ?? "BENCHMARK_FAILED",
            message: nonEmptyString(caught.message) as string,
            requestId: nonEmptyString(caught.requestId),
          }
        : {
            code: reachedApi ? "BENCHMARK_FAILED" : "ANALYZER_UNAVAILABLE",
            message: reachedApi
              ? "The benchmark response could not be verified."
              : "The local analyzer did not present the required benchmark capability.",
          };
      setError(detail);
      setStatus("error");
      if (!reachedApi) setApiStatus("offline");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function cancelBenchmark() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStatus(result ? "ready" : "idle");
    setNotice("Benchmark cancelled. No project or fixture files were changed.");
  }

  return (
    <main
      className="atlas-app benchmark-app"
      data-atlas-workbench-version={APP_VERSION}
      data-atlas-api-url={ANALYZE_API_URL}
      data-atlas-benchmark-url={BENCHMARK_URL}
    >
      <header className="atlas-header">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- vinext local navigation must not load a second React renderer. */}
        <a className="atlas-brand" href="/" aria-label="Local Code Atlas workbench">
          <span className="atlas-brand-mark" aria-hidden="true">CA</span>
          <span>
            <strong>LOCAL CODE ATLAS</strong>
            <small>BENCHMARK LAB</small>
          </span>
        </a>
        <div className="atlas-header-meta">
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- vinext local navigation must not load a second React renderer. */}
          <a className="atlas-header-link" href="/">Workbench</a>
          <span className="atlas-privacy-chip">Bundled suite only</span>
          <button
            type="button"
            className={`atlas-api-status atlas-api-status--${apiStatus}`}
            onClick={() => void checkHealth().catch(() => undefined)}
            disabled={apiStatus === "checking"}
            title="Check the local benchmark engine"
          >
            <span className="atlas-status-dot" aria-hidden="true" />
            {apiStatus === "online"
              ? "Analyzer connected"
              : apiStatus === "offline"
                ? "Analyzer offline"
                : "Checking analyzer"}
          </button>
        </div>
      </header>

      <div className="benchmark-shell">
        <section className="benchmark-hero" aria-labelledby="benchmark-title">
          <div className="atlas-eyebrow">
            <span>LOCAL-FIRST</span>
            <span>MEASURE · COMPARE · INSPECT</span>
          </div>
          <h1 id="benchmark-title">Measure what the analyzer actually finds.</h1>
          <p>
            Run deterministic fixture projects against checked-in expectations.
            Precision, recall, and F1 remain attached to every unexpected or missed label.
          </p>
        </section>

        <section className="benchmark-run-card" aria-labelledby="benchmark-run-title">
          <div>
            <span className="atlas-section-label">BUNDLED REGRESSION SUITE</span>
            <h2 id="benchmark-run-title">Run locally, without external checks</h2>
            <p>
              The server selects the bundled catalog. Browser requests cannot provide a
              filesystem path, and benchmark cases force advisory and model requests off.
            </p>
          </div>
          <ul aria-label="Benchmark trust boundaries">
            <li><b>Fixtures</b><span>Read-only, bundled projects</span></li>
            <li><b>Network</b><span>OSV and model synthesis disabled</span></li>
            <li><b>Scoring</b><span>Zero denominators remain N/A</span></li>
          </ul>
          <div className="benchmark-actions">
            {status === "running" ? (
              <button type="button" className="atlas-button atlas-button--secondary" onClick={cancelBenchmark}>
                Cancel benchmark
              </button>
            ) : (
              <button type="button" className="atlas-button atlas-button--primary" onClick={() => void runBenchmark()}>
                Run bundled suite <span aria-hidden="true">↗</span>
              </button>
            )}
            <span>{health?.localOnly === false ? "Warning: engine is network-exposed" : "Local engine identity checked before each run"}</span>
          </div>
        </section>

        <section className="benchmark-status" aria-live="polite" aria-atomic="true">
          {status === "running" && (
            <div className="benchmark-message" role="status">
              <strong>Running benchmark cases sequentially</strong>
              <span>Analyzing fixtures and comparing normalized labels…</span>
            </div>
          )}
          {status === "error" && error && (
            <div className="benchmark-message benchmark-message--error" role="alert">
              <strong>{error.code}</strong>
              <span>{error.message}</span>
              {error.requestId && <code>Request {error.requestId}</code>}
            </div>
          )}
          {notice && <div className="benchmark-message"><span>{notice}</span></div>}
        </section>

        {result && (
          <section className="benchmark-results" aria-labelledby="benchmark-results-title">
            <div className="benchmark-results-heading">
              <div>
                <span className="atlas-section-label">LATEST LOCAL RUN</span>
                <h2 id="benchmark-results-title">Benchmark results</h2>
              </div>
              <span className="benchmark-result-state" data-state={result.partial ? "partial" : totalDifferences ? "review" : "match"}>
                {result.partial
                  ? "PARTIAL COVERAGE"
                  : totalDifferences
                    ? `${totalDifferences} DIFFERENCE${totalDifferences === 1 ? "" : "S"}`
                    : "EXACT MATCH"}
              </span>
            </div>

            {result.partial && (
              <div className="benchmark-partial-warning" role="status">
                <strong>This run is partial.</strong>
                <span>
                  {result.partialCaseCount} case{result.partialCaseCount === 1 ? "" : "s"} reported incomplete analyzer coverage. Do not treat absent labels as a clean result.
                </span>
              </div>
            )}

            <div className="benchmark-summary" aria-label="Benchmark run summary">
              <article><span>CASES</span><strong>{result.caseCount}</strong><small>{result.partialCaseCount} partial</small></article>
              <article><span>MICRO F1</span><strong>{formatScore(result.aggregate.f1)}</strong><small>{result.aggregate.truePositives} true positives</small></article>
              <article><span>DURATION</span><strong>{formatDuration(result.durationMs)}</strong><small>Sequential local run</small></article>
            </div>

            <div className="benchmark-table-shell">
              <table>
                <caption>Accuracy by analyzer dimension</caption>
                <thead>
                  <tr>
                    <th scope="col">Dimension</th>
                    <th scope="col">Precision</th>
                    <th scope="col">Recall</th>
                    <th scope="col">F1</th>
                    <th scope="col">Expected</th>
                    <th scope="col">Observed</th>
                    <th scope="col">FP</th>
                    <th scope="col">FN</th>
                  </tr>
                </thead>
                <tbody>
                  {domainRows.map(({ dimension, metric }) => (
                    <tr key={dimension}>
                      <th scope="row">
                        <span>{DIMENSION_LABELS[dimension]}</span>
                        {metric.f1 !== null && (
                          <meter min="0" max="1" value={metric.f1} aria-label={`${DIMENSION_LABELS[dimension]} F1 ${formatScore(metric.f1)}`} />
                        )}
                      </th>
                      <td>{formatScore(metric.precision)}</td>
                      <td>{formatScore(metric.recall)}</td>
                      <td><strong>{formatScore(metric.f1)}</strong></td>
                      <td>{metric.expectedCount}</td>
                      <td>{metric.predictedCount}</td>
                      <td>{metric.falsePositives}</td>
                      <td>{metric.falseNegatives}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="benchmark-cases">
              <div className="benchmark-section-heading">
                <span className="atlas-section-label">CASE EVIDENCE</span>
                <h3>Expected and observed labels</h3>
              </div>
              {result.cases.map((caseResult) => (
                <details key={caseResult.id} className="benchmark-case" open={caseResult.partial || differenceCount(caseResult.aggregate) > 0}>
                  <summary>
                    <span>
                      <strong>{caseResult.name}</strong>
                      <small>{caseResult.description ?? caseResult.fixturePath}</small>
                    </span>
                    <span data-state={caseResult.partial ? "partial" : differenceCount(caseResult.aggregate) ? "review" : "match"}>
                      {caseState(caseResult)} · {formatDuration(caseResult.durationMs)}
                    </span>
                  </summary>
                  <div className="benchmark-case-body">
                    {DIMENSIONS.map((dimension) => {
                      const metric = caseResult.dimensions[dimension];
                      return (
                        <section key={dimension}>
                          <header>
                            <strong>{DIMENSION_LABELS[dimension]}</strong>
                            <span>F1 {formatScore(metric.f1)}</span>
                          </header>
                          {metric.falsePositiveLabels.length === 0 && metric.falseNegativeLabels.length === 0 ? (
                            <p>{metric.f1 === null ? "No expected or observed labels; score is N/A." : "Observed labels match the expectation."}</p>
                          ) : (
                            <div className="benchmark-differences">
                              {metric.falsePositiveLabels.length > 0 && (
                                <div><b>Unexpected</b><ul>{metric.falsePositiveLabels.map((label) => <li key={label}><code>{label}</code></li>)}</ul></div>
                              )}
                              {metric.falseNegativeLabels.length > 0 && (
                                <div><b>Missed</b><ul>{metric.falseNegativeLabels.map((label) => <li key={label}><code>{label}</code></li>)}</ul></div>
                              )}
                            </div>
                          )}
                        </section>
                      );
                    })}
                    <p className="benchmark-case-source">Manifest <code>{caseResult.manifestPath}</code> · Fixture <code>{caseResult.fixturePath}</code></p>
                  </div>
                </details>
              ))}
            </div>
          </section>
        )}
      </div>

      <footer className="atlas-footer benchmark-footer">
        <span>LOCAL CODE ATLAS</span>
        <p>Measured locally. Differences stay inspectable.</p>
        <a href="#benchmark-title">Back to top ↑</a>
      </footer>
    </main>
  );
}

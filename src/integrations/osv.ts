export type SupportedDependencyEcosystem =
  | "npm"
  | "python"
  | "maven"
  | "gradle"
  | "cargo"
  | "go";

export interface AdvisoryDependency {
  ecosystem: SupportedDependencyEcosystem;
  name: string;
  versionSpec: string;
  pinning: string;
  sourcePath: string;
  direct?: boolean;
  resolutionSource?: "manifest" | "lockfile";
}

export interface DependencyAdvisory {
  id: string;
  aliases: string[];
  packageName: string;
  packageVersion: string;
  ecosystem: string;
  sourcePath: string;
  summary: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  fixedVersion?: string;
  advisoryUrl: string;
}

export interface AdvisoryLookupResult {
  enabled: boolean;
  status:
    | "disabled"
    | "not-applicable"
    | "complete"
    | "partial"
    | "failed"
    | "cancelled";
  queriedPackages: number;
  findings: DependencyAdvisory[];
  diagnostics: string[];
  coverage: {
    totalDependencies: number;
    uniquePackages: number;
    exactVersionPackages: number;
    queriedPackages: number;
    skippedNonExact: number;
    cappedPackages: number;
    detailFailures: number;
  };
}

interface OsvQueryResult {
  vulns?: Array<{ id?: unknown }>;
}

interface OsvRangeEvent {
  introduced?: unknown;
  fixed?: unknown;
  last_affected?: unknown;
  limit?: unknown;
}

interface OsvRecord {
  id?: unknown;
  aliases?: unknown;
  summary?: unknown;
  details?: unknown;
  severity?: unknown;
  database_specific?: { severity?: unknown };
  affected?: Array<{
    package?: { name?: unknown; ecosystem?: unknown };
    ranges?: Array<{
      type?: unknown;
      events?: OsvRangeEvent[];
    }>;
    ecosystem_specific?: { severity?: unknown };
  }>;
}

interface SemanticVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<string | number>;
}

const OSV_ECOSYSTEM: Record<SupportedDependencyEcosystem, string> = {
  npm: "npm",
  python: "PyPI",
  maven: "Maven",
  gradle: "Maven",
  cargo: "crates.io",
  go: "Go",
};

const DEFAULT_OSV_TIMEOUT_MS = 10_000;
const MAXIMUM_OSV_TIMEOUT_MS = 120_000;

function configuredPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredTimeout(value: string | undefined): number {
  return Math.min(
    configuredPositiveInteger(value, DEFAULT_OSV_TIMEOUT_MS),
    MAXIMUM_OSV_TIMEOUT_MS,
  );
}

function exactVersion(dependency: AdvisoryDependency): string | undefined {
  if (dependency.pinning !== "exact") return undefined;
  const normalizedSpec =
    dependency.ecosystem === "python"
      ? dependency.versionSpec.trim().replace(/^===?\s*/u, "")
      : dependency.versionSpec.trim();
  const version = normalizedSpec.replace(/^v(?=\d)/u, "");
  if (!version || /[<>=~^*|,\s]/u.test(version)) return undefined;
  if (/^(?:git\+|https?:|ssh:|file:|link:|workspace:)/iu.test(version)) {
    return undefined;
  }
  return version;
}

function dependencyIdentity(dependency: AdvisoryDependency): string {
  return `${dependency.ecosystem}\u0000${dependency.name.toLowerCase()}\u0000${dependency.versionSpec}`;
}

function queryIdentity(
  dependency: AdvisoryDependency,
  version: string,
): string {
  return `${dependency.ecosystem}\u0000${dependency.name.toLowerCase()}\u0000${version}`;
}

function boundedText(value: unknown, fallback: string, limit = 500): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.replaceAll("\u0000", "").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function normalizedSeverity(value: unknown): DependencyAdvisory["severity"] {
  const severity = typeof value === "string" ? value.toLowerCase() : "";
  if (severity.includes("critical")) return "critical";
  if (severity.includes("high")) return "high";
  if (severity.includes("moderate") || severity.includes("medium")) return "medium";
  if (severity.includes("low")) return "low";
  return "info";
}

function severityFromCvssScore(
  score: number,
): DependencyAdvisory["severity"] {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "info";
}

function cvssV3BaseScore(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entry = value as Record<string, unknown>;
  if (entry.type !== "CVSS_V3" || typeof entry.score !== "string") {
    return undefined;
  }

  const sections = entry.score.trim().split("/");
  if (sections[0] !== "CVSS:3.0" && sections[0] !== "CVSS:3.1") {
    return undefined;
  }
  const expectedMetrics = new Set(["AV", "AC", "PR", "UI", "S", "C", "I", "A"]);
  const metrics = new Map<string, string>();
  for (const section of sections.slice(1)) {
    const separator = section.indexOf(":");
    if (separator <= 0 || section.indexOf(":", separator + 1) >= 0) {
      return undefined;
    }
    const name = section.slice(0, separator);
    const metric = section.slice(separator + 1);
    if (!expectedMetrics.has(name) || !metric || metrics.has(name)) {
      return undefined;
    }
    metrics.set(name, metric);
  }
  if (metrics.size !== expectedMetrics.size) return undefined;

  const attackVector = cvssMetric(metrics, "AV", {
    N: 0.85,
    A: 0.62,
    L: 0.55,
    P: 0.2,
  });
  const attackComplexity = cvssMetric(metrics, "AC", { L: 0.77, H: 0.44 });
  const userInteraction = cvssMetric(metrics, "UI", { N: 0.85, R: 0.62 });
  const scope = metrics.get("S");
  if (scope !== "U" && scope !== "C") return undefined;
  const privilegesRequired = cvssMetric(
    metrics,
    "PR",
    scope === "U"
      ? { N: 0.85, L: 0.62, H: 0.27 }
      : { N: 0.85, L: 0.68, H: 0.5 },
  );
  const confidentiality = cvssMetric(metrics, "C", { H: 0.56, L: 0.22, N: 0 });
  const integrity = cvssMetric(metrics, "I", { H: 0.56, L: 0.22, N: 0 });
  const availability = cvssMetric(metrics, "A", { H: 0.56, L: 0.22, N: 0 });
  const weights = [
    attackVector,
    attackComplexity,
    privilegesRequired,
    userInteraction,
    confidentiality,
    integrity,
    availability,
  ];
  if (weights.some((weight) => weight === undefined)) return undefined;

  const impactSubScore =
    1 -
    (1 - confidentiality!) *
      (1 - integrity!) *
      (1 - availability!);
  const impact =
    scope === "U"
      ? 6.42 * impactSubScore
      : 7.52 * (impactSubScore - 0.029) -
        3.25 * (impactSubScore - 0.02) ** 15;
  if (impact <= 0) return 0;
  const exploitability =
    8.22 *
    attackVector! *
    attackComplexity! *
    privilegesRequired! *
    userInteraction!;
  const rawScore =
    scope === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);
  return cvssRoundUp(rawScore);
}

function cvssMetric<TMetric extends string>(
  metrics: ReadonlyMap<string, string>,
  name: string,
  weights: Readonly<Record<TMetric, number>>,
): number | undefined {
  const metric = metrics.get(name);
  return metric && Object.hasOwn(weights, metric)
    ? weights[metric as TMetric]
    : undefined;
}

function cvssRoundUp(value: number): number {
  // FIRST's integer method avoids floating-point values just above an exact
  // tenth being rounded into the next qualitative band.
  const scaled = Math.round(value * 100_000);
  return scaled % 10_000 === 0
    ? scaled / 100_000
    : (Math.floor(scaled / 10_000) + 1) / 10;
}

function recordSeverity(record: OsvRecord): DependencyAdvisory["severity"] {
  const cvssScores = (Array.isArray(record.severity) ? record.severity : [])
    .map(cvssV3BaseScore)
    .filter((score): score is number => score !== undefined);
  if (cvssScores.length > 0) {
    return severityFromCvssScore(Math.max(...cvssScores));
  }

  const candidates = [
    record.database_specific?.severity,
    ...(record.affected ?? []).map((item) => item.ecosystem_specific?.severity),
  ];
  for (const candidate of candidates) {
    const severity = normalizedSeverity(candidate);
    if (severity !== "info") return severity;
  }
  return "info";
}

function appropriateFixedVersion(
  record: OsvRecord,
  dependency: AdvisoryDependency,
  queriedVersion: string,
): string | undefined {
  const parsedQuery = parseSemanticVersion(queriedVersion);
  if (!parsedQuery) return undefined;

  const expectedEcosystem = OSV_ECOSYSTEM[dependency.ecosystem];
  const candidates: Array<{ raw: string; parsed: SemanticVersion }> = [];
  for (const affected of record.affected ?? []) {
    if (
      affected.package?.name !== dependency.name ||
      typeof affected.package.ecosystem !== "string" ||
      affected.package.ecosystem.toLowerCase() !== expectedEcosystem.toLowerCase()
    ) {
      continue;
    }
    for (const range of affected.ranges ?? []) {
      if (range.type !== "SEMVER") continue;
      const candidate = fixedVersionForSemanticRange(
        range.events ?? [],
        parsedQuery,
      );
      if (candidate) {
        candidates.push({ raw: candidate, parsed: parseSemanticVersion(candidate)! });
      }
    }
  }
  candidates.sort((left, right) => compareSemanticVersions(left.parsed, right.parsed));
  return candidates[0]?.raw;
}

function fixedVersionForSemanticRange(
  events: readonly OsvRangeEvent[],
  queriedVersion: SemanticVersion,
): string | undefined {
  let introduced: SemanticVersion | "beginning" | undefined;
  let previousEventVersion: SemanticVersion | "beginning" | undefined;
  let candidate: string | undefined;

  for (const event of events) {
    const fields = ["introduced", "fixed", "last_affected", "limit"] as const;
    const present = fields.filter(
      (field) => typeof event[field] === "string" && event[field].trim(),
    );
    if (present.length !== 1) return undefined;

    const field = present[0];
    const rawVersion = (event[field] as string).trim();
    const eventVersion =
      field === "introduced" && rawVersion === "0"
        ? "beginning"
        : parseSemanticVersion(rawVersion);
    if (!eventVersion) return undefined;
    if (
      previousEventVersion &&
      compareSemanticBounds(previousEventVersion, eventVersion) > 0
    ) {
      // The schema recommends chronological order. An out-of-order timeline is
      // ambiguous, so it is safer not to suggest a remediation version.
      return undefined;
    }
    previousEventVersion = eventVersion;

    if (field === "introduced") {
      if (introduced) return undefined;
      introduced = eventVersion;
      continue;
    }

    if (!introduced || eventVersion === "beginning") return undefined;
    const queryAtOrAfterIntroduction =
      introduced === "beginning" ||
      compareSemanticVersions(queriedVersion, introduced) >= 0;

    if (field === "fixed") {
      if (
        queryAtOrAfterIntroduction &&
        compareSemanticVersions(queriedVersion, eventVersion) < 0
      ) {
        candidate = rawVersion;
      }
    }
    // last_affected and limit close a vulnerable interval but do not identify
    // a version that is proven to contain a fix.
    introduced = undefined;
  }

  return candidate;
}

function parseSemanticVersion(value: string): SemanticVersion | undefined {
  const match = value
    .trim()
    .match(
      /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    );
  if (!match) return undefined;
  const numeric = match.slice(1, 4).map((part) => Number.parseInt(part, 10));
  if (numeric.some((part) => !Number.isSafeInteger(part))) return undefined;
  const prereleaseParts = match[4]?.split(".") ?? [];
  if (prereleaseParts.some((part) => /^\d+$/u.test(part) && !/^(?:0|[1-9]\d*)$/u.test(part))) {
    return undefined;
  }
  const prerelease = prereleaseParts.map((part) =>
    /^(?:0|[1-9]\d*)$/u.test(part) ? Number.parseInt(part, 10) : part,
  );
  return {
    major: numeric[0],
    minor: numeric[1],
    patch: numeric[2],
    prerelease,
  };
}

function compareSemanticBounds(
  left: SemanticVersion | "beginning",
  right: SemanticVersion | "beginning",
): number {
  if (left === "beginning") return right === "beginning" ? 0 : -1;
  if (right === "beginning") return 1;
  return compareSemanticVersions(left, right);
}

function compareSemanticVersions(
  left: SemanticVersion,
  right: SemanticVersion,
): number {
  for (const field of ["major", "minor", "patch"] as const) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    if (typeof leftPart === "number" && typeof rightPart === "number") {
      return leftPart < rightPart ? -1 : 1;
    }
    if (typeof leftPart === "number") return -1;
    if (typeof rightPart === "number") return 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function createDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
} {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const cancelFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) cancelFromCaller();
  else callerSignal?.addEventListener("abort", cancelFromCaller, { once: true });

  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timeoutTriggered = true;
    controller.abort(new DOMException("OSV lookup timed out.", "TimeoutError"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    cleanup: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", cancelFromCaller);
    },
  };
}

export async function lookupDependencyAdvisories(
  dependencies: readonly AdvisoryDependency[],
  options: {
    enabled: boolean;
    environment?: NodeJS.ProcessEnv;
    fetchImplementation?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<AdvisoryLookupResult> {
  const uniqueDependencyCount = new Set(dependencies.map(dependencyIdentity)).size;
  const exactDependencyCount = new Set(
    dependencies.flatMap((dependency) => {
      const version = exactVersion(dependency);
      return version ? [queryIdentity(dependency, version)] : [];
    }),
  ).size;
  const emptyCoverage = {
    totalDependencies: dependencies.length,
    uniquePackages: uniqueDependencyCount,
    exactVersionPackages: exactDependencyCount,
    queriedPackages: 0,
    skippedNonExact: Math.max(0, uniqueDependencyCount - exactDependencyCount),
    cappedPackages: 0,
    detailFailures: 0,
  };
  if (!options.enabled) {
    return {
      enabled: false,
      status: "disabled",
      queriedPackages: 0,
      findings: [],
      diagnostics: [],
      coverage: emptyCoverage,
    };
  }

  const environment = options.environment ?? process.env;
  const maximumPackages = configuredPositiveInteger(
    environment.ATLAS_OSV_MAX_PACKAGES,
    200,
  );
  const maximumAdvisories = configuredPositiveInteger(
    environment.ATLAS_OSV_MAX_ADVISORIES,
    40,
  );
  const timeoutMs = configuredTimeout(environment.ATLAS_OSV_TIMEOUT_MS);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const eligibleByIdentity = new Map<
    string,
    { dependency: AdvisoryDependency; version: string }
  >();
  for (const dependency of dependencies) {
    const version = exactVersion(dependency);
    if (!version) continue;
    const identity = queryIdentity(dependency, version);
    const existing = eligibleByIdentity.get(identity);
    if (!existing || (!existing.dependency.direct && dependency.direct)) {
      eligibleByIdentity.set(identity, { dependency, version });
    }
  }
  const eligibleQueries = [...eligibleByIdentity.values()];
  const queries = eligibleQueries.slice(0, maximumPackages);
  const coverage = {
    totalDependencies: dependencies.length,
    uniquePackages: uniqueDependencyCount,
    exactVersionPackages: eligibleQueries.length,
    queriedPackages: queries.length,
    skippedNonExact: Math.max(0, uniqueDependencyCount - eligibleQueries.length),
    cappedPackages: Math.max(0, eligibleQueries.length - queries.length),
    detailFailures: 0,
  };

  if (queries.length === 0) {
    return {
      enabled: true,
      status: "not-applicable",
      queriedPackages: 0,
      findings: [],
      diagnostics: [
        "OSV lookup skipped because no exact resolved dependency versions were available.",
      ],
      coverage,
    };
  }

  const deadline = createDeadline(options.signal, timeoutMs);
  try {
    const batchResponse = await fetchImplementation(
      "https://api.osv.dev/v1/querybatch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: queries.map(({ dependency, version }) => ({
            version,
            package: {
              ecosystem: OSV_ECOSYSTEM[dependency.ecosystem],
              name: dependency.name,
            },
          })),
        }),
        signal: deadline.signal,
      },
    );
    if (!batchResponse.ok) {
      return {
        enabled: true,
        status: "failed",
        queriedPackages: queries.length,
        findings: [],
        diagnostics: [`OSV lookup returned HTTP ${batchResponse.status}.`],
        coverage,
      };
    }

    const batch = (await batchResponse.json()) as { results?: OsvQueryResult[] };
    const matches = (batch.results ?? []).flatMap((result, index) =>
      (result.vulns ?? []).flatMap((vulnerability) => {
        const id = typeof vulnerability.id === "string" ? vulnerability.id : undefined;
        const query = queries[index];
        return id && query ? [{ id, ...query }] : [];
      }),
    );
    const uniqueIds = [...new Set(matches.map((match) => match.id))].slice(
      0,
      maximumAdvisories,
    );
    const records = new Map<string, OsvRecord>();
    let detailFailures = 0;
    await Promise.all(
      uniqueIds.map(async (id) => {
        try {
          const response = await fetchImplementation(
            `https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`,
            { signal: deadline.signal },
          );
          if (response.ok) records.set(id, (await response.json()) as OsvRecord);
          else detailFailures += 1;
        } catch (error) {
          if (deadline.signal.aborted) throw error;
          detailFailures += 1;
        }
      }),
    );

    const findings = matches
      .filter((match, index, all) =>
        index ===
        all.findIndex(
          (candidate) =>
            candidate.id === match.id &&
            candidate.dependency.name === match.dependency.name &&
            candidate.version === match.version,
        ),
      )
      .slice(0, maximumAdvisories)
      .map((match) => {
        const record = records.get(match.id) ?? {};
        return {
          id: match.id,
          aliases: Array.isArray(record.aliases)
            ? record.aliases.filter((alias): alias is string => typeof alias === "string")
            : [],
          packageName: match.dependency.name,
          packageVersion: match.version,
          ecosystem: OSV_ECOSYSTEM[match.dependency.ecosystem],
          sourcePath: match.dependency.sourcePath,
          summary: boundedText(record.summary ?? record.details, "Known dependency advisory"),
          severity: recordSeverity(record),
          fixedVersion: appropriateFixedVersion(
            record,
            match.dependency,
            match.version,
          ),
          advisoryUrl: `https://osv.dev/vulnerability/${encodeURIComponent(match.id)}`,
        } satisfies DependencyAdvisory;
      });

    const diagnostics: string[] = [];
    if (coverage.skippedNonExact > 0) {
      diagnostics.push(
        "OSV lookup sends only exact package names and versions; ranges and unpinned dependencies were excluded.",
      );
    }
    if (coverage.cappedPackages > 0) {
      diagnostics.push(
        `OSV package queries were capped at the configured limit of ${maximumPackages}.`,
      );
    }
    if (matches.length > maximumAdvisories) {
      diagnostics.push(
        `OSV advisory details were capped at the configured limit of ${maximumAdvisories}.`,
      );
    }
    if (detailFailures > 0) {
      diagnostics.push(
        `${detailFailures} OSV advisory detail request${detailFailures === 1 ? "" : "s"} could not be completed.`,
      );
    }
    const completedCoverage = { ...coverage, detailFailures };
    const partial =
      completedCoverage.skippedNonExact > 0 ||
      completedCoverage.cappedPackages > 0 ||
      completedCoverage.detailFailures > 0 ||
      (batch.results?.length ?? 0) !== queries.length ||
      matches.length > maximumAdvisories;
    return {
      enabled: true,
      status: partial ? "partial" : "complete",
      queriedPackages: queries.length,
      findings,
      diagnostics,
      coverage: completedCoverage,
    };
  } catch {
    const timedOut = deadline.timedOut();
    const cancelled = !timedOut && options.signal?.aborted === true;
    return {
      enabled: true,
      status: cancelled ? "cancelled" : "failed",
      queriedPackages: queries.length,
      findings: [],
      diagnostics: [
        timedOut
          ? `OSV lookup timed out after ${timeoutMs} ms.`
          : cancelled
          ? "OSV lookup was cancelled."
          : "OSV lookup could not reach the advisory service.",
      ],
      coverage,
    };
  } finally {
    deadline.cleanup();
  }
}

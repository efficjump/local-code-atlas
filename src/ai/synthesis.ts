export interface SynthesisEvidence {
  project: {
    name: string;
    languages: string[];
    frameworks: string[];
  };
  question: string;
  impact: Array<{ path: string; reason: string; excerpt?: string }>;
  security: Array<{
    title: string;
    severity: string;
    path: string;
    evidence: string;
  }>;
  dataModel: Array<{ table: string; columns: string[] }>;
}

export interface AiSynthesis {
  enabled: boolean;
  requestAttempted?: boolean;
  summary?: string;
  recommendations?: string[];
  diagnostic?: string;
}

interface ModelConfiguration {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxEvidence: number;
  timeoutMs: number;
}

function configuredPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function loadModelConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ModelConfiguration {
  return {
    baseUrl: environment.ATLAS_LLM_BASE_URL?.trim(),
    apiKey: environment.ATLAS_LLM_API_KEY?.trim(),
    model: environment.ATLAS_LLM_MODEL?.trim(),
    maxEvidence: configuredPositiveInteger(
      environment.ATLAS_LLM_MAX_EVIDENCE,
      24,
    ),
    timeoutMs: configuredPositiveInteger(
      environment.ATLAS_LLM_TIMEOUT_MS,
      20_000,
    ),
  };
}

export function modelIsConfigured(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const configuration = loadModelConfiguration(environment);
  return Boolean(configuration.model && validatedModelBaseUrl(configuration.baseUrl));
}

/** Return only the validated endpoint origin, never credentials, paths, or queries. */
export function modelEndpointOrigin(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return validatedModelBaseUrl(loadModelConfiguration(environment).baseUrl)?.origin;
}

/** @deprecated Use modelEndpointOrigin. Kept as a compatibility alias. */
export function modelEndpointHost(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return modelEndpointOrigin(environment);
}

function validatedModelBaseUrl(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (hostname === "::1") return true;
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet)) &&
    Number(octets[0]) === 127 &&
    octets.every((octet) => Number(octet) <= 255)
  );
}

function completionEndpoint(baseUrl: URL): string {
  const endpoint = new URL(baseUrl.origin);
  endpoint.pathname = `${baseUrl.pathname.replace(/\/+$/u, "")}/chat/completions`;
  return endpoint.href;
}

function bounded(value: string, length = 400): string {
  const normalized = value.replaceAll("\u0000", "").trim();
  return normalized.length <= length
    ? normalized
    : `${normalized.slice(0, Math.max(0, length - 1))}…`;
}

function redact(value: string): string {
  return bounded(value)
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/gu, "[REDACTED_HEX]");
}

function boundedEvidence(
  evidence: SynthesisEvidence,
  maximum: number,
): SynthesisEvidence {
  return {
    project: {
      name: bounded(evidence.project.name, 120),
      languages: evidence.project.languages.slice(0, maximum).map((item) => bounded(item, 80)),
      frameworks: evidence.project.frameworks.slice(0, maximum).map((item) => bounded(item, 80)),
    },
    question: redact(evidence.question),
    impact: evidence.impact.slice(0, maximum).map((item) => ({
      path: bounded(item.path, 240),
      reason: redact(item.reason),
      excerpt: item.excerpt ? redact(item.excerpt) : undefined,
    })),
    security: evidence.security.slice(0, maximum).map((item) => ({
      title: bounded(item.title, 160),
      severity: bounded(item.severity, 40),
      path: bounded(item.path, 240),
      evidence: redact(item.evidence),
    })),
    dataModel: evidence.dataModel.slice(0, maximum).map((item) => ({
      table: bounded(item.table, 120),
      columns: item.columns.slice(0, maximum).map((column) => bounded(column, 120)),
    })),
  };
}

function parseJsonContent(content: string): {
  summary?: unknown;
  recommendations?: unknown;
} {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1];
  return JSON.parse(fenced ?? content) as {
    summary?: unknown;
    recommendations?: unknown;
  };
}

export async function synthesizeWithModel(
  evidence: SynthesisEvidence,
  options: {
    enabled: boolean;
    environment?: NodeJS.ProcessEnv;
    fetchImplementation?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<AiSynthesis> {
  if (!options.enabled) return { enabled: false };
  if (options.signal?.aborted) {
    return {
      enabled: false,
      requestAttempted: false,
      diagnostic: "AI synthesis was cancelled before the request started.",
    };
  }

  const configuration = loadModelConfiguration(options.environment);
  const baseUrl = validatedModelBaseUrl(configuration.baseUrl);
  if (!baseUrl || !configuration.model) {
    return {
      enabled: false,
      diagnostic:
        "AI synthesis was requested but no chat-completions endpoint and model are configured.",
    };
  }

  const controller = new AbortController();
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeout = setTimeout(() => controller.abort(), configuration.timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let requestAttempted = false;

  try {
    const endpoint = completionEndpoint(baseUrl);
    requestAttempted = true;
    const response = await fetchImplementation(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        ...(configuration.apiKey
          ? { Authorization: `Bearer ${configuration.apiKey}` }
          : {}),
      },
      body: JSON.stringify({
        model: configuration.model,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content:
              "You synthesize static-analysis evidence. Do not invent files, vulnerabilities, or relationships. Distinguish facts from uncertainty. Return JSON with a concise summary string and a recommendations string array.",
          },
          {
            role: "user",
            content: JSON.stringify(
              boundedEvidence(evidence, configuration.maxEvidence),
            ),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        enabled: false,
        requestAttempted,
        diagnostic: `AI synthesis returned HTTP ${response.status}.`,
      };
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return {
        enabled: false,
        requestAttempted,
        diagnostic: "AI synthesis returned no content.",
      };
    }
    const parsed = parseJsonContent(content);
    const summary =
      typeof parsed.summary === "string" ? bounded(parsed.summary, 1_000) : undefined;
    const recommendations = Array.isArray(parsed.recommendations)
      ? parsed.recommendations
          .filter((item): item is string => typeof item === "string")
          .slice(0, 8)
          .map((item) => bounded(item, 500))
      : undefined;

    if (!summary && (!recommendations || recommendations.length === 0)) {
      return {
        enabled: false,
        requestAttempted,
        diagnostic: "AI synthesis did not match the expected response shape.",
      };
    }
    return { enabled: true, requestAttempted, summary, recommendations };
  } catch (error) {
    return {
      enabled: false,
      requestAttempted,
      diagnostic:
        error instanceof Error && error.name === "AbortError"
          ? "AI synthesis timed out or was cancelled."
          : "AI synthesis could not be completed.",
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

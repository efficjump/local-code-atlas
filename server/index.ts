import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBenchmarkCatalog } from "../src/benchmark/index.js";
import { analyzeLocalProject } from "../src/report/analyze.js";
import { modelEndpointOrigin, modelIsConfigured } from "../src/ai/synthesis.js";
import { GitComparisonError } from "../src/core/git.js";
import {
  AI_SYNTHESIS_REQUEST_FIELDS,
  OSV_REQUEST_FIELDS,
} from "../src/privacy/external-data.js";
import type {
  AnalyzeRequest,
  GitComparisonMode,
  ProjectScope,
} from "../src/report/types.js";
import {
  assertSafeServerBinding,
  isLoopbackHost,
  loadEngineConfig,
} from "./config.js";
import { loadLocalEnvironment } from "./env.js";
import {
  applyCors,
  originIsAllowed,
  readJsonBody,
  RequestError,
  sendJson,
} from "./http.js";
import { PathPolicyError, resolveProjectPath } from "./path-policy.js";
import {
  bundledSampleRoot as resolveBundledSampleRoot,
  loadBundledSampleGitMetadata,
  loadBundledSampleGitSnapshots,
} from "./sample.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(moduleDirectory, "..");
const bundledSampleRoot = resolveBundledSampleRoot(projectRoot);
const bundledBenchmarkRoot = join(projectRoot, "benchmarks");

type BenchmarkRunner = typeof runBenchmarkCatalog;

export interface AtlasServerOptions {
  benchmarkRoot?: string;
  runBenchmark?: BenchmarkRunner;
}

async function projectVersion(): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "development";
  } catch {
    return "development";
  }
}

function normalizedQuestion(value: unknown): string {
  if (value === undefined) return "What is affected by the current local changes?";
  if (typeof value !== "string") {
    throw new RequestError(400, "INVALID_QUESTION", "Question must be a string.");
  }
  const question = value.trim();
  if (!question) return "What is affected by the current local changes?";
  if (question.length > 2_000) {
    throw new RequestError(
      400,
      "QUESTION_TOO_LONG",
      "Question must not exceed 2,000 characters.",
    );
  }
  return question;
}

function booleanValue(value: unknown, field: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    throw new RequestError(400, `INVALID_${field.toUpperCase()}`, `${field} must be a boolean.`);
  }
  return value;
}

function scopeValue(value: unknown): ProjectScope {
  if (value === undefined) return "production";
  if (value === "production" || value === "all") return value;
  throw new RequestError(
    400,
    "INVALID_SCOPE",
    "scope must be either production or all.",
  );
}

function comparisonValue(value: unknown): AnalyzeRequest["comparison"] {
  if (value === undefined) return { mode: "working-tree" };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(400, "INVALID_COMPARISON", "comparison must be an object.");
  }
  const record = value as Record<string, unknown>;
  const supported = new Set<GitComparisonMode>(["working-tree", "staged", "base"]);
  if (typeof record.mode !== "string" || !supported.has(record.mode as GitComparisonMode)) {
    throw new RequestError(
      400,
      "INVALID_COMPARISON_MODE",
      "comparison.mode must be working-tree, staged, or base.",
    );
  }
  const mode = record.mode as GitComparisonMode;
  if (mode !== "base") return { mode };
  const base = typeof record.base === "string" ? record.base.trim() : "";
  if (!base) {
    throw new RequestError(
      400,
      "COMPARISON_BASE_REQUIRED",
      "Choose a branch or commit when using base comparison.",
    );
  }
  if (
    base.length > 200 ||
    base.startsWith("-") ||
    !/^[A-Za-z0-9_./@{}^~:+-]+$/u.test(base)
  ) {
    throw new RequestError(
      400,
      "INVALID_COMPARISON_BASE",
      "The comparison branch or commit contains unsupported characters.",
    );
  }
  return { mode, base };
}

async function analyze(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const config = loadEngineConfig();
  const body = await readJsonBody<AnalyzeRequest>(request, config.requestBodyBytes);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(400, "INVALID_REQUEST", "Request body must be an object.");
  }

  const sample = booleanValue(body.sample, "sample");
  const enableAi = booleanValue(body.enableAi, "enableAi");
  const checkDependencies = booleanValue(
    body.checkDependencies,
    "checkDependencies",
  );
  const scope = scopeValue(body.scope);
  const comparison = comparisonValue(body.comparison);
  let root: string;
  if (sample) {
    root = bundledSampleRoot;
  } else if (typeof body.projectPath === "string") {
    root = await resolveProjectPath(body.projectPath, config);
  } else {
    throw new RequestError(
      400,
      "PATH_REQUIRED",
      "Provide projectPath or request the bundled sample.",
    );
  }

  const controller = new AbortController();
  const abortForDisconnect = () => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error("Client disconnected before analysis completed."));
    }
  };
  request.once("aborted", abortForDisconnect);
  response.once("close", abortForDisconnect);
  if (request.aborted || response.destroyed) abortForDisconnect();
  const effectiveComparison = sample ? { mode: "working-tree" as const } : comparison;
  let report;
  try {
    report = await analyzeLocalProject(
      {
        root,
        question: normalizedQuestion(body.question),
        enableAi,
        checkDependencies,
        scope,
        comparison: effectiveComparison,
        gitMetadataOverride: sample
          ? await loadBundledSampleGitMetadata(projectRoot)
          : undefined,
        gitFileSnapshotsOverride: sample
          ? await loadBundledSampleGitSnapshots(projectRoot)
          : undefined,
        publicPath: sample ? "Bundled sample" : root,
        limits: {
          maxFiles: config.maxFiles,
          maxFileBytes: config.maxFileBytes,
          maxTotalBytes: config.maxTotalBytes,
        },
      },
      controller.signal,
    );
  } catch (error) {
    if (error instanceof GitComparisonError) {
      throw new RequestError(
        400,
        error.code === "NOT_REPOSITORY"
          ? "COMPARISON_REQUIRES_GIT"
          : "COMPARISON_BASE_NOT_FOUND",
        error.code === "NOT_REPOSITORY"
          ? "Base comparison requires the selected project to be a Git repository."
          : `Git could not compare ${effectiveComparison?.base ?? "the selected revision"} to HEAD. Check that the revision exists in this repository.`,
      );
    }
    throw error;
  } finally {
    request.removeListener("aborted", abortForDisconnect);
    response.removeListener("close", abortForDisconnect);
  }
  sendJson(response, 200, report);
}

async function benchmark(
  request: IncomingMessage,
  response: ServerResponse,
  options: Required<AtlasServerOptions>,
): Promise<void> {
  const config = loadEngineConfig();
  const body = await readJsonBody<Record<string, unknown>>(
    request,
    config.requestBodyBytes,
  );
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError(
      400,
      "INVALID_BENCHMARK_REQUEST",
      "Benchmark request body must be an object.",
    );
  }
  const fields = Object.keys(body);
  if (fields.length !== 1 || fields[0] !== "suite") {
    throw new RequestError(
      400,
      "INVALID_BENCHMARK_REQUEST",
      "Benchmark requests accept only the bundled suite selector.",
    );
  }
  if (body.suite !== "bundled") {
    throw new RequestError(
      400,
      "UNSUPPORTED_BENCHMARK_SUITE",
      "The local HTTP API runs only the bundled benchmark suite.",
    );
  }

  const controller = new AbortController();
  const abortForDisconnect = () => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(
        new Error("Client disconnected before benchmark execution completed."),
      );
    }
  };
  request.once("aborted", abortForDisconnect);
  response.once("close", abortForDisconnect);
  if (request.aborted || response.destroyed) abortForDisconnect();

  try {
    const result = await options.runBenchmark(options.benchmarkRoot, {
      signal: controller.signal,
    });
    sendJson(response, 200, result);
  } finally {
    request.removeListener("aborted", abortForDisconnect);
    response.removeListener("close", abortForDisconnect);
  }
}

export function createAtlasServer(options: AtlasServerOptions = {}) {
  loadLocalEnvironment(projectRoot);
  const config = loadEngineConfig();
  assertSafeServerBinding(config);
  const benchmarkOptions: Required<AtlasServerOptions> = {
    benchmarkRoot: options.benchmarkRoot ?? bundledBenchmarkRoot,
    runBenchmark: options.runBenchmark ?? runBenchmarkCatalog,
  };
  return createServer(async (request, response) => {
    applyCors(request, response, config.allowedOrigins);
    const requestId = randomUUID();
    response.setHeader("X-Request-Id", requestId);

    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (!originIsAllowed(request.headers.origin, config.allowedOrigins)) {
        throw new RequestError(
          403,
          "ORIGIN_NOT_ALLOWED",
          "This browser origin is not allowed to call the local engine.",
        );
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        const aiConfigured = modelIsConfigured();
        const requestedProject = url.searchParams.get("project")?.trim();
        let projectPolicy:
          | { checked: true; allowed: boolean; exclusiveAllowedRoot: boolean }
          | undefined;
        if (requestedProject) {
          try {
            const canonicalProject = await resolveProjectPath(requestedProject, config);
            const canonicalAllowedRoot =
              config.allowedRoots.length === 1
                ? await realpath(config.allowedRoots[0]).catch(() =>
                    resolve(config.allowedRoots[0]),
                  )
                : undefined;
            projectPolicy = {
              checked: true,
              allowed: true,
              exclusiveAllowedRoot: canonicalAllowedRoot === canonicalProject,
            };
          } catch {
            projectPolicy = {
              checked: true,
              allowed: false,
              exclusiveAllowedRoot: false,
            };
          }
        }
        sendJson(response, 200, {
          service: "local-code-atlas-engine",
          status: "ok",
          version: await projectVersion(),
          localOnly: isLoopbackHost(config.host),
          platform: process.platform,
          allowedRootsConfigured: config.allowedRoots.length > 0,
          capabilities: {
            benchmark: true,
            migrationRisk: true,
          },
          projectPolicy,
          external: {
            localByDefault: true,
            osv: {
              available: true,
              wouldTransmit: OSV_REQUEST_FIELDS,
            },
            ai: {
              configured: aiConfigured,
              endpointOrigin: aiConfigured ? modelEndpointOrigin() : undefined,
              wouldTransmit: AI_SYNTHESIS_REQUEST_FIELDS,
            },
          },
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/analyze") {
        await analyze(request, response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/benchmark") {
        await benchmark(request, response, benchmarkOptions);
        return;
      }
      sendJson(response, 404, {
        error: { code: "NOT_FOUND", message: "Endpoint not found.", requestId },
      });
    } catch (error) {
      if (response.destroyed || response.writableEnded) return;
      if (error instanceof RequestError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message, requestId },
        });
        return;
      }
      if (error instanceof PathPolicyError) {
        sendJson(response, 400, {
          error: { code: error.code, message: error.message, requestId },
        });
        return;
      }
      console.error(`[${requestId}] analysis failed`, error);
      sendJson(response, 500, {
        error: {
          code: "ANALYSIS_FAILED",
          message: "The project could not be analyzed. Check the engine log for details.",
          requestId,
        },
      });
    }
  });
}

const executedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (executedDirectly) {
  const server = createAtlasServer();
  const config = loadEngineConfig();
  server.listen(config.port, config.host, () => {
    console.log(`Local Code Atlas engine listening on http://${config.host}:${config.port}`);
  });
}

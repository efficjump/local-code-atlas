import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { createAtlasServer } from "../server/index.js";
import type { runBenchmarkCatalog } from "../src/benchmark/index.js";

async function listeningServer(
  options: Parameters<typeof createAtlasServer>[0] = {},
) {
  const server = createAtlasServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

test("benchmark API advertises capability and runs only the bundled catalog", async (context) => {
  const { server, baseUrl } = await listeningServer();
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json() as {
    capabilities: { benchmark: boolean; migrationRisk: boolean };
  };
  assert.deepEqual(healthPayload.capabilities, {
    benchmark: true,
    migrationRisk: true,
  });

  const response = await fetch(`${baseUrl}/api/benchmark`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({ suite: "bundled" }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
  const resultText = await response.text();
  const result = JSON.parse(resultText) as {
    schemaVersion: number;
    caseCount: number;
    partial: boolean;
    partialCaseCount: number;
    cases: unknown[];
  };
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.caseCount, result.cases.length);
  assert.equal(result.partial, false);
  assert.equal(result.partialCaseCount, 0);
  assert.equal(resultText.includes(process.cwd()), false);
  assert.equal(resultText.includes("endpointOrigin"), false);
  assert.equal(resultText.includes("transmitted"), false);

  const unsupported = await fetch(`${baseUrl}/api/benchmark`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suite: "../private-suite" }),
  });
  assert.equal(unsupported.status, 400);
  assert.equal(
    (await unsupported.json() as { error: { code: string } }).error.code,
    "UNSUPPORTED_BENCHMARK_SUITE",
  );

  const injectedPath = await fetch(`${baseUrl}/api/benchmark`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suite: "bundled", catalogPath: "/tmp/private" }),
  });
  assert.equal(injectedPath.status, 400);
  assert.equal(
    (await injectedPath.json() as { error: { code: string } }).error.code,
    "INVALID_BENCHMARK_REQUEST",
  );

  const foreignOrigin = await fetch(`${baseUrl}/api/benchmark`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.invalid",
    },
    body: JSON.stringify({ suite: "bundled" }),
  });
  assert.equal(foreignOrigin.status, 403);
});

test("disconnecting a benchmark client aborts the local runner", async (context) => {
  let markStarted: (() => void) | undefined;
  let markAborted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    markAborted = resolve;
  });
  const runBenchmark: typeof runBenchmarkCatalog = async (_root, options = {}) => {
    markStarted?.();
    return await new Promise<never>((_resolve, reject) => {
      const signal = options.signal;
      if (!signal) {
        reject(new Error("Expected an abort signal."));
        return;
      }
      const handleAbort = () => {
        markAborted?.();
        reject(signal.reason ?? new Error("Benchmark aborted."));
      };
      if (signal.aborted) handleAbort();
      else signal.addEventListener("abort", handleAbort, { once: true });
    });
  };
  const { server, baseUrl } = await listeningServer({ runBenchmark });
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const url = new URL("/api/benchmark", baseUrl);
  const client = httpRequest({
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  client.on("error", () => undefined);
  client.end(JSON.stringify({ suite: "bundled" }));
  await started;
  client.destroy();
  await aborted;
  assert.ok(true);
});

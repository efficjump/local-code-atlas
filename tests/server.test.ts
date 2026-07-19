import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAtlasServer } from "../server/index.js";

test("local server exposes health, analysis, and origin protection", async (context) => {
  const server = createAtlasServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const healthPayload = await health.json() as {
    service: string;
    status: string;
    external: {
      localByDefault: boolean;
      osv: { wouldTransmit: string[]; transmitted?: string[] };
      ai: { configured: boolean; wouldTransmit: string[]; transmitted?: string[] };
    };
  };
  assert.equal(healthPayload.status, "ok");
  assert.equal(healthPayload.service, "local-code-atlas-engine");
  assert.equal(healthPayload.external.localByDefault, true);
  assert.equal(healthPayload.external.ai.configured, false);
  assert.ok(healthPayload.external.osv.wouldTransmit.includes("exact version"));
  assert.ok(healthPayload.external.ai.wouldTransmit.includes("project name"));
  assert.equal(healthPayload.external.osv.transmitted, undefined);
  assert.equal(healthPayload.external.ai.transmitted, undefined);

  const analysis = await fetch(`${baseUrl}/api/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost:3000",
    },
    body: JSON.stringify({
      sample: true,
      question: "What changes when session expiration changes?",
    }),
  });
  assert.equal(analysis.status, 200);
  const report = await analysis.json() as {
    project: { name: string; git?: { branch?: string; changedFiles: string[] } };
    security: { findings: unknown[] };
  };
  assert.equal(report.project.name, "atlas-sample-service");
  assert.equal(report.project.git?.branch, "demo/session-expiry");
  assert.deepEqual(report.project.git?.changedFiles, [
    "db/schema.sql",
    "src/services/session-service.ts",
    "tests/session-service.test.ts",
  ]);
  assert.ok(report.security.findings.length >= 1);

  const rejected = await fetch(`${baseUrl}/api/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://example.invalid",
    },
    body: JSON.stringify({ sample: true }),
  });
  assert.equal(rejected.status, 403);

  const invalidComparison = await fetch(`${baseUrl}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sample: true,
      comparison: { mode: "base", base: "--dangerous" },
    }),
  });
  assert.equal(invalidComparison.status, 400);
  assert.equal(
    (await invalidComparison.json() as { error: { code: string } }).error.code,
    "INVALID_COMPARISON_BASE",
  );

  const nonGitRoot = await mkdtemp(join(os.tmpdir(), "local-code-atlas-no-git-"));
  context.after(() => rm(nonGitRoot, { recursive: true, force: true }));
  await writeFile(
    join(nonGitRoot, "package.json"),
    JSON.stringify({ name: "non-git-project", private: true }),
  );
  const policyHealth = await fetch(
    `${baseUrl}/api/health?project=${encodeURIComponent(nonGitRoot)}`,
  );
  const policyPayload = await policyHealth.json() as {
    projectPolicy: { checked: boolean; allowed: boolean; exclusiveAllowedRoot: boolean };
  };
  assert.equal(policyPayload.projectPolicy.checked, true);
  assert.equal(policyPayload.projectPolicy.allowed, true);
  assert.equal(policyPayload.projectPolicy.exclusiveAllowedRoot, false);
  const nonGitComparison = await fetch(`${baseUrl}/api/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectPath: nonGitRoot,
      comparison: { mode: "base", base: "main" },
    }),
  });
  assert.equal(nonGitComparison.status, 400);
  assert.equal(
    (await nonGitComparison.json() as { error: { code: string } }).error.code,
    "COMPARISON_REQUIRES_GIT",
  );
});

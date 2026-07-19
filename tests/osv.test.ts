import assert from "node:assert/strict";
import test from "node:test";
import { lookupDependencyAdvisories } from "../src/integrations/osv.js";

const dependency = {
  ecosystem: "npm" as const,
  name: "sample-package",
  versionSpec: "1.2.3",
  pinning: "exact",
  sourcePath: "package.json",
};

test("OSV lookup is opt-in", async () => {
  const result = await lookupDependencyAdvisories([dependency], {
    enabled: false,
  });
  assert.equal(result.enabled, false);
  assert.equal(result.status, "disabled");
  assert.equal(result.queriedPackages, 0);
  assert.equal(result.coverage.totalDependencies, 1);
  assert.equal(result.coverage.exactVersionPackages, 1);
  assert.equal(result.coverage.skippedNonExact, 0);
});

test("OSV lookup maps matched advisories without relying on live network", async () => {
  const requests: string[] = [];
  const fetchImplementation: typeof fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/querybatch")) {
      return Response.json({ results: [{ vulns: [{ id: "OSV-TEST-1" }] }] });
    }
    return Response.json({
      id: "OSV-TEST-1",
      summary: "Synthetic advisory",
      aliases: ["CVE-0000-0000"],
      database_specific: { severity: "HIGH" },
      affected: [
        {
          package: { ecosystem: "npm", name: "sample-package" },
          ranges: [
            {
              type: "SEMVER",
              events: [{ introduced: "0" }, { fixed: "1.2.4" }],
            },
          ],
        },
      ],
    });
  };

  const result = await lookupDependencyAdvisories([dependency], {
    enabled: true,
    fetchImplementation,
  });
  assert.equal(result.queriedPackages, 1);
  assert.equal(result.status, "complete");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].severity, "high");
  assert.equal(result.findings[0].fixedVersion, "1.2.4");
  assert.equal(requests.length, 2);
});

test("OSV maps a valid top-level CVSS v3 vector and rejects malformed vectors", async () => {
  const cvssOnly = await lookupWithRecord(dependency, {
    id: "OSV-CVSS-ONLY",
    severity: [
      {
        type: "CVSS_V3",
        score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
      },
    ],
  });
  assert.equal(cvssOnly.findings[0]?.severity, "critical");

  const malformedWithFallback = await lookupWithRecord(dependency, {
    id: "OSV-CVSS-MALFORMED",
    severity: [
      {
        type: "CVSS_V3",
        score: "CVSS:3.1/AV:N/AC:L",
      },
    ],
    database_specific: { severity: "MEDIUM" },
  });
  assert.equal(malformedWithFallback.findings[0]?.severity, "medium");
});

test("OSV coverage distinguishes an unresolvable range from a clean query", async () => {
  const result = await lookupDependencyAdvisories(
    [
      {
        ...dependency,
        versionSpec: "^1.2.0",
        pinning: "range",
      },
    ],
    { enabled: true },
  );

  assert.equal(result.status, "not-applicable");
  assert.equal(result.queriedPackages, 0);
  assert.equal(result.coverage.exactVersionPackages, 0);
  assert.equal(result.coverage.skippedNonExact, 1);
  assert.match(result.diagnostics[0] ?? "", /no exact resolved dependency versions/iu);
});

test("OSV accepts exact Python pins and reports package query caps as partial", async () => {
  let batchBody: unknown;
  const fetchImplementation: typeof fetch = async (_input, init) => {
    batchBody = JSON.parse(String(init?.body));
    return Response.json({ results: [{ vulns: [] }] });
  };
  const result = await lookupDependencyAdvisories(
    [
      {
        ecosystem: "python",
        name: "python-library",
        versionSpec: "==2.4.1",
        pinning: "exact",
        sourcePath: "requirements.txt",
      },
      {
        ...dependency,
        name: "capped-library",
        versionSpec: "9.8.7",
      },
    ],
    {
      enabled: true,
      environment: { ...process.env, ATLAS_OSV_MAX_PACKAGES: "1" },
      fetchImplementation,
    },
  );

  assert.equal(result.status, "partial");
  assert.equal(result.coverage.exactVersionPackages, 2);
  assert.equal(result.coverage.cappedPackages, 1);
  assert.deepEqual(batchBody, {
    queries: [
      {
        version: "2.4.1",
        package: { ecosystem: "PyPI", name: "python-library" },
      },
    ],
  });
});

test("fixed versions are selected only from the queried affected package", async () => {
  const result = await lookupWithRecord(dependency, {
    id: "OSV-MULTI-PACKAGE",
    affected: [
      {
        package: { ecosystem: "npm", name: "unrelated-package" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "0" }, { fixed: "1.2.4" }],
          },
        ],
      },
      {
        package: { ecosystem: "npm", name: "sample-package" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "1.0.0" }, { fixed: "1.3.0" }],
          },
        ],
      },
    ],
  });

  assert.equal(result.findings[0]?.fixedVersion, "1.3.0");
});

test("fixed versions follow the vulnerable interval after reintroduction", async () => {
  const reintroducedDependency = { ...dependency, versionSpec: "3.1.0" };
  const record = {
    id: "OSV-REINTRODUCED",
    affected: [
      {
        package: { ecosystem: "npm", name: "sample-package" },
        ranges: [
          {
            type: "SEMVER",
            events: [
              { introduced: "1.0.0" },
              { fixed: "1.0.2" },
              { introduced: "3.0.0" },
              { fixed: "3.2.5" },
            ],
          },
        ],
      },
    ],
  };
  const result = await lookupWithRecord(reintroducedDependency, record);
  assert.equal(result.findings[0]?.fixedVersion, "3.2.5");

  const gap = await lookupWithRecord(
    { ...dependency, versionSpec: "2.0.0" },
    record,
  );
  assert.equal(gap.findings[0]?.fixedVersion, undefined);
});

test("OSV lookup fails with a clear diagnostic when the bounded deadline expires", async () => {
  const result = await lookupDependencyAdvisories([dependency], {
    enabled: true,
    environment: { ...process.env, ATLAS_OSV_TIMEOUT_MS: "20" },
    fetchImplementation: stalledFetch,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.findings.length, 0);
  assert.match(result.diagnostics[0] ?? "", /timed out after 20 ms/iu);
});

test("caller cancellation remains distinct from the OSV deadline", async () => {
  const controller = new AbortController();
  const resultPromise = lookupDependencyAdvisories([dependency], {
    enabled: true,
    environment: { ...process.env, ATLAS_OSV_TIMEOUT_MS: "1000" },
    fetchImplementation: stalledFetch,
    signal: controller.signal,
  });
  queueMicrotask(() =>
    controller.abort(new DOMException("Caller cancelled", "AbortError")),
  );
  const result = await resultPromise;

  assert.equal(result.status, "cancelled");
  assert.deepEqual(result.diagnostics, ["OSV lookup was cancelled."]);
});

async function lookupWithRecord(
  selectedDependency: typeof dependency,
  record: Record<string, unknown>,
) {
  const fetchImplementation: typeof fetch = async (input) =>
    String(input).endsWith("/querybatch")
      ? Response.json({ results: [{ vulns: [{ id: record.id }] }] })
      : Response.json(record);
  return lookupDependencyAdvisories([selectedDependency], {
    enabled: true,
    fetchImplementation,
  });
}

const stalledFetch: typeof fetch = async (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const rejectForAbort = () =>
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new DOMException("Request aborted", "AbortError"),
      );
    if (signal?.aborted) rejectForAbort();
    else signal?.addEventListener("abort", rejectForAbort, { once: true });
  });

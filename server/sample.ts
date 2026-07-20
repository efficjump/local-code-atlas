import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitChangeStatus, GitMetadata } from "../src/core/index.js";
import type { MigrationSnapshotOverride } from "../src/report/migration.js";

export function bundledSampleRoot(projectRoot: string): string {
  return join(projectRoot, "examples", "sample-project");
}

export async function loadBundledSampleGitSnapshots(
  projectRoot: string,
): Promise<MigrationSnapshotOverride[]> {
  const [before, after] = await Promise.all([
    readFile(
      join(projectRoot, "examples", "sample-baseline", "db", "schema.sql"),
      "utf8",
    ),
    readFile(
      join(projectRoot, "examples", "sample-project", "db", "schema.sql"),
      "utf8",
    ),
  ]);
  return [
    {
      path: "db/schema.sql",
      status: "modified",
      before,
      after,
    },
  ];
}

export async function loadBundledSampleGitMetadata(
  projectRoot: string,
): Promise<GitMetadata> {
  const sampleRoot = bundledSampleRoot(projectRoot);
  const scenarioPath = join(projectRoot, "examples", "sample-scenario.json");
  const supportedStatuses = new Set<GitChangeStatus>([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "untracked",
    "conflicted",
    "unknown",
  ]);
  const parsed = JSON.parse(await readFile(scenarioPath, "utf8")) as {
    branch?: unknown;
    changes?: unknown;
  };
  const changedFiles = Array.isArray(parsed.changes)
    ? parsed.changes.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const change = value as Record<string, unknown>;
        if (
          typeof change.path !== "string" ||
          typeof change.status !== "string" ||
          !supportedStatuses.has(change.status as GitChangeStatus)
        ) {
          return [];
        }
        return [
          {
            path: change.path.replaceAll("\\", "/").replace(/^\.\//u, ""),
            status: change.status as GitChangeStatus,
            staged: change.staged === true,
            unstaged: change.unstaged === true,
            additions:
              typeof change.additions === "number" ? change.additions : undefined,
            deletions:
              typeof change.deletions === "number" ? change.deletions : undefined,
          },
        ];
      })
    : [];
  return {
    isRepository: true,
    root: sampleRoot,
    branch: typeof parsed.branch === "string" ? parsed.branch : "demo",
    detached: false,
    dirty: changedFiles.some((change) => change.staged || change.unstaged),
    changedFiles,
  };
}

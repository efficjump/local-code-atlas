import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL("../server/cli.ts", import.meta.url));

test("CLI bundled sample uses the same migration baseline as the HTTP sample", async () => {
  const { stdout, stderr } = await execute(
    process.execPath,
    ["--import", "tsx", cliPath, "--sample", "--format", "json"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)) },
  );
  assert.equal(stderr, "");
  const report = JSON.parse(stdout) as {
    run: { partial: boolean };
    migration: {
      status: string;
      summary: { risks: number };
      risks: Array<{ label: string }>;
    };
  };

  assert.equal(report.run.partial, false);
  assert.equal(report.migration.status, "complete");
  assert.equal(report.migration.summary.risks, 3);
  assert.deepEqual(
    report.migration.risks.map((risk) => risk.label).sort(),
    [
      "set-not-null:sessions.expires_at",
      "set-not-null:users.display_name",
      "type-change:sessions.token",
    ],
  );
});

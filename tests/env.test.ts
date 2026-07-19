import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadLocalEnvironment } from "../server/env.js";

test("local environment precedence is shell, then .env.local, then .env", async (context) => {
  const root = await mkdtemp(join(os.tmpdir(), "local-code-atlas-env-"));
  const suffix = `${process.pid}_${Date.now()}`;
  const layeredKey = `ATLAS_TEST_LAYERED_${suffix}`;
  const inheritedKey = `ATLAS_TEST_INHERITED_${suffix}`;
  context.after(async () => {
    delete process.env[layeredKey];
    delete process.env[inheritedKey];
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([
    writeFile(
      join(root, ".env"),
      `${layeredKey}=base\n${inheritedKey}=base\n`,
    ),
    writeFile(
      join(root, ".env.local"),
      `${layeredKey}=local\n${inheritedKey}=local\n`,
    ),
  ]);
  process.env[inheritedKey] = "shell";

  loadLocalEnvironment(root);

  assert.equal(process.env[layeredKey], "local");
  assert.equal(process.env[inheritedKey], "shell");
});

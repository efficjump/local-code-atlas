import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSafeServerBinding,
  loadEngineConfig,
} from "../server/config.js";
import { PathPolicyError, resolveProjectPath } from "../server/path-policy.js";

test("resolves a project inside an allowed root", async () => {
  const root = await mkdtemp(join(tmpdir(), "atlas-path-"));
  const config = loadEngineConfig({
    NODE_ENV: "test",
    ATLAS_ALLOWED_ROOTS: root,
    HOME: root,
  });
  config.homeDirectory = join(root, "not-the-project");

  assert.equal(await resolveProjectPath(root, config), await realpath(root));
});

test("rejects a project outside configured roots", async () => {
  const allowed = await mkdtemp(join(tmpdir(), "atlas-allowed-"));
  const candidate = await mkdtemp(join(tmpdir(), "atlas-candidate-"));
  const config = loadEngineConfig({
    NODE_ENV: "test",
    ATLAS_ALLOWED_ROOTS: allowed,
  });

  await assert.rejects(resolveProjectPath(candidate, config), (error) => {
    assert.ok(error instanceof PathPolicyError);
    assert.equal(error.code, "PATH_OUTSIDE_ALLOWED_ROOTS");
    return true;
  });
});

test("expands home-relative paths but rejects process-relative paths", async () => {
  const home = await mkdtemp(join(tmpdir(), "atlas-home-"));
  const project = join(home, "projects", "sample");
  await mkdir(project, { recursive: true });
  const config = loadEngineConfig({ NODE_ENV: "test" });
  config.homeDirectory = home;

  assert.equal(
    await resolveProjectPath("~/projects/sample", config),
    await realpath(project),
  );
  await assert.rejects(resolveProjectPath("projects/sample", config), (error) => {
    assert.ok(error instanceof PathPolicyError);
    assert.equal(error.code, "PATH_NOT_ABSOLUTE");
    return true;
  });
});

test("non-loopback engines require an explicit allowed-root boundary", () => {
  assert.throws(
    () =>
      assertSafeServerBinding(loadEngineConfig({
        NODE_ENV: "test",
        ATLAS_HOST: "0.0.0.0",
      })),
    /ATLAS_ALLOWED_ROOTS is required/u,
  );
  assert.doesNotThrow(() =>
    assertSafeServerBinding(loadEngineConfig({
      NODE_ENV: "test",
      ATLAS_HOST: "0.0.0.0",
      ATLAS_ALLOWED_ROOTS: "/workspace/project",
    })),
  );
  assert.doesNotThrow(() =>
    assertSafeServerBinding(
      loadEngineConfig({ NODE_ENV: "test", ATLAS_HOST: "::1" }),
    ),
  );
  assert.doesNotThrow(() =>
    loadEngineConfig({ NODE_ENV: "test", ATLAS_HOST: "0.0.0.0" }),
  );
});

test("engine ports stay within the TCP port range", () => {
  assert.equal(loadEngineConfig({ NODE_ENV: "test", ATLAS_PORT: "5000" }).port, 5000);
  assert.equal(loadEngineConfig({ NODE_ENV: "test", ATLAS_PORT: "0" }).port, 4317);
  assert.equal(loadEngineConfig({ NODE_ENV: "test", ATLAS_PORT: "65536" }).port, 4317);
});

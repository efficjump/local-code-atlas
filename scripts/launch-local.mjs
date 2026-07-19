import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";

const arguments_ = process.argv.slice(2);
const noOpenIndex = arguments_.indexOf("--no-open");
const noOpen = noOpenIndex >= 0;
if (noOpen) arguments_.splice(noOpenIndex, 1);
if (arguments_.length > 1 || arguments_.some((argument) => argument.startsWith("-"))) {
  process.stderr.write("Usage: pnpm launch [project-path] [--no-open]\n");
  process.exitCode = 1;
} else {
  const requestedPath = resolve(arguments_[0] ?? process.cwd());
  const projectPath = await realpath(requestedPath).catch(() => undefined);
  const details = projectPath ? await stat(projectPath).catch(() => undefined) : undefined;
  if (!projectPath || !details?.isDirectory()) {
    process.stderr.write("Local Code Atlas: the project path is not a readable directory.\n");
    process.exitCode = 1;
  } else {
    try {
      await launch(projectPath, noOpen);
    } catch (error) {
      const message = error instanceof Error ? error.message : "launch failed";
      process.stderr.write(`Local Code Atlas: ${message}\n`);
      process.exitCode = 1;
    }
  }
}

async function launch(projectPath, noOpen) {
  const applicationRoot = resolve(import.meta.dirname, "..");
  loadLocalEnvironment(applicationRoot);
  const engineHost = process.env.ATLAS_HOST?.trim() || "127.0.0.1";
  if (engineHost !== "127.0.0.1" && engineHost !== "localhost") {
    throw new Error("pnpm launch requires ATLAS_HOST to be 127.0.0.1 or localhost");
  }
  const enginePort = Number.parseInt(process.env.ATLAS_PORT ?? "4317", 10);
  const effectiveEnginePort =
    Number.isSafeInteger(enginePort) && enginePort >= 1 && enginePort <= 65_535
      ? enginePort
      : 4317;
  const engineUrl = `http://${engineHost}:${effectiveEnginePort}`;
  const browserApiUrl = `${engineUrl}/api/analyze`;
  const workbenchBaseUrl = process.env.ATLAS_WEB_URL ?? "http://localhost:3000/";
  const workbenchUrl = new URL(workbenchBaseUrl);
  if (!isLoopbackHostname(workbenchUrl.hostname)) {
    throw new Error(
      "ATLAS_WEB_URL must use localhost or a loopback address before a local project path can be added to its URL",
    );
  }
  workbenchUrl.searchParams.set("project", projectPath);

  let child;
  const [engineStatus, workbenchStatus] = await Promise.all([
    enginePolicyStatus(engineUrl, projectPath, workbenchUrl.origin),
    workbenchIdentityStatus(workbenchBaseUrl, browserApiUrl),
  ]);
  assertExistingServiceIdentity(engineStatus, workbenchStatus);
  if (engineStatus.ready && !engineStatus.exclusiveAllowedRoot) {
    throw new Error(
      "an engine is already running without this project as its exclusive allowed root; stop it or choose another ATLAS_PORT before launching",
    );
  }
  const engineReady = engineStatus.ready;
  const workbenchReady = workbenchStatus.ready;
  if (!engineReady || !workbenchReady) {
    const script = engineReady
      ? "dev:web"
      : workbenchReady
        ? "dev:engine"
        : "dev";
    const pnpmCli = process.env.npm_execpath;
    const launchEnvironment = {
      ...process.env,
      ATLAS_ALLOWED_ROOTS: projectPath,
      ATLAS_ALLOWED_ORIGINS: workbenchUrl.origin,
      NEXT_PUBLIC_ATLAS_API_URL: browserApiUrl,
    };
    child = pnpmCli
      ? spawn(process.execPath, [pnpmCli, script], {
          cwd: applicationRoot,
          env: launchEnvironment,
          stdio: "inherit",
        })
      : spawn("pnpm", [script], {
          cwd: applicationRoot,
          env: launchEnvironment,
          stdio: "inherit",
        });
    child.once("exit", (code) => {
      if (code && !process.exitCode) process.exitCode = code;
    });
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [nextEngineStatus, nextWorkbenchStatus] = await Promise.all([
        enginePolicyStatus(engineUrl, projectPath, workbenchUrl.origin),
        workbenchIdentityStatus(workbenchBaseUrl, browserApiUrl),
      ]);
      if (
        (nextEngineStatus.reachable && !nextEngineStatus.ready) ||
        (nextWorkbenchStatus.reachable && !nextWorkbenchStatus.ready)
      ) {
        child.kill("SIGTERM");
        throw new Error("a configured local port became occupied by a different service");
      }
      if (nextEngineStatus.ready && !nextEngineStatus.exclusiveAllowedRoot) {
        child.kill("SIGTERM");
        throw new Error("the analyzer became ready with a different allowed-root policy");
      }
      if (nextEngineStatus.ready && nextWorkbenchStatus.ready) break;
      if (child.exitCode !== null) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
  }

  const [finalEngineStatus, finalWorkbenchStatus] = await Promise.all([
    enginePolicyStatus(engineUrl, projectPath, workbenchUrl.origin),
    workbenchIdentityStatus(workbenchBaseUrl, browserApiUrl),
  ]);
  if (
    !finalEngineStatus.ready ||
    !finalEngineStatus.exclusiveAllowedRoot ||
    !finalWorkbenchStatus.ready
  ) {
    child?.kill("SIGTERM");
    throw new Error("Local Code Atlas services did not become ready.");
  }

  process.stdout.write(`Local Code Atlas: ${workbenchUrl.href}\n`);
  if (!noOpen) await openBrowser(workbenchUrl.href);

  if (child) {
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
}

function loadLocalEnvironment(applicationRoot) {
  const inheritedKeys = new Set(Object.keys(process.env));
  const loaded = {};
  for (const fileName of [".env", ".env.local"]) {
    const path = join(applicationRoot, fileName);
    if (!existsSync(path)) continue;
    Object.assign(loaded, parseEnv(readFileSync(path, "utf8")));
  }
  for (const [key, value] of Object.entries(loaded)) {
    if (!inheritedKeys.has(key)) process.env[key] = value;
  }
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function assertExistingServiceIdentity(engineStatus, workbenchStatus) {
  if (engineStatus.reachable && !engineStatus.ready) {
    throw new Error("ATLAS_PORT is occupied by a service that is not Local Code Atlas");
  }
  if (workbenchStatus.reachable && !workbenchStatus.ready) {
    throw new Error("ATLAS_WEB_URL points to a service that is not the Local Code Atlas workbench");
  }
}

async function enginePolicyStatus(engineUrl, projectPath, workbenchOrigin) {
  try {
    const healthUrl = new URL("/api/health", engineUrl);
    healthUrl.searchParams.set("project", projectPath);
    const response = await fetch(healthUrl, {
      signal: AbortSignal.timeout(600),
    });
    const payload = await response.json().catch(() => undefined);
    const ready =
      response.ok &&
      payload?.service === "local-code-atlas-engine" &&
      payload?.status === "ok" &&
      typeof payload?.version === "string" &&
      payload?.external?.localByDefault === true &&
      typeof payload?.allowedRootsConfigured === "boolean" &&
      payload?.projectPolicy?.checked === true;
    if (!ready) {
      return { reachable: true, ready: false, exclusiveAllowedRoot: false };
    }
    const originResponse = await fetch(healthUrl, {
      headers: { Origin: workbenchOrigin },
      signal: AbortSignal.timeout(600),
    });
    const originPayload = await originResponse.json().catch(() => undefined);
    const originAllowed =
      originResponse.ok &&
      originPayload?.service === "local-code-atlas-engine" &&
      originPayload?.status === "ok";
    return {
      reachable: true,
      ready: ready && originAllowed,
      exclusiveAllowedRoot:
        originAllowed &&
        payload.projectPolicy.allowed === true &&
        payload.projectPolicy.exclusiveAllowedRoot === true,
    };
  } catch {
    return { reachable: false, ready: false, exclusiveAllowedRoot: false };
  }
}

async function workbenchIdentityStatus(url, expectedApiUrl) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(600) });
    const body = await response.text();
    return {
      reachable: true,
      ready:
        response.ok &&
        body.includes("data-atlas-workbench-version") &&
        body.includes(`data-atlas-api-url="${expectedApiUrl}"`),
    };
  } catch {
    return { reachable: false, ready: false };
  }
}

async function openBrowser(url) {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  await new Promise((resolveOpen) => {
    const opener = spawn(command.executable, command.args, {
      detached: true,
      stdio: "ignore",
    });
    opener.once("error", () => resolveOpen());
    opener.once("spawn", () => {
      opener.unref();
      resolveOpen();
    });
  });
}

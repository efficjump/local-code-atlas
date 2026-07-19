import { realpath, stat } from "node:fs/promises";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import type { EngineConfig } from "./config.js";

export class PathPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PathPolicyError";
    this.code = code;
  }
}

function isWithin(candidate: string, root: string): boolean {
  const offset = relative(root, candidate);
  return offset === "" || (!offset.startsWith("..") && !parse(offset).root);
}

export async function resolveProjectPath(
  input: string,
  config: EngineConfig,
): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new PathPolicyError("PATH_REQUIRED", "Enter a project directory.");
  }

  const expanded =
    trimmed === "~"
      ? config.homeDirectory
      : trimmed.startsWith(`~${sep}`) || trimmed.startsWith("~/") || trimmed.startsWith("~\\")
        ? resolve(config.homeDirectory, trimmed.slice(2))
        : trimmed;
  if (!isAbsolute(expanded)) {
    throw new PathPolicyError(
      "PATH_NOT_ABSOLUTE",
      "Enter an absolute project path, or use ~/project from your home directory.",
    );
  }

  let canonical: string;
  try {
    canonical = await realpath(resolve(expanded));
  } catch {
    throw new PathPolicyError(
      "PATH_NOT_FOUND",
      "The project directory does not exist or cannot be read.",
    );
  }

  const details = await stat(canonical);
  if (!details.isDirectory()) {
    throw new PathPolicyError(
      "PATH_NOT_DIRECTORY",
      "The selected project path must be a directory.",
    );
  }

  const volumeRoot = parse(canonical).root;
  const canonicalHome = await realpath(config.homeDirectory).catch(() =>
    resolve(config.homeDirectory),
  );
  if (canonical === volumeRoot || canonical === canonicalHome) {
    throw new PathPolicyError(
      "PATH_TOO_BROAD",
      "Choose a project directory instead of a filesystem or home root.",
    );
  }

  const allowedRoots = await Promise.all(
    config.allowedRoots.map((root) =>
      realpath(resolve(root)).catch(() => resolve(root)),
    ),
  );
  if (
    allowedRoots.length > 0 &&
    !allowedRoots.some((root) => isWithin(canonical, root))
  ) {
    throw new PathPolicyError(
      "PATH_OUTSIDE_ALLOWED_ROOTS",
      "The project is outside the roots allowed by this engine.",
    );
  }

  return canonical;
}

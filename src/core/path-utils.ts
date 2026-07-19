import path from "node:path";

/** Convert platform-specific separators to the stable form used in API output. */
export function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

export function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(toPosixPath(value)).replace(/^\.\//, "");
  return normalized === "." ? "" : normalized;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function safeRelativePath(root: string, candidate: string): string | undefined {
  if (!isPathInside(root, candidate)) return undefined;
  return normalizeRelativePath(path.relative(root, candidate));
}

export function extensionOf(filePath: string): string {
  const base = path.basename(filePath);
  const lower = base.toLowerCase();
  const compound = [
    ".d.ts",
    ".test.ts",
    ".test.tsx",
    ".spec.ts",
    ".spec.tsx",
    ".test.js",
    ".test.jsx",
    ".spec.js",
    ".spec.jsx",
    ".blade.php",
  ].find((suffix) => lower.endsWith(suffix));
  return compound ?? path.extname(lower);
}

export function splitIdentifier(value: string): string[] {
  return value
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => part.toLocaleLowerCase())
    .filter(Boolean);
}

export function stableUnique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

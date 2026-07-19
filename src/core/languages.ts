import path from "node:path";
import type { FileKind, LanguageDefinition } from "./types";

/** Declarative defaults; callers can extend or replace these definitions. */
export const DEFAULT_LANGUAGE_DEFINITIONS: readonly LanguageDefinition[] = [
  { id: "typescript", name: "TypeScript", extensions: [".ts", ".tsx", ".mts", ".cts"] },
  { id: "javascript", name: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { id: "python", name: "Python", extensions: [".py", ".pyi"], shebangPatterns: [/\bpython(?:3)?\b/i] },
  { id: "java", name: "Java", extensions: [".java"] },
  { id: "kotlin", name: "Kotlin", extensions: [".kt", ".kts"] },
  { id: "go", name: "Go", extensions: [".go"] },
  { id: "rust", name: "Rust", extensions: [".rs"] },
  { id: "csharp", name: "C#", extensions: [".cs"] },
  { id: "cpp", name: "C++", extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"] },
  { id: "c", name: "C", extensions: [".c", ".h"] },
  { id: "ruby", name: "Ruby", extensions: [".rb"], shebangPatterns: [/\bruby\b/i] },
  { id: "php", name: "PHP", extensions: [".php"] },
  { id: "swift", name: "Swift", extensions: [".swift"] },
  { id: "dart", name: "Dart", extensions: [".dart"] },
  { id: "scala", name: "Scala", extensions: [".scala", ".sc"] },
  { id: "elixir", name: "Elixir", extensions: [".ex", ".exs"] },
  { id: "shell", name: "Shell", extensions: [".sh", ".bash", ".zsh"], shebangPatterns: [/\b(?:ba|z|k)?sh\b/i] },
  { id: "sql", name: "SQL", extensions: [".sql"] },
  { id: "graphql", name: "GraphQL", extensions: [".graphql", ".gql"] },
  { id: "html", name: "HTML", extensions: [".html", ".htm"] },
  { id: "css", name: "CSS", extensions: [".css", ".scss", ".sass", ".less"] },
  { id: "json", name: "JSON", extensions: [".json", ".jsonc"] },
  { id: "yaml", name: "YAML", extensions: [".yaml", ".yml"] },
  { id: "toml", name: "TOML", extensions: [".toml"] },
  { id: "xml", name: "XML", extensions: [".xml", ".csproj", ".fsproj", ".vbproj"] },
  { id: "markdown", name: "Markdown", extensions: [".md", ".mdx"] },
  { id: "dockerfile", name: "Dockerfile", extensions: [], fileNames: ["Dockerfile", "Containerfile"] },
];

export function detectLanguage(
  filePath: string,
  firstLine?: string,
  definitions: readonly LanguageDefinition[] = DEFAULT_LANGUAGE_DEFINITIONS,
): LanguageDefinition | undefined {
  const name = path.basename(filePath);
  const extension = path.extname(name).toLowerCase();
  const lowerName = name.toLowerCase();

  for (const definition of definitions) {
    if (definition.fileNames?.some((candidate) => candidate.toLowerCase() === lowerName)) {
      return definition;
    }
    if (definition.extensions.some((candidate) => candidate.toLowerCase() === extension)) {
      return definition;
    }
  }

  if (firstLine?.startsWith("#!")) {
    return definitions.find((definition) =>
      definition.shebangPatterns?.some((pattern) => pattern.test(firstLine)),
    );
  }
  return undefined;
}

const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "pipfile",
  "poetry.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "go.mod",
  "cargo.toml",
  "composer.json",
  "gemfile",
  "mix.exs",
  "pubspec.yaml",
  "package.swift",
]);

const CONFIG_NAMES = /(^|\.)(config|rc)(\.|$)|^(dockerfile|containerfile|makefile)$/i;
const TEST_PATH = /(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\.[^.]+$/i;
const MIGRATION_PATH = /(^|\/)(migrations?|db\/migrate|changelog)(\/|$)/i;
const SCHEMA_NAME = /(^|\/)(schema|database|ddl)(\.[^/]+)?$/i;

export function isDependencyManifestPath(filePath: string): boolean {
  const name = path.basename(filePath.replace(/\\/g, "/")).toLowerCase();
  return (
    MANIFEST_NAMES.has(name) ||
    /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/iu.test(name) ||
    /^(?:requirements|constraints)(?:[-_.][^.]+)?\.txt$/iu.test(name) ||
    /\.(?:cs|fs|vb)proj$/iu.test(name)
  );
}

export function classifyFile(filePath: string, language?: string): FileKind {
  const normalized = filePath.replace(/\\/g, "/");
  const name = path.basename(normalized).toLowerCase();
  if (TEST_PATH.test(normalized)) return "test";
  if (MIGRATION_PATH.test(normalized)) return "migration";
  if (isDependencyManifestPath(normalized)) return "manifest";
  if (language === "sql" || SCHEMA_NAME.test(normalized)) return "schema";
  if (/^(readme|contributing|changelog|license)(\.|$)/i.test(name) || language === "markdown") {
    return "documentation";
  }
  if (CONFIG_NAMES.test(name) || /(^|\/)(\.github|config)(\/|$)/i.test(normalized)) {
    return "configuration";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "ico", "woff", "woff2", "ttf", "svg"].includes(name.split(".").at(-1) ?? "")) {
    return "asset";
  }
  return language ? "source" : "unknown";
}

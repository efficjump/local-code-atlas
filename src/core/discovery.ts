import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_LANGUAGE_DEFINITIONS } from "./languages";
import { comparePaths, stableUnique } from "./path-utils";
import {
  classifySourceScope,
  sourceScopeIncluded,
  type SourceScopeClassificationOptions,
} from "./source-scope";
import type {
  DetectionEvidence,
  FrameworkDetection,
  FrameworkRule,
  LanguageDefinition,
  ManifestSummary,
  ProjectDiscovery,
  ScanResult,
  ScannedFile,
  SourceScope,
} from "./types";

export const DEFAULT_FRAMEWORK_RULES: readonly FrameworkRule[] = [
  { id: "nextjs", name: "Next.js", category: "web", dependencyNames: ["next"], fileNames: ["next.config.js", "next.config.mjs", "next.config.ts"] },
  { id: "react", name: "React", category: "ui", dependencyNames: ["react", "react-dom"] },
  { id: "vue", name: "Vue", category: "ui", dependencyNames: ["vue", "nuxt"] },
  { id: "svelte", name: "Svelte", category: "ui", dependencyNames: ["svelte", "@sveltejs/kit"] },
  { id: "angular", name: "Angular", category: "ui", dependencyNames: ["@angular/core"], fileNames: ["angular.json"] },
  { id: "express", name: "Express", category: "api", dependencyNames: ["express"] },
  { id: "nestjs", name: "NestJS", category: "api", dependencyNames: ["@nestjs/core"], fileNames: ["nest-cli.json"] },
  { id: "fastify", name: "Fastify", category: "api", dependencyNames: ["fastify"] },
  { id: "hono", name: "Hono", category: "api", dependencyNames: ["hono"] },
  { id: "django", name: "Django", category: "web", dependencyNames: ["django"], fileNames: ["manage.py"] },
  { id: "flask", name: "Flask", category: "api", dependencyNames: ["flask"] },
  { id: "fastapi", name: "FastAPI", category: "api", dependencyNames: ["fastapi"] },
  { id: "spring", name: "Spring", category: "web", dependencyNames: ["spring-boot*", "org.springframework*"], contentPatterns: [/org\.springframework\.boot/u] },
  { id: "rails", name: "Ruby on Rails", category: "web", dependencyNames: ["rails"], fileNames: ["config/application.rb"] },
  { id: "laravel", name: "Laravel", category: "web", dependencyNames: ["laravel/framework"], fileNames: ["artisan"] },
  { id: "aspnet", name: "ASP.NET Core", category: "web", dependencyNames: ["microsoft.aspnetcore*"], contentPatterns: [/Microsoft\.NET\.Sdk\.Web/u] },
  { id: "gin", name: "Gin", category: "api", dependencyNames: ["github.com/gin-gonic/gin"] },
  { id: "axum", name: "Axum", category: "api", dependencyNames: ["axum"] },
  { id: "drizzle", name: "Drizzle ORM", category: "orm", dependencyNames: ["drizzle-orm"], fileNames: ["drizzle.config.ts", "drizzle.config.js"] },
  { id: "prisma", name: "Prisma", category: "orm", dependencyNames: ["prisma", "@prisma/client"], fileNames: ["schema.prisma"] },
  { id: "typeorm", name: "TypeORM", category: "orm", dependencyNames: ["typeorm"] },
  { id: "sequelize", name: "Sequelize", category: "orm", dependencyNames: ["sequelize"] },
  { id: "sqlalchemy", name: "SQLAlchemy", category: "orm", dependencyNames: ["sqlalchemy"] },
  { id: "hibernate", name: "Hibernate", category: "orm", dependencyNames: ["hibernate-core", "org.hibernate*"] },
  { id: "vitest", name: "Vitest", category: "test", dependencyNames: ["vitest"], fileNames: ["vitest.config.ts", "vitest.config.js"] },
  { id: "jest", name: "Jest", category: "test", dependencyNames: ["jest"], fileNames: ["jest.config.js", "jest.config.ts"] },
  { id: "pytest", name: "pytest", category: "test", dependencyNames: ["pytest"], fileNames: ["pytest.ini"] },
  { id: "junit", name: "JUnit", category: "test", dependencyNames: ["junit*", "org.junit*"] },
  { id: "flutter", name: "Flutter", category: "mobile", dependencyNames: ["flutter"], fileNames: ["pubspec.yaml"] },
];

interface DatabaseRule {
  name: string;
  dependencyNames: readonly string[];
  filePatterns?: readonly RegExp[];
}

const DATABASE_RULES: readonly DatabaseRule[] = [
  { name: "PostgreSQL", dependencyNames: ["pg", "postgres", "postgresql", "psycopg*", "npgsql", "org.postgresql*"], filePatterns: [/postgres(?:ql)?/i] },
  { name: "MySQL", dependencyNames: ["mysql", "mysql2", "pymysql", "mysqlclient", "mysqlconnector*"], filePatterns: [/mysql/i] },
  { name: "SQLite", dependencyNames: ["sqlite*", "better-sqlite3", "aiosqlite", "microsoft.data.sqlite"], filePatterns: [/\.sqlite3?$/i, /\.db$/i] },
  { name: "MongoDB", dependencyNames: ["mongodb", "mongoose", "pymongo", "mongoengine", "mongodb.driver*"], filePatterns: [/mongo/i] },
  { name: "Redis", dependencyNames: ["redis", "ioredis", "jedis", "stackexchange.redis"], filePatterns: [/redis/i] },
  { name: "SQL Server", dependencyNames: ["mssql", "tedious", "microsoft.data.sqlclient"], filePatterns: [/sqlserver/i] },
];

export interface DiscoveryOptions {
  signal?: AbortSignal;
  languageDefinitions?: readonly LanguageDefinition[];
  frameworkRules?: readonly FrameworkRule[];
  extendFrameworkRules?: readonly FrameworkRule[];
  projectName?: string;
  maxManifestBytes?: number;
  /** Production evidence is the default; use `all` for repository archaeology. */
  sourceScope?: "production" | "all" | readonly SourceScope[];
  sourceScopeRules?: SourceScopeClassificationOptions["rules"];
  extendSourceScopeRules?: SourceScopeClassificationOptions["extendRules"];
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

function normalizeDependency(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function parseManifest(file: ScannedFile, text: string): { summary?: ManifestSummary; projectName?: string } {
  const name = path.basename(file.path).toLowerCase();
  let ecosystem: string | undefined;
  let projectName: string | undefined;
  let dependencies: string[] = [];

  if (name === "package.json" || name === "composer.json") {
    const data = safeJson(text);
    if (!data) return {};
    ecosystem = name === "package.json" ? "npm" : "composer";
    dependencies = [
      ...objectKeys(data.dependencies),
      ...objectKeys(data.devDependencies),
      ...objectKeys(data.peerDependencies),
      ...objectKeys(data.optionalDependencies),
      ...objectKeys(data.require),
      ...objectKeys(data["require-dev"]),
    ];
    if (typeof data.name === "string" && data.name.trim()) projectName = data.name.trim();
  } else if (name === "requirements.txt") {
    ecosystem = "python";
    dependencies = text
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+#.*$/u, "").trim())
      .filter((line) => Boolean(line) && !line.startsWith("-") && !line.includes("://"))
      .map((line) => line.split(/\s*(?:===|==|~=|>=|<=|!=|>|<|@|\[)/u, 1)[0]);
  } else if (name === "pyproject.toml") {
    ecosystem = "python";
    dependencies = [...text.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(?:["'{\[])/gmu)].map((match) => match[1]);
    projectName = text.match(/^\s*name\s*=\s*["']([^"']+)["']/mu)?.[1];
  } else if (name === "cargo.toml") {
    ecosystem = "cargo";
    const dependencySections = text.matchAll(/^\[(?:dev-|build-)?dependencies(?:\.[^\]]+)?\]([\s\S]*?)(?=^\[|\s*$)/gmu);
    for (const section of dependencySections) {
      dependencies.push(...[...section[1].matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gmu)].map((match) => match[1]));
    }
    projectName = text.match(/^\s*name\s*=\s*["']([^"']+)["']/mu)?.[1];
  } else if (name === "go.mod") {
    ecosystem = "go";
    projectName = text.match(/^module\s+(\S+)/mu)?.[1]?.split("/").at(-1);
    dependencies = [...text.matchAll(/^\s*([^\s()]+)\s+v\d/gmu)].map((match) => match[1]);
  } else if (name === "pom.xml") {
    ecosystem = "maven";
    dependencies = [...text.matchAll(/<artifactId>\s*([^<\s]+)\s*<\/artifactId>/gu)].map((match) => match[1]);
    projectName = text.match(/<name>\s*([^<]+)\s*<\/name>/u)?.[1]?.trim();
  } else if (name === "build.gradle" || name === "build.gradle.kts") {
    ecosystem = "gradle";
    dependencies = [...text.matchAll(/["']([A-Za-z0-9_.-]+):([A-Za-z0-9_.-]+):[^"']+["']/gu)].flatMap((match) => [`${match[1]}:${match[2]}`, match[2]]);
  } else if (/\.(?:cs|fs|vb)proj$/i.test(name)) {
    ecosystem = "nuget";
    dependencies = [...text.matchAll(/<PackageReference\s+Include=["']([^"']+)["']/giu)].map((match) => match[1]);
    projectName = path.basename(file.path, path.extname(file.path));
  } else if (name === "gemfile") {
    ecosystem = "bundler";
    dependencies = [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gmu)].map((match) => match[1]);
  } else if (name === "mix.exs") {
    ecosystem = "mix";
    dependencies = [...text.matchAll(/\{\s*:([A-Za-z0-9_]+)/gu)].map((match) => match[1]);
  } else if (name === "pubspec.yaml") {
    ecosystem = "pub";
    const sections = [...text.matchAll(/^(?:dev_)?dependencies:\s*\n((?:[ \t]+[^\n]+\n?)*)/gmu)];
    dependencies = sections.flatMap((section) => [...section[1].matchAll(/^\s{2,}([A-Za-z0-9_-]+):/gmu)].map((match) => match[1]));
    projectName = text.match(/^name:\s*([^\s#]+)/mu)?.[1];
  } else {
    return {};
  }

  return {
    summary: {
      path: file.path,
      ecosystem,
      dependencyNames: stableUnique(dependencies.map(normalizeDependency).filter(Boolean)).sort(comparePaths),
    },
    projectName,
  };
}

function dependencyMatches(candidate: string, pattern: string): boolean {
  const normalizedCandidate = normalizeDependency(candidate);
  const normalizedPattern = normalizeDependency(pattern);
  return normalizedPattern.endsWith("*")
    ? normalizedCandidate.startsWith(normalizedPattern.slice(0, -1))
    : normalizedCandidate === normalizedPattern;
}

function confidenceFor(score: number): FrameworkDetection["confidence"] {
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function detectPackageManagers(files: readonly ScannedFile[], manifests: readonly ManifestSummary[]): string[] {
  const fileNames = new Set(files.map((file) => path.basename(file.path).toLowerCase()));
  const found: string[] = [];
  const signals: readonly [string, readonly string[]][] = [
    ["pnpm", ["pnpm-lock.yaml", "pnpm-workspace.yaml"]],
    ["Yarn", ["yarn.lock"]],
    ["npm", ["package-lock.json"]],
    ["Bun", ["bun.lock", "bun.lockb"]],
    ["Poetry", ["poetry.lock"]],
    ["uv", ["uv.lock"]],
    ["pip", ["requirements.txt"]],
    ["Maven", ["pom.xml"]],
    ["Gradle", ["gradlew", "build.gradle", "build.gradle.kts"]],
    ["Cargo", ["cargo.lock"]],
    ["Go modules", ["go.sum", "go.mod"]],
    ["Bundler", ["gemfile.lock"]],
    ["Composer", ["composer.lock"]],
    ["NuGet", ["packages.lock.json"]],
  ];
  for (const [manager, names] of signals) {
    if (names.some((name) => fileNames.has(name))) found.push(manager);
  }
  if (found.length === 0) {
    const ecosystems = new Set(manifests.map((manifest) => manifest.ecosystem));
    if (ecosystems.has("npm")) found.push("npm-compatible");
    if (ecosystems.has("python")) found.push("Python package manager");
  }
  return found;
}

function detectBuildSystems(files: readonly ScannedFile[]): string[] {
  const names = new Set(files.map((file) => path.basename(file.path).toLowerCase()));
  const signals: readonly [string, readonly string[]][] = [
    ["Vite", ["vite.config.ts", "vite.config.js", "vite.config.mjs"]],
    ["Webpack", ["webpack.config.js", "webpack.config.ts"]],
    ["Turborepo", ["turbo.json"]],
    ["Nx", ["nx.json"]],
    ["Make", ["makefile"]],
    ["CMake", ["cmakelists.txt"]],
    ["Maven", ["pom.xml"]],
    ["Gradle", ["build.gradle", "build.gradle.kts"]],
    ["Cargo", ["cargo.toml"]],
    ["Go toolchain", ["go.mod"]],
    ["MSBuild", ["directory.build.props"]],
  ];
  return signals.filter(([, candidates]) => candidates.some((name) => names.has(name))).map(([name]) => name);
}

export async function discoverProject(
  scan: ScanResult,
  options: DiscoveryOptions = {},
): Promise<ProjectDiscovery> {
  options.signal?.throwIfAborted();
  const scopeSelection = options.sourceScope ?? "production";
  const sourceScopeFor = (file: ScannedFile): SourceScope =>
    options.sourceScopeRules || options.extendSourceScopeRules
      ? classifySourceScope(
          { path: file.path, kind: file.kind },
          {
            rules: options.sourceScopeRules,
            extendRules: options.extendSourceScopeRules,
          },
        )
      : file.sourceScope ?? classifySourceScope({ path: file.path, kind: file.kind });
  const discoveryFiles = scan.files.filter((file) =>
    sourceScopeIncluded(sourceScopeFor(file), scopeSelection),
  );
  const definitions = options.languageDefinitions ?? DEFAULT_LANGUAGE_DEFINITIONS;
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  const totalLanguageBytes = discoveryFiles.filter((file) => file.language).reduce((sum, file) => sum + file.sizeBytes, 0);
  const languageBuckets = new Map<string, { files: number; lines: number; bytes: number }>();
  for (const file of discoveryFiles) {
    options.signal?.throwIfAborted();
    if (!file.language) continue;
    const bucket = languageBuckets.get(file.language) ?? { files: 0, lines: 0, bytes: 0 };
    bucket.files += 1;
    bucket.lines += file.lineCount ?? 0;
    bucket.bytes += file.sizeBytes;
    languageBuckets.set(file.language, bucket);
  }
  const languages = [...languageBuckets.entries()]
    .map(([id, bucket]) => ({
      id,
      name: definitionById.get(id)?.name ?? id,
      fileCount: bucket.files,
      lineCount: bucket.lines,
      bytes: bucket.bytes,
      percentage: totalLanguageBytes === 0 ? 0 : Math.round((bucket.bytes / totalLanguageBytes) * 1_000) / 10,
    }))
    .sort((a, b) => b.bytes - a.bytes || comparePaths(a.name, b.name));

  const manifests: ManifestSummary[] = [];
  const manifestTexts = new Map<string, string>();
  const projectNameCandidates: { name: string; path: string }[] = [];
  const maxManifestBytes = Math.max(4_096, options.maxManifestBytes ?? 512 * 1024);
  for (const file of discoveryFiles) {
    if (
      file.isBinary ||
      file.sizeBytes > maxManifestBytes ||
      !isDiscoveryMetadataFile(file)
    ) continue;
    try {
      const text = await fs.readFile(file.absolutePath, "utf8");
      manifestTexts.set(file.path, text);
      const parsed = parseManifest(file, text);
      if (parsed.summary) {
        manifests.push({
          ...parsed.summary,
          sourceScope: sourceScopeFor(file),
        });
      }
      if (parsed.projectName) {
        projectNameCandidates.push({ name: parsed.projectName, path: file.path });
      }
    } catch {
      // Scanner warnings already describe inaccessible files; discovery remains best effort.
    }
  }
  manifests.sort((a, b) => comparePaths(a.path, b.path));
  projectNameCandidates.sort(
    (left, right) =>
      pathDepth(left.path) - pathDepth(right.path) ||
      comparePaths(left.path, right.path),
  );
  const detectedProjectName = projectNameCandidates[0]?.name;
  const dependencies = stableUnique(manifests.flatMap((manifest) => manifest.dependencyNames));
  const dependencyDeclarations = manifests.flatMap((manifest) =>
    manifest.dependencyNames.map((dependency) => ({ dependency, manifest })),
  );
  const filesByBaseName = new Map<string, string[]>();
  for (const file of discoveryFiles) {
    const base = path.basename(file.path).toLowerCase();
    filesByBaseName.set(base, [...(filesByBaseName.get(base) ?? []), file.path]);
  }

  const rules = options.frameworkRules ?? [
    ...DEFAULT_FRAMEWORK_RULES,
    ...(options.extendFrameworkRules ?? []),
  ];
  const frameworks: FrameworkDetection[] = [];
  for (const rule of rules) {
    options.signal?.throwIfAborted();
    const evidence: DetectionEvidence[] = [];
    for (const dependencyPattern of rule.dependencyNames ?? []) {
      const match = dependencyDeclarations.find(({ dependency }) =>
        dependencyMatches(dependency, dependencyPattern),
      );
      if (match) {
        evidence.push({
          kind: "dependency",
          path: match.manifest.path,
          sourceScope: match.manifest.sourceScope,
          detail: `Dependency "${match.dependency}" is declared.`,
        });
      }
    }
    for (const fileName of rule.fileNames ?? []) {
      const exactPath = discoveryFiles.find((file) => file.path.toLowerCase() === fileName.toLowerCase());
      const matchingPath = exactPath?.path ?? filesByBaseName.get(path.basename(fileName).toLowerCase())?.[0];
      if (matchingPath) {
        const matchedFile = discoveryFiles.find((file) => file.path === matchingPath);
        evidence.push({
          kind: "file",
          path: matchingPath,
          sourceScope: matchedFile ? sourceScopeFor(matchedFile) : undefined,
          detail: "A framework-specific file is present.",
        });
      }
    }
    if (rule.fileExtensions?.length) {
      const matchingFile = discoveryFiles.find((file) => rule.fileExtensions?.some((extension) => file.path.toLowerCase().endsWith(extension.toLowerCase())));
      if (matchingFile) evidence.push({ kind: "file", path: matchingFile.path, sourceScope: sourceScopeFor(matchingFile), detail: "A framework-specific file type is present." });
    }
    for (const pattern of rule.contentPatterns ?? []) {
      const matchingEntry = [...manifestTexts.entries()].find(([, text]) => {
        pattern.lastIndex = 0;
        return pattern.test(text);
      });
      if (matchingEntry) {
        const matchedFile = discoveryFiles.find((file) => file.path === matchingEntry[0]);
        evidence.push({ kind: "content", path: matchingEntry[0], sourceScope: matchedFile ? sourceScopeFor(matchedFile) : undefined, detail: "A framework-specific manifest declaration is present." });
      }
    }
    if (evidence.length === 0) continue;
    const score = evidence.reduce((sum, item) => sum + (item.kind === "dependency" ? 3 : 2), 0);
    frameworks.push({
      id: rule.id,
      name: rule.name,
      category: rule.category,
      confidence: confidenceFor(score),
      evidence: evidence.slice(0, 5),
    });
  }
  frameworks.sort((a, b) => {
    const rank = { high: 3, medium: 2, low: 1 };
    return rank[b.confidence] - rank[a.confidence] || comparePaths(a.name, b.name);
  });

  const databases = DATABASE_RULES.filter((rule) =>
    rule.dependencyNames.some((pattern) => dependencies.some((dependency) => dependencyMatches(dependency, pattern))) ||
    rule.filePatterns?.some((pattern) => discoveryFiles.some((file) => pattern.test(file.path))),
  ).map((rule) => rule.name);

  return {
    root: scan.root,
    name: options.projectName?.trim() || detectedProjectName || path.basename(scan.root),
    languages,
    frameworks,
    manifests,
    packageManagers: detectPackageManagers(discoveryFiles, manifests),
    buildSystems: detectBuildSystems(discoveryFiles),
    databases,
  };
}

function pathDepth(filePath: string): number {
  return filePath.replaceAll("\\", "/").split("/").length - 1;
}

function isDiscoveryMetadataFile(file: ScannedFile): boolean {
  if (file.kind === "manifest" || file.kind === "configuration") return true;
  const name = path.basename(file.path).toLocaleLowerCase();
  return (
    /^(?:package|composer)\.json$/u.test(name) ||
    /^(?:requirements(?:[-_.][^.]+)?\.txt|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|gemfile|mix\.exs|pubspec\.yaml)$/u.test(
      name,
    ) ||
    /\.(?:cs|fs|vb)proj$/u.test(name)
  );
}

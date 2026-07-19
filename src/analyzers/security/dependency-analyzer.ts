import type {
  AnalysisFile,
  AnalyzerContext,
  FileAnalyzer,
} from "../types";
import {
  basename,
  confidence,
  provenance,
  stableId,
} from "../source";
import type {
  DependencyEcosystem,
  DependencyInventoryItem,
  DependencyPinning,
  SecurityFinding,
  SecurityObservation,
} from "./types";

export type DependencyResolutionSource = "manifest" | "lockfile";

declare module "./types" {
  interface DependencyInventoryItem {
    /** Whether the reported version came from a declaration or a resolved lock entry. */
    resolutionSource?: DependencyResolutionSource;
    /** The selector from the manifest when versionSpec contains a lockfile resolution. */
    declaredVersionSpec?: string;
    /** Pinning semantics of declaredVersionSpec. */
    declaredPinning?: DependencyPinning;
    /** Lockfile that supplied versionSpec. */
    lockfilePath?: string;
  }
}

export interface DependencyManifestParser {
  readonly id: string;
  readonly ecosystem: DependencyEcosystem;
  supports(file: AnalysisFile): boolean;
  parse(
    file: AnalysisFile,
    context?: AnalyzerContext,
  ): readonly DependencyInventoryItem[];
}

export class DependencyManifestAnalyzer
  implements FileAnalyzer<SecurityObservation>
{
  readonly id = "security.dependencies";
  readonly domain = "security" as const;
  readonly #parsers: readonly DependencyManifestParser[];

  constructor(
    parsers: readonly DependencyManifestParser[] = DEFAULT_DEPENDENCY_PARSERS,
  ) {
    this.#parsers = parsers;
  }

  supports(file: AnalysisFile): boolean {
    return this.#parsers.some((parser) => parser.supports(file));
  }

  analyze(
    file: AnalysisFile,
    context: AnalyzerContext,
  ): readonly SecurityObservation[] {
    const observations: SecurityObservation[] = [];
    for (const parser of this.#parsers) {
      if (!parser.supports(file)) continue;
      for (const dependency of parser.parse(file, context)) {
        observations.push(dependency);
        const risk = dependencyRisk(dependency);
        if (risk) observations.push(risk);
      }
    }
    return observations;
  }
}

export const DEFAULT_DEPENDENCY_PARSERS: readonly DependencyManifestParser[] = [
  {
    id: "npm-package-json",
    ecosystem: "npm",
    supports: (file) => basename(file.path).toLowerCase() === "package.json",
    parse: (file, context) =>
      hasUsableSelectedNpmLock(file, context?.files ?? [])
        ? []
        : parsePackageJson(file),
  },
  {
    id: "npm-package-lock",
    ecosystem: "npm",
    supports: (file) => basename(file.path).toLowerCase() === "package-lock.json",
    parse: (file, context) => parseSelectedNpmLock(file, context?.files ?? []).items,
  },
  {
    id: "pnpm-lock",
    ecosystem: "npm",
    supports: (file) => basename(file.path).toLowerCase() === "pnpm-lock.yaml",
    parse: (file, context) => parseSelectedNpmLock(file, context?.files ?? []).items,
  },
  {
    id: "yarn-lock",
    ecosystem: "npm",
    supports: (file) => basename(file.path).toLowerCase() === "yarn.lock",
    parse: (file, context) => parseSelectedNpmLock(file, context?.files ?? []).items,
  },
  {
    id: "python-requirements",
    ecosystem: "python",
    supports: (file) =>
      /^(?:requirements(?:[-_.][^.]+)?\.txt|constraints(?:[-_.][^.]+)?\.txt)$/i.test(
        basename(file.path),
      ),
    parse: parseRequirements,
  },
  {
    id: "python-pyproject",
    ecosystem: "python",
    supports: (file) => basename(file.path).toLowerCase() === "pyproject.toml",
    parse: parsePyproject,
  },
  {
    id: "maven-pom",
    ecosystem: "maven",
    supports: (file) => basename(file.path).toLowerCase() === "pom.xml",
    parse: parseMaven,
  },
  {
    id: "gradle-build",
    ecosystem: "gradle",
    supports: (file) => /^(?:build|settings)\.gradle(?:\.kts)?$/i.test(basename(file.path)),
    parse: parseGradle,
  },
  {
    id: "cargo-manifest",
    ecosystem: "cargo",
    supports: (file) => basename(file.path).toLowerCase() === "cargo.toml",
    parse: parseCargo,
  },
  {
    id: "go-mod",
    ecosystem: "go",
    supports: (file) => basename(file.path).toLowerCase() === "go.mod",
    parse: parseGoMod,
  },
];

function parsePackageJson(file: AnalysisFile): readonly DependencyInventoryItem[] {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(file.content) as Record<string, unknown>;
  } catch {
    return [];
  }
  const sections = [
    ["dependencies", "runtime"],
    ["devDependencies", "development"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ] as const;
  const items: DependencyInventoryItem[] = [];
  for (const [sectionName, scope] of sections) {
    const section = manifest[sectionName];
    if (!isStringRecord(section)) continue;
    const sectionOffset = file.content.indexOf(`"${sectionName}"`);
    for (const [name, rawSpec] of Object.entries(section)) {
      const spec = sanitizeSpec(rawSpec);
      const location = locateJsonProperty(file, name, Math.max(0, sectionOffset));
      items.push(
        dependencyItem(
          file,
          "npm",
          name,
          spec,
          scope,
          classifyNpmSpec(spec),
          location.start,
          location.end,
        ),
      );
    }
  }
  return items;
}

interface ParsedNpmLock {
  valid: boolean;
  items: DependencyInventoryItem[];
}

interface DirectDependencyDeclaration {
  name: string;
  spec: string;
  scope: string;
  pinning: DependencyPinning;
}

interface ResolvedNpmDependency {
  name: string;
  version: string;
  sourceToken: string;
  direct?: DirectDependencyDeclaration;
}

function hasUsableSelectedNpmLock(
  manifest: AnalysisFile,
  files: readonly AnalysisFile[],
): boolean {
  const lockfile = selectedNpmLockForManifest(manifest, files);
  return lockfile ? parseSelectedNpmLock(lockfile, files).valid : false;
}

function parseSelectedNpmLock(
  lockfile: AnalysisFile,
  files: readonly AnalysisFile[],
): ParsedNpmLock {
  const npmManifests = files.filter(
    (candidate) => basename(candidate.path).toLowerCase() === "package.json",
  );
  const selectedManifests = npmManifests.filter(
    (manifest) => selectedNpmLockForManifest(manifest, files)?.path === lockfile.path,
  );

  // A stale second lockfile beside an actively selected one should not double the
  // inventory. A standalone lockfile is still useful when no manifest was scanned.
  if (npmManifests.length > 0 && selectedManifests.length === 0) {
    return { valid: true, items: [] };
  }

  const name = basename(lockfile.path).toLowerCase();
  if (name === "package-lock.json") return parsePackageLock(lockfile);
  if (name === "pnpm-lock.yaml") return parsePnpmLock(lockfile);
  if (name === "yarn.lock") return parseYarnLock(lockfile, selectedManifests);
  return { valid: false, items: [] };
}

function selectedNpmLockForManifest(
  manifest: AnalysisFile,
  files: readonly AnalysisFile[],
): AnalysisFile | undefined {
  const manifestDirectory = pathDirectory(manifest.path);
  const candidates = files
    .filter((candidate) => isNpmLockfile(candidate.path))
    .filter((candidate) => isPathWithin(manifestDirectory, pathDirectory(candidate.path)));
  if (candidates.length === 0) return undefined;

  const packageManager = packageManagerForManifest(manifest);
  return candidates.sort((left, right) => {
    const directoryDistance =
      pathDepth(pathDirectory(right.path)) - pathDepth(pathDirectory(left.path));
    if (directoryDistance !== 0) return directoryDistance;
    const managerDifference =
      lockfilePreference(left.path, packageManager) -
      lockfilePreference(right.path, packageManager);
    return managerDifference || left.path.localeCompare(right.path);
  })[0];
}

function packageManagerForManifest(file: AnalysisFile): string | undefined {
  try {
    const value = (JSON.parse(file.content) as { packageManager?: unknown }).packageManager;
    return typeof value === "string"
      ? value.slice(0, value.indexOf("@") > 0 ? value.indexOf("@") : undefined).toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

function lockfilePreference(path: string, packageManager?: string): number {
  const name = basename(path).toLowerCase();
  const manager =
    name === "pnpm-lock.yaml" ? "pnpm" : name === "yarn.lock" ? "yarn" : "npm";
  if (packageManager) return manager === packageManager ? 0 : 10;
  return name === "package-lock.json" ? 0 : name === "pnpm-lock.yaml" ? 1 : 2;
}

function isNpmLockfile(path: string): boolean {
  return /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(basename(path));
}

function normalizedPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function pathDirectory(path: string): string {
  const normalized = normalizedPath(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? "" : normalized.slice(0, slash);
}

function pathDepth(path: string): number {
  return path ? normalizedPath(path).split("/").length : 0;
}

function isPathWithin(child: string, parent: string): boolean {
  const normalizedChild = normalizedPath(child);
  const normalizedParent = normalizedPath(parent);
  return (
    !normalizedParent ||
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}/`)
  );
}

function manifestDeclarations(file: AnalysisFile): DirectDependencyDeclaration[] {
  return parsePackageJson(file).map((dependency) => ({
    name: dependency.name,
    spec: dependency.versionSpec,
    scope: dependency.scope,
    pinning: dependency.pinning,
  }));
}

function parsePackageLock(file: AnalysisFile): ParsedNpmLock {
  let lock: Record<string, unknown>;
  try {
    lock = JSON.parse(file.content) as Record<string, unknown>;
  } catch {
    return { valid: false, items: [] };
  }

  const packages = asRecord(lock.packages);
  const legacyDependencies = asRecord(lock.dependencies);
  const recognized =
    typeof lock.lockfileVersion === "number" ||
    typeof lock.lockfileVersion === "string" ||
    packages !== undefined ||
    legacyDependencies !== undefined;
  if (!recognized) return { valid: false, items: [] };

  if (packages) {
    const declarations = packageLockDeclarations(packages);
    const resolved: Array<ResolvedNpmDependency & { packagePath: string }> = [];
    for (const [packagePath, value] of Object.entries(packages)) {
      if (!packagePath.includes("node_modules/")) continue;
      const metadata = asRecord(value);
      const version = stringValue(metadata?.version);
      const name = packageLockPackageName(packagePath, stringValue(metadata?.name));
      if (!version || !name) continue;
      resolved.push({ name, version, sourceToken: packagePath, packagePath });
    }

    const versionsPerName = new Map<string, number>();
    for (const dependency of resolved) {
      versionsPerName.set(
        dependency.name,
        (versionsPerName.get(dependency.name) ?? 0) + 1,
      );
    }

    const items = resolved.map((dependency) => {
      const declaration = declarations.get(dependency.name);
      const rootInstallPath = `node_modules/${dependency.name}`;
      const direct =
        declaration &&
        (dependency.packagePath === rootInstallPath ||
          versionsPerName.get(dependency.name) === 1)
          ? declaration
          : undefined;
      return resolvedNpmItem(file, dependency, direct);
    });
    return {
      valid: items.length > 0 || declarations.size === 0,
      items: deduplicateResolvedDependencies(items),
    };
  }

  if (legacyDependencies) {
    const rootDeclarations = dependencyDeclarationsFromRecord(lock);
    const resolved: ResolvedNpmDependency[] = [];
    collectLegacyPackageLockDependencies(
      legacyDependencies,
      rootDeclarations,
      resolved,
      true,
    );
    return {
      valid: resolved.length > 0 || rootDeclarations.size === 0,
      items: deduplicateResolvedDependencies(
        resolved.map((dependency) =>
          resolvedNpmItem(file, dependency, dependency.direct),
        ),
      ),
    };
  }

  return { valid: false, items: [] };
}

function packageLockDeclarations(
  packages: Record<string, unknown>,
): Map<string, DirectDependencyDeclaration> {
  const declarations = new Map<string, DirectDependencyDeclaration>();
  for (const [packagePath, value] of Object.entries(packages)) {
    if (packagePath.includes("node_modules/")) continue;
    for (const declaration of dependencyDeclarationsFromRecord(value).values()) {
      if (!declarations.has(declaration.name)) {
        declarations.set(declaration.name, declaration);
      }
    }
  }
  return declarations;
}

function dependencyDeclarationsFromRecord(
  value: unknown,
): Map<string, DirectDependencyDeclaration> {
  const record = asRecord(value);
  const declarations = new Map<string, DirectDependencyDeclaration>();
  const sections = [
    ["dependencies", "runtime"],
    ["devDependencies", "development"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ] as const;
  for (const [section, scope] of sections) {
    const dependencies = asRecord(record?.[section]);
    if (!dependencies) continue;
    for (const [name, rawSpec] of Object.entries(dependencies)) {
      const spec = stringValue(rawSpec);
      if (!spec) continue;
      declarations.set(name, {
        name,
        spec: sanitizeSpec(spec),
        scope,
        pinning: classifyNpmSpec(spec),
      });
    }
  }
  return declarations;
}

function collectLegacyPackageLockDependencies(
  dependencies: Record<string, unknown>,
  directDeclarations: Map<string, DirectDependencyDeclaration>,
  target: ResolvedNpmDependency[],
  root: boolean,
): void {
  for (const [name, rawMetadata] of Object.entries(dependencies)) {
    const metadata = asRecord(rawMetadata);
    const version = stringValue(metadata?.version);
    if (version) {
      target.push({
        name,
        version,
        sourceToken: name,
        direct: root ? directDeclarations.get(name) : undefined,
      });
    }
    const children = asRecord(metadata?.dependencies);
    if (children) {
      collectLegacyPackageLockDependencies(children, directDeclarations, target, false);
    }
  }
}

function packageLockPackageName(
  packagePath: string,
  declaredName?: string,
): string | undefined {
  if (declaredName) return declaredName;
  const marker = "node_modules/";
  const markerIndex = packagePath.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const tail = packagePath.slice(markerIndex + marker.length);
  if (!tail) return undefined;
  if (tail.startsWith("@")) {
    const [scope, packageName] = tail.split("/");
    return scope && packageName ? `${scope}/${packageName}` : undefined;
  }
  return tail.split("/")[0];
}

function parsePnpmLock(file: AnalysisFile): ParsedNpmLock {
  const document = parseYamlMapping(file.content);
  if (!document || document.lockfileVersion === undefined) {
    return { valid: false, items: [] };
  }

  const directByResolution = new Map<string, DirectDependencyDeclaration>();
  const items: DependencyInventoryItem[] = [];
  const importers = asRecord(document.importers);
  if (importers) {
    for (const importer of Object.values(importers)) {
      collectPnpmDirectDependencies(file, importer, directByResolution, items);
    }
  } else {
    collectPnpmDirectDependencies(file, document, directByResolution, items);
  }

  const packages = asRecord(document.packages) ?? asRecord(document.snapshots);
  if (packages) {
    for (const key of Object.keys(packages)) {
      const parsed = parsePnpmPackageKey(key);
      if (!parsed) continue;
      const resolutionKey = npmResolutionKey(parsed.name, parsed.version);
      if (directByResolution.has(resolutionKey)) continue;
      items.push(
        resolvedNpmItem(file, {
          name: parsed.name,
          version: parsed.version,
          sourceToken: key,
        }),
      );
    }
  }

  const hasDeclaredDependencies = importers
    ? Object.values(importers).some((importer) =>
        dependencyDeclarationsFromPnpmRecord(importer).length > 0,
      )
    : dependencyDeclarationsFromPnpmRecord(document).length > 0;
  return {
    valid: items.length > 0 || !hasDeclaredDependencies,
    items: deduplicateResolvedDependencies(items),
  };
}

function collectPnpmDirectDependencies(
  file: AnalysisFile,
  importer: unknown,
  directByResolution: Map<string, DirectDependencyDeclaration>,
  target: DependencyInventoryItem[],
): void {
  for (const dependency of dependencyDeclarationsFromPnpmRecord(importer)) {
    const normalizedVersion = normalizePnpmVersion(dependency.name, dependency.version);
    if (!normalizedVersion) continue;
    const declaration: DirectDependencyDeclaration = {
      name: dependency.name,
      spec: sanitizeSpec(dependency.spec),
      scope: dependency.scope,
      pinning: classifyNpmSpec(dependency.spec),
    };
    const resolutionKey = npmResolutionKey(dependency.name, normalizedVersion);
    if (directByResolution.has(resolutionKey)) continue;
    directByResolution.set(resolutionKey, declaration);
    target.push(
      resolvedNpmItem(
        file,
        {
          name: dependency.name,
          version: normalizedVersion,
          sourceToken: dependency.name,
        },
        declaration,
      ),
    );
  }
}

function dependencyDeclarationsFromPnpmRecord(value: unknown): Array<{
  name: string;
  spec: string;
  version: string;
  scope: string;
}> {
  const record = asRecord(value);
  const dependencies: Array<{
    name: string;
    spec: string;
    version: string;
    scope: string;
  }> = [];
  const sections = [
    ["dependencies", "runtime"],
    ["devDependencies", "development"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ] as const;
  for (const [section, scope] of sections) {
    const entries = asRecord(record?.[section]);
    if (!entries) continue;
    for (const [name, rawEntry] of Object.entries(entries)) {
      const entry = asRecord(rawEntry);
      const scalar = stringValue(rawEntry);
      const version = stringValue(entry?.version) ?? scalar;
      const spec = stringValue(entry?.specifier) ?? scalar ?? "*";
      if (version) dependencies.push({ name, spec, version, scope });
    }
  }
  return dependencies;
}

function normalizePnpmVersion(name: string, value: string): string | undefined {
  const trimmed = value.trim();
  const peerSuffix = trimmed.indexOf("(");
  const withoutPeers = peerSuffix < 0 ? trimmed : trimmed.slice(0, peerSuffix);
  if (!withoutPeers) return undefined;
  if (/^(?:link|file|workspace):/u.test(withoutPeers)) return withoutPeers;
  const parsedKey = parsePnpmPackageKey(withoutPeers);
  if (parsedKey && parsedKey.name === name) return parsedKey.version;
  return withoutPeers.replace(/^npm:/u, "");
}

function parsePnpmPackageKey(
  rawKey: string,
): { name: string; version: string } | undefined {
  const trimmed = rawKey.trim().replace(/^\//u, "");
  const peerSuffix = trimmed.indexOf("(");
  const key = peerSuffix < 0 ? trimmed : trimmed.slice(0, peerSuffix);
  if (!key || /^(?:file|link|workspace):/u.test(key)) return undefined;

  // pnpm lockfile v5 used /name/version while newer formats use name@version.
  const slashVersion = key.match(/^(@[^/]+\/[^/]+|[^/@][^/]*)\/(v?\d[^/]*)$/u);
  if (slashVersion) return { name: slashVersion[1], version: slashVersion[2] };

  const separator = key.startsWith("@") ? key.indexOf("@", key.indexOf("/") + 1) : key.indexOf("@");
  if (separator <= 0) return undefined;
  const name = key.slice(0, separator);
  const version = key.slice(separator + 1);
  return name && version ? { name, version } : undefined;
}

function parseYarnLock(
  file: AnalysisFile,
  manifests: readonly AnalysisFile[],
): ParsedNpmLock {
  const recognized =
    /^#\s*yarn lockfile v1\s*$/mu.test(file.content) ||
    /^__metadata:\s*$/mu.test(file.content);
  if (!recognized) return { valid: false, items: [] };

  const declarations = manifests.flatMap(manifestDeclarations);
  const items: DependencyInventoryItem[] = [];
  const lines = linesWithOffsets(file.content);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s/u.test(line.text) || !line.text.trim().endsWith(":")) continue;
    const key = line.text.trim().slice(0, -1);
    if (key === "__metadata") continue;

    let version: string | undefined;
    let next = index + 1;
    while (next < lines.length && (/^\s/u.test(lines[next].text) || !lines[next].text.trim())) {
      const versionMatch = lines[next].text.match(
        /^\s+version(?:\s+|:\s*)["']?([^"'\s]+)["']?\s*$/u,
      );
      if (versionMatch) version = versionMatch[1];
      next += 1;
    }
    if (!version) continue;

    const selectors = splitQuotedList(key)
      .map(parseYarnSelector)
      .filter((value): value is { name: string; spec: string } => value !== undefined);
    const primary = selectors[0];
    if (!primary) continue;
    const direct = declarations.find((declaration) =>
      selectors.some(
        (selector) =>
          selector.name === declaration.name && selector.spec === declaration.spec,
      ),
    );
    items.push(
      resolvedNpmItem(
        file,
        { name: primary.name, version, sourceToken: key },
        direct,
      ),
    );
    index = next - 1;
  }

  return {
    valid: items.length > 0 || declarations.length === 0,
    items: deduplicateResolvedDependencies(items),
  };
}

function parseYarnSelector(
  rawSelector: string,
): { name: string; spec: string } | undefined {
  const selector = unquote(rawSelector.trim());
  const separator = selector.startsWith("@")
    ? selector.indexOf("@", selector.indexOf("/") + 1)
    : selector.indexOf("@");
  if (separator <= 0) return undefined;
  const name = selector.slice(0, separator);
  let spec = selector.slice(separator + 1);
  if (spec.startsWith("npm:")) spec = spec.slice(4);
  return name && spec ? { name, spec } : undefined;
}

function resolvedNpmItem(
  file: AnalysisFile,
  dependency: ResolvedNpmDependency,
  direct = dependency.direct,
): DependencyInventoryItem {
  const start = Math.max(0, file.content.indexOf(dependency.sourceToken));
  const pinning = classifyNpmSpec(dependency.version);
  return dependencyItem(
    file,
    "npm",
    dependency.name,
    sanitizeSpec(dependency.version),
    direct?.scope ?? "transitive",
    pinning,
    start,
    start + dependency.sourceToken.length,
    {
      direct: direct !== undefined,
      resolutionSource: "lockfile",
      declaredVersionSpec: direct?.spec,
      declaredPinning: direct?.pinning,
      lockfilePath: file.path,
    },
  );
}

function deduplicateResolvedDependencies(
  dependencies: readonly DependencyInventoryItem[],
): DependencyInventoryItem[] {
  const selected = new Map<string, DependencyInventoryItem>();
  for (const dependency of dependencies) {
    const key = npmResolutionKey(dependency.name, dependency.versionSpec);
    const existing = selected.get(key);
    if (!existing || (!existing.direct && dependency.direct)) selected.set(key, dependency);
  }
  return [...selected.values()];
}

function npmResolutionKey(name: string, version: string): string {
  return `${name.toLowerCase()}\u0000${version}`;
}

function parseYamlMapping(content: string): Record<string, unknown> | undefined {
  const root = emptyRecord();
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];
  let recognizedEntry = false;

  for (const rawLine of content.split(/\r?\n/u)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) continue;
    if (/\t/u.test(rawLine.slice(0, rawLine.length - rawLine.trimStart().length))) {
      return undefined;
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = stripYamlComment(rawLine.trim());
    const separator = yamlMappingSeparator(line);
    if (separator < 0) continue;
    const key = unquote(line.slice(0, separator).trim());
    if (!key) continue;
    const rawValue = line.slice(separator + 1).trim();
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (!rawValue) {
      const child = emptyRecord();
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseYamlScalar(rawValue);
    }
    recognizedEntry = true;
  }
  return recognizedEntry ? root : undefined;
}

function yamlMappingSeparator(line: string): number {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === "\"" || character === "'") && line[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
      continue;
    }
    if (
      character === ":" &&
      !quote &&
      (index === line.length - 1 || /\s/u.test(line[index + 1]))
    ) {
      return index;
    }
  }
  return -1;
}

function stripYamlComment(value: string): string {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "\"" || character === "'") && value[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
    } else if (character === "#" && !quote && /\s/u.test(value[index - 1] ?? " ")) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value;
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    const record = emptyRecord();
    for (const entry of splitQuotedList(trimmed.slice(1, -1))) {
      const separator = yamlMappingSeparator(entry.trim());
      if (separator < 0) continue;
      record[unquote(entry.slice(0, separator).trim())] = parseYamlScalar(
        entry.slice(separator + 1),
      );
    }
    return record;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  return unquote(trimmed);
}

function splitQuotedList(value: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "\"" || character === "'") && value[index - 1] !== "\\") {
      quote = quote === character ? "" : quote || character;
    } else if (character === "," && !quote) {
      entries.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  entries.push(value.slice(start).trim());
  return entries.filter(Boolean);
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).replace(/\\([\\"'])/gu, "$1");
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function emptyRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseRequirements(file: AnalysisFile): readonly DependencyInventoryItem[] {
  const items: DependencyInventoryItem[] = [];
  for (const line of linesWithOffsets(file.content)) {
    const trimmed = line.text.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-r ")) continue;
    if (/^--(?:index-url|extra-index-url|trusted-host)\b/.test(trimmed)) continue;
    const parsed = parsePythonRequirement(trimmed.replace(/\s+#.*$/, ""));
    if (!parsed) continue;
    const nameIndex = line.text.indexOf(parsed.name);
    items.push(
      dependencyItem(
        file,
        "python",
        parsed.name,
        sanitizeSpec(parsed.spec),
        basename(file.path).startsWith("constraints") ? "constraint" : "runtime",
        classifyPythonSpec(parsed.spec),
        line.offset + Math.max(0, nameIndex),
        line.offset + Math.max(0, nameIndex) + parsed.name.length,
      ),
    );
  }
  return items;
}

function parsePyproject(file: AnalysisFile): readonly DependencyInventoryItem[] {
  const items: DependencyInventoryItem[] = [];
  const lines = linesWithOffsets(file.content);
  let section = "";
  let projectDependencyArray = false;

  for (const line of lines) {
    const trimmed = line.text.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      projectDependencyArray = false;
      continue;
    }

    if (section === "project" && /^dependencies\s*=\s*\[/.test(trimmed)) {
      projectDependencyArray = true;
      for (const value of quotedValues(line.text)) {
        addPythonTomlDependency(items, file, line, value, "runtime");
      }
      if (trimmed.includes("]")) projectDependencyArray = false;
      continue;
    }
    if (projectDependencyArray) {
      for (const value of quotedValues(line.text)) {
        addPythonTomlDependency(items, file, line, value, "runtime");
      }
      if (trimmed.includes("]")) projectDependencyArray = false;
      continue;
    }

    if (/^tool\.poetry\.(?:group\.[^.]+\.)?dependencies$/.test(section)) {
      const assignment = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (!assignment || assignment[1].toLowerCase() === "python") continue;
      const spec = extractTomlDependencySpec(assignment[2]);
      const nameIndex = line.text.indexOf(assignment[1]);
      items.push(
        dependencyItem(
          file,
          "python",
          assignment[1],
          sanitizeSpec(spec),
          section.includes(".group.") ? "development" : "runtime",
          classifyPythonSpec(spec),
          line.offset + Math.max(0, nameIndex),
          line.offset + Math.max(0, nameIndex) + assignment[1].length,
        ),
      );
    }
  }
  return items;
}

function addPythonTomlDependency(
  target: DependencyInventoryItem[],
  file: AnalysisFile,
  line: { text: string; offset: number },
  value: { value: string; index: number },
  scope: string,
): void {
  const parsed = parsePythonRequirement(value.value);
  if (!parsed) return;
  const relativeName = value.value.indexOf(parsed.name);
  const start = line.offset + value.index + 1 + Math.max(0, relativeName);
  target.push(
    dependencyItem(
      file,
      "python",
      parsed.name,
      sanitizeSpec(parsed.spec),
      scope,
      classifyPythonSpec(parsed.spec),
      start,
      start + parsed.name.length,
    ),
  );
}

function parseMaven(file: AnalysisFile): readonly DependencyInventoryItem[] {
  const items: DependencyInventoryItem[] = [];
  const expression = /<dependency>([\s\S]*?)<\/dependency>/gi;
  for (const match of file.content.matchAll(expression)) {
    if (match.index === undefined) continue;
    const block = match[1];
    const group = xmlValue(block, "groupId");
    const artifact = xmlValue(block, "artifactId");
    if (!artifact) continue;
    const version = xmlValue(block, "version") ?? "managed";
    const scope = xmlValue(block, "scope") ?? "compile";
    const artifactIndex = match[0].indexOf(artifact);
    const start = match.index + Math.max(0, artifactIndex);
    items.push(
      dependencyItem(
        file,
        "maven",
        group ? `${group}:${artifact}` : artifact,
        sanitizeSpec(version),
        scope,
        version === "managed" || /^\$\{[^}]+}$/.test(version)
          ? "managed"
          : classifyGenericVersion(version),
        start,
        start + artifact.length,
      ),
    );
  }
  return items;
}

function parseGradle(file: AnalysisFile): readonly DependencyInventoryItem[] {
  const items: DependencyInventoryItem[] = [];
  const expression =
    /\b(api|implementation|compileOnly|runtimeOnly|annotationProcessor|testImplementation|testRuntimeOnly)\s*(?:\(|\s)\s*["']([^"']+)["']/g;
  for (const match of file.content.matchAll(expression)) {
    if (match.index === undefined) continue;
    const coordinates = match[2].split(":");
    if (coordinates.length < 2) continue;
    const name = `${coordinates[0]}:${coordinates[1]}`;
    const version = coordinates.slice(2).join(":") || "managed";
    const nameIndex = match[0].indexOf(match[2]);
    const start = match.index + Math.max(0, nameIndex);
    items.push(
      dependencyItem(
        file,
        "gradle",
        name,
        sanitizeSpec(version),
        match[1],
        version === "managed" || /^\$|^libs\./.test(version)
          ? "managed"
          : classifyGenericVersion(version),
        start,
        start + name.length,
      ),
    );
  }
  return items;
}

function parseCargo(file: AnalysisFile): readonly DependencyInventoryItem[] {
  const items: DependencyInventoryItem[] = [];
  let section = "";
  for (const line of linesWithOffsets(file.content)) {
    const trimmed = line.text.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    if (!/(?:^|\.)dependencies$/.test(section)) continue;
    const assignment = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!assignment) continue;
    const spec = extractTomlDependencySpec(assignment[2]);
    const nameIndex = line.text.indexOf(assignment[1]);
    items.push(
      dependencyItem(
        file,
        "cargo",
        assignment[1],
        sanitizeSpec(spec),
        section.startsWith("dev-") || section.includes(".dev-")
          ? "development"
          : "runtime",
        classifyCargoSpec(spec),
        line.offset + Math.max(0, nameIndex),
        line.offset + Math.max(0, nameIndex) + assignment[1].length,
      ),
    );
  }
  return items;
}

function parseGoMod(file: AnalysisFile): readonly DependencyInventoryItem[] {
  const items: DependencyInventoryItem[] = [];
  let inRequireBlock = false;
  for (const line of linesWithOffsets(file.content)) {
    const trimmed = line.text.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(trimmed)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && trimmed === ")") {
      inRequireBlock = false;
      continue;
    }
    const requirement = inRequireBlock
      ? trimmed.match(/^([^\s]+)\s+([^\s]+)$/)
      : trimmed.match(/^require\s+([^\s]+)\s+([^\s]+)$/);
    if (!requirement) continue;
    const nameIndex = line.text.indexOf(requirement[1]);
    items.push(
      dependencyItem(
        file,
        "go",
        requirement[1],
        sanitizeSpec(requirement[2]),
        "runtime",
        /^v\d+\.\d+\.\d+(?:[-+].+)?$/.test(requirement[2])
          ? "exact"
          : "unknown",
        line.offset + Math.max(0, nameIndex),
        line.offset + Math.max(0, nameIndex) + requirement[1].length,
      ),
    );
  }
  return items;
}

function dependencyItem(
  file: AnalysisFile,
  ecosystem: DependencyEcosystem,
  name: string,
  versionSpec: string,
  scope: string,
  pinning: DependencyPinning,
  start: number,
  end: number,
  metadata: {
    direct?: boolean;
    resolutionSource?: DependencyResolutionSource;
    declaredVersionSpec?: string;
    declaredPinning?: DependencyPinning;
    lockfilePath?: string;
  } = {},
): DependencyInventoryItem {
  return {
    kind: "dependency",
    id: `dependency-${stableId(
      file.path,
      ecosystem,
      scope,
      name,
      metadata.resolutionSource === "lockfile" ? versionSpec : "declared",
    )}`,
    analyzerId: "security.dependencies",
    ecosystem,
    name,
    versionSpec,
    scope,
    pinning,
    direct: metadata.direct ?? true,
    resolutionSource: metadata.resolutionSource ?? "manifest",
    declaredVersionSpec: metadata.declaredVersionSpec,
    declaredPinning: metadata.declaredPinning,
    lockfilePath: metadata.lockfilePath,
    provenance: provenance(file, start, end),
  };
}

function dependencyRisk(
  dependency: DependencyInventoryItem,
): SecurityFinding | undefined {
  if (!dependency.direct) return undefined;
  const location = dependency.provenance;
  const declaredSpec = dependency.declaredVersionSpec ?? dependency.versionSpec;
  const declaredPinning = dependency.declaredPinning ?? dependency.pinning;
  if (/^http:\/\//i.test(declaredSpec)) {
    return {
      kind: "finding",
      id: `dependency-risk-${stableId(dependency.id, "http")}`,
      analyzerId: "security.dependencies",
      ruleId: "dependency.insecure-transport",
      category: "supply-chain",
      severity: "high",
      title: `Dependency ${dependency.name} uses an insecure source`,
      description:
        "The dependency source uses unencrypted HTTP and can be modified in transit unless a separate trusted integrity check is enforced.",
      confidence: confidence(0.96, "The manifest contains an HTTP dependency source."),
      evidence: {
        provenance: location,
        summary: "The dependency declaration resolves through unencrypted HTTP.",
      },
      remediation:
        "Use HTTPS and pin a verified digest, immutable revision, or signed release through the ecosystem's lock mechanism.",
      cwe: "CWE-494",
    };
  }

  if (declaredPinning === "floating") {
    return {
      kind: "finding",
      id: `dependency-risk-${stableId(dependency.id, "floating")}`,
      analyzerId: "security.dependencies",
      ruleId: "dependency.floating-version",
      category: "supply-chain",
      severity: "medium",
      title: `Dependency ${dependency.name} has a floating version`,
      description:
        "A floating dependency can resolve to different code without a manifest change and increases exposure to accidental or malicious upstream releases.",
      confidence: confidence(0.94, "The version selector is empty, wildcard-based, or a moving tag."),
      evidence: {
        provenance: location,
        summary: "The direct dependency is not bounded to a stable version or revision.",
      },
      remediation:
        "Select an intentional version range and commit the ecosystem lockfile; use immutable versions for release and deployment inputs.",
      cwe: "CWE-1104",
    };
  }

  if (
    declaredPinning === "source" &&
    !/(?:#|\brev\s*=\s*)["']?[0-9a-f]{7,64}\b/i.test(declaredSpec) &&
    !/^workspace:/i.test(declaredSpec) &&
    !/^(?:file|path|link):/i.test(declaredSpec)
  ) {
    return {
      kind: "finding",
      id: `dependency-risk-${stableId(dependency.id, "source")}`,
      analyzerId: "security.dependencies",
      ruleId: "dependency.mutable-source",
      category: "supply-chain",
      severity: "medium",
      title: `Dependency ${dependency.name} references a mutable source`,
      description:
        "A branch, tag, or remote source without an immutable revision can change without a manifest update.",
      confidence: confidence(0.82, "A source dependency is present without a commit-like revision."),
      evidence: {
        provenance: location,
        summary: "The dependency source is not pinned to an immutable revision.",
      },
      remediation:
        "Pin the dependency to a reviewed commit digest or immutable release and preserve the resolved artifact in the lockfile.",
      cwe: "CWE-1104",
    };
  }

  if (declaredPinning === "range" && dependency.ecosystem === "python") {
    return {
      kind: "finding",
      id: `dependency-risk-${stableId(dependency.id, "unbounded-python")}`,
      analyzerId: "security.dependencies",
      ruleId: "dependency.unbounded-range",
      category: "supply-chain",
      severity: "low",
      title: `Dependency ${dependency.name} is resolved from a version range`,
      description:
        "A range is not inherently vulnerable, but reproducibility depends on a reviewed constraints or lock file.",
      confidence: confidence(0.75, "The Python requirement is not an exact == version."),
      evidence: {
        provenance: location,
        summary: "The dependency version may resolve differently over time.",
      },
      remediation:
        "Generate and review a hash-verified lock or constraints file for deployed environments while keeping intentional compatibility bounds in the source manifest.",
      cwe: "CWE-1104",
    };
  }

  return undefined;
}

function parsePythonRequirement(
  input: string,
): { name: string; spec: string } | undefined {
  const direct = input.match(/^([A-Za-z0-9_.-]+)(?:\[[^\]]+])?\s*@\s*(.+)$/);
  if (direct) return { name: direct[1], spec: direct[2].trim() };
  const vcs = input.match(/^(?:git\+|https?:\/\/|ssh:\/\/)(.+?)(?:#egg=([A-Za-z0-9_.-]+))?$/i);
  if (vcs) return { name: vcs[2] ?? sanitizedSourceName(vcs[1]), spec: input };
  const regular = input.match(
    /^([A-Za-z0-9_.-]+)(?:\[[^\]]+])?\s*((?:(?:===|==|~=|!=|<=|>=|<|>)\s*[^;\s,]+\s*,?\s*)*)(?:;.*)?$/,
  );
  if (!regular) return undefined;
  return { name: regular[1], spec: regular[2].trim() || "*" };
}

function classifyNpmSpec(spec: string): DependencyPinning {
  if (!spec || /^(?:\*|latest|next|canary|x)$/i.test(spec)) return "floating";
  if (/^(?:git\+|git:|https?:|ssh:|github:|file:|link:|workspace:)/i.test(spec)) {
    return "source";
  }
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec)
    ? "exact"
    : "range";
}

function classifyPythonSpec(spec: string): DependencyPinning {
  if (!spec || spec === "*") return "floating";
  if (/^(?:git\+|https?:|ssh:|file:|path:)/i.test(spec)) return "source";
  if (/^===?\s*[^*,\s]+$/.test(spec)) return "exact";
  if (/^\$\{[^}]+}$/.test(spec)) return "managed";
  return "range";
}

function classifyCargoSpec(spec: string): DependencyPinning {
  if (!spec || spec === "*") return "floating";
  if (/\b(?:git|path)\s*=/.test(spec) || /^(?:git|path):/i.test(spec)) return "source";
  if (/^=\s*\d+\.\d+\.\d+/.test(spec)) return "exact";
  return "range";
}

function classifyGenericVersion(spec: string): DependencyPinning {
  if (!spec || /^(?:\*|latest|release)$/i.test(spec)) return "floating";
  if (/^(?:https?:|git\+|git:|ssh:|file:)/i.test(spec)) return "source";
  if (/^(?:\[|\().+,.+(?:]|\))$/.test(spec) || /[+*]/.test(spec)) return "range";
  return /^v?\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(spec)
    ? "exact"
    : "unknown";
}

function extractTomlDependencySpec(raw: string): string {
  const simple = raw.match(/^["']([^"']*)["']/);
  if (simple) return simple[1];
  const git = raw.match(/\bgit\s*=\s*["']([^"']+)["']/);
  if (git) {
    const revision = raw.match(/\b(?:rev|tag|branch)\s*=\s*["']([^"']+)["']/);
    return revision
      ? `${git[1]}#${revision[1]}`
      : git[1];
  }
  const path = raw.match(/\bpath\s*=\s*["']([^"']+)["']/);
  if (path) return `path:${path[1]}`;
  const version = raw.match(/\bversion\s*=\s*["']([^"']+)["']/);
  return version?.[1] ?? "*";
}

function xmlValue(block: string, element: string): string | undefined {
  const match = block.match(
    new RegExp(`<${element}>\\s*([^<]+?)\\s*</${element}>`, "i"),
  );
  return match?.[1].trim();
}

function locateJsonProperty(
  file: AnalysisFile,
  property: string,
  after: number,
): { start: number; end: number } {
  const expression = new RegExp(`"${escapeRegExp(property)}"\\s*:`, "g");
  expression.lastIndex = after;
  const match = expression.exec(file.content);
  if (!match) return { start: after, end: after };
  const quote = match.index;
  return { start: quote + 1, end: quote + 1 + property.length };
}

function linesWithOffsets(content: string): Array<{ text: string; offset: number }> {
  const lines: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const text of content.split("\n")) {
    lines.push({ text, offset });
    offset += text.length + 1;
  }
  return lines;
}

function quotedValues(line: string): Array<{ value: string; index: number }> {
  const values: Array<{ value: string; index: number }> = [];
  for (const match of line.matchAll(/["']([^"']+)["']/g)) {
    if (match.index !== undefined) values.push({ value: match[1], index: match.index });
  }
  return values;
}

function sanitizeSpec(spec: string): string {
  return spec
    .trim()
    .replace(/:\/\/[^/@\s]+@/g, "://[REDACTED]@")
    .replace(
      /([?&](?:access_?token|api_?key|password|secret|token)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    );
}

function sanitizedSourceName(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0];
  const tail = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  return (tail.replace(/\.git$/i, "") || "source-dependency").replace(
    /[^A-Za-z0-9_.-]/g,
    "-",
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

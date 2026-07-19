import { promises as fs } from "node:fs";
import path from "node:path";
import { comparePaths, normalizeRelativePath, stableUnique } from "./path-utils";
import { redactSensitiveText } from "./redaction";
import type {
  CodeGraph,
  CodeGraphEdge,
  CodeGraphNode,
  ExternalModuleNode,
  FileNode,
  ScanResult,
  ScanWarning,
  ScannedFile,
  SourceLocation,
  SymbolKind,
  SymbolNode,
} from "./types";

export interface SourceDefinitionPattern {
  expression: RegExp;
  kind: SymbolKind;
  nameGroup?: number;
  exported?: (match: RegExpExecArray) => boolean;
}

export interface SourceImport {
  module: string;
  line: number;
  column: number;
}

export interface SourceSyntax {
  language: string;
  definitions: readonly SourceDefinitionPattern[];
  imports: (lines: readonly string[]) => SourceImport[];
}

export interface ModuleAlias {
  pattern: string;
  targets: readonly string[];
  baseDir?: string;
}

export interface GraphOptions {
  signal?: AbortSignal;
  syntaxes?: readonly SourceSyntax[];
  extendSyntaxes?: readonly SourceSyntax[];
  aliases?: readonly ModuleAlias[];
  detectConfigAliases?: boolean;
  maxSourceBytes?: number;
  maxSymbolsPerFile?: number;
  maxReferenceEdgesPerFile?: number;
  maxAmbiguousSymbolTargets?: number;
}

function lineImports(patterns: readonly RegExp[], lines: readonly string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  lines.forEach((line, lineIndex) => {
    for (const original of patterns) {
      const flags = original.flags.includes("g") ? original.flags : `${original.flags}g`;
      const pattern = new RegExp(original.source, flags);
      for (const match of line.matchAll(pattern)) {
        const moduleName = match[1]?.trim();
        if (!moduleName) continue;
        imports.push({ module: moduleName, line: lineIndex + 1, column: (match.index ?? 0) + 1 });
      }
    }
  });
  return imports;
}

function pythonImports(lines: readonly string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  lines.forEach((line, lineIndex) => {
    const from = line.match(/^\s*from\s+([.\w]+)\s+import\s+/u);
    if (from) imports.push({ module: from[1], line: lineIndex + 1, column: line.indexOf(from[1]) + 1 });
    const direct = line.match(/^\s*import\s+(.+)$/u);
    if (direct) {
      for (const entry of direct[1].split(",")) {
        const moduleName = entry.trim().split(/\s+as\s+/u)[0];
        if (moduleName) imports.push({ module: moduleName, line: lineIndex + 1, column: line.indexOf(moduleName) + 1 });
      }
    }
  });
  return imports;
}

function goImports(lines: readonly string[]): SourceImport[] {
  const imports: SourceImport[] = [];
  let inBlock = false;
  lines.forEach((line, lineIndex) => {
    if (/^\s*import\s*\(/u.test(line)) {
      inBlock = true;
      return;
    }
    if (inBlock && /^\s*\)/u.test(line)) {
      inBlock = false;
      return;
    }
    if (inBlock || /^\s*import\s+/u.test(line)) {
      const match = line.match(/["`]([^"`]+)["`]/u);
      if (match) imports.push({ module: match[1], line: lineIndex + 1, column: line.indexOf(match[1]) + 1 });
    }
  });
  return imports;
}

const JS_IMPORTS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/u,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/u,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/u,
];

export const DEFAULT_SOURCE_SYNTAXES: readonly SourceSyntax[] = [
  {
    language: "typescript",
    definitions: [
      { expression: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "function", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(export\s+)?(?:default\s+)?class\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "class", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(export\s+)?interface\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "interface", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(export\s+)?type\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "type", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(export\s+)?enum\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "enum", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "variable", nameGroup: 2, exported: (match) => Boolean(match[1]) },
    ],
    imports: (lines) => lineImports(JS_IMPORTS, lines),
  },
  {
    language: "javascript",
    definitions: [
      { expression: /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "function", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(export\s+)?(?:default\s+)?class\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "class", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(export\s+)?(?:const|let|var)\s+([$\p{L}_][$\p{L}\p{N}_]*)/u, kind: "variable", nameGroup: 2, exported: (match) => Boolean(match[1]) },
    ],
    imports: (lines) => lineImports(JS_IMPORTS, lines),
  },
  {
    language: "python",
    definitions: [
      { expression: /^\s*(?:async\s+)?def\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "function", exported: (match) => !match[1].startsWith("_") },
      { expression: /^\s*class\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "class", exported: (match) => !match[1].startsWith("_") },
    ],
    imports: pythonImports,
  },
  {
    language: "java",
    definitions: [
      { expression: /^\s*(?:(public|protected|private)\s+)?(?:abstract\s+|final\s+|static\s+)*(?:class|record)\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "class", nameGroup: 2, exported: (match) => match[1] === "public" },
      { expression: /^\s*(?:(public|protected|private)\s+)?(?:abstract\s+)?interface\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "interface", nameGroup: 2, exported: (match) => match[1] === "public" },
      { expression: /^\s*(?:(public|protected|private)\s+)?enum\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "enum", nameGroup: 2, exported: (match) => match[1] === "public" },
    ],
    imports: (lines) => lineImports([/^\s*import\s+(?:static\s+)?([\w.]+)\s*;/u], lines),
  },
  {
    language: "kotlin",
    definitions: [
      { expression: /^\s*(?:(public|internal|private|protected)\s+)?(?:data\s+|sealed\s+|abstract\s+)?class\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "class", nameGroup: 2, exported: (match) => match[1] !== "private" },
      { expression: /^\s*(?:(public|internal|private|protected)\s+)?interface\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "interface", nameGroup: 2, exported: (match) => match[1] !== "private" },
      { expression: /^\s*(?:(public|internal|private|protected)\s+)?(?:suspend\s+)?fun\s+(?:<[^>]+>\s*)?([\p{L}_][\p{L}\p{N}_]*)/u, kind: "function", nameGroup: 2, exported: (match) => match[1] !== "private" },
    ],
    imports: (lines) => lineImports([/^\s*import\s+([\w.]+)/u], lines),
  },
  {
    language: "go",
    definitions: [
      { expression: /^\s*func\s+(?:\([^)]*\)\s*)?([\p{L}_][\p{L}\p{N}_]*)/u, kind: "function", exported: (match) => /^\p{Lu}/u.test(match[1]) },
      { expression: /^\s*type\s+([\p{L}_][\p{L}\p{N}_]*)\s+struct\b/u, kind: "class", exported: (match) => /^\p{Lu}/u.test(match[1]) },
      { expression: /^\s*type\s+([\p{L}_][\p{L}\p{N}_]*)\s+interface\b/u, kind: "interface", exported: (match) => /^\p{Lu}/u.test(match[1]) },
    ],
    imports: goImports,
  },
  {
    language: "rust",
    definitions: [
      { expression: /^\s*(pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "function", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "class", nameGroup: 2, exported: (match) => Boolean(match[1]) },
      { expression: /^\s*(pub(?:\([^)]*\))?\s+)?trait\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "interface", nameGroup: 2, exported: (match) => Boolean(match[1]) },
    ],
    imports: (lines) => lineImports([/^\s*use\s+([\w:]+)/u, /^\s*(?:pub\s+)?mod\s+([\w]+)/u], lines),
  },
  {
    language: "csharp",
    definitions: [
      { expression: /^\s*(?:(public|internal|private|protected)\s+)?(?:abstract\s+|sealed\s+|static\s+|partial\s+)*(?:class|record)\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "class", nameGroup: 2, exported: (match) => match[1] === "public" },
      { expression: /^\s*(?:(public|internal|private|protected)\s+)?interface\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "interface", nameGroup: 2, exported: (match) => match[1] === "public" },
      { expression: /^\s*(?:(public|internal|private|protected)\s+)?enum\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "enum", nameGroup: 2, exported: (match) => match[1] === "public" },
    ],
    imports: (lines) => lineImports([/^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)/u], lines),
  },
  {
    language: "ruby",
    definitions: [
      { expression: /^\s*def\s+(?:self\.)?([\p{L}_][\p{L}\p{N}_!?=]*)/u, kind: "function", exported: () => true },
      { expression: /^\s*class\s+([\p{L}_][\p{L}\p{N}:]*)/u, kind: "class", exported: () => true },
      { expression: /^\s*module\s+([\p{L}_][\p{L}\p{N}:]*)/u, kind: "module", exported: () => true },
    ],
    imports: (lines) => lineImports([/^\s*require(?:_relative)?\s*["']([^"']+)["']/u], lines),
  },
  {
    language: "php",
    definitions: [
      { expression: /^\s*(?:final\s+|abstract\s+)?class\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "class", exported: () => true },
      { expression: /^\s*interface\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "interface", exported: () => true },
      { expression: /^\s*function\s+([\p{L}_][\p{L}\p{N}_]*)/u, kind: "function", exported: () => true },
    ],
    imports: (lines) => lineImports([/^\s*use\s+([\w\\]+)/u, /\b(?:require|include)(?:_once)?\s*\(?\s*["']([^"']+)["']/u], lines),
  },
  {
    language: "sql",
    definitions: [
      { expression: /^\s*create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?["`[]?([\w.]+)/iu, kind: "table", exported: () => true },
      { expression: /^\s*create\s+(?:or\s+replace\s+)?view\s+["`[]?([\w.]+)/iu, kind: "view", exported: () => true },
      { expression: /^\s*create\s+(?:or\s+replace\s+)?function\s+["`[]?([\w.]+)/iu, kind: "function", exported: () => true },
    ],
    imports: () => [],
  },
];

interface ParsedSource {
  file: ScannedFile;
  lines: string[];
  syntax: SourceSyntax;
  symbols: SymbolNode[];
  imports: SourceImport[];
}

function fileId(filePath: string): string {
  return `file:${filePath}`;
}

function symbolId(filePath: string, kind: SymbolKind, name: string, line: number): string {
  return `symbol:${filePath}:${kind}:${name}:${line}`;
}

function externalId(module: string): string {
  return `external:${module}`;
}

function parseDefinitions(
  file: ScannedFile,
  lines: readonly string[],
  syntax: SourceSyntax,
  maxSymbols: number,
): SymbolNode[] {
  const symbols: SymbolNode[] = [];
  for (let lineIndex = 0; lineIndex < lines.length && symbols.length < maxSymbols; lineIndex += 1) {
    const line = lines[lineIndex];
    for (const definition of syntax.definitions) {
      definition.expression.lastIndex = 0;
      const match = definition.expression.exec(line);
      if (!match) continue;
      const name = match[definition.nameGroup ?? 1]?.replace(/[\]`"']+$/u, "");
      if (!name) continue;
      const column = Math.max(1, line.indexOf(name) + 1);
      symbols.push({
        id: symbolId(file.path, definition.kind, name, lineIndex + 1),
        type: "symbol",
        name,
        symbolKind: definition.kind,
        exported: definition.exported?.(match) ?? false,
        location: { path: file.path, line: lineIndex + 1, column },
        fileId: fileId(file.path),
      });
      break;
    }
  }
  return symbols;
}

function stripJsonComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "")
    .replace(/,\s*([}\]])/gu, "$1");
}

async function detectAliases(scan: ScanResult): Promise<ModuleAlias[]> {
  const aliases: ModuleAlias[] = [];
  for (const file of scan.files) {
    if (!/(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(file.path) || file.sizeBytes > 512 * 1024) continue;
    try {
      const value: unknown = JSON.parse(stripJsonComments(await fs.readFile(file.absolutePath, "utf8")));
      if (!value || typeof value !== "object") continue;
      const compilerOptions = (value as { compilerOptions?: unknown }).compilerOptions;
      if (!compilerOptions || typeof compilerOptions !== "object") continue;
      const options = compilerOptions as { baseUrl?: unknown; paths?: unknown };
      const configDirectory = path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path);
      const baseUrl = typeof options.baseUrl === "string"
        ? normalizeRelativePath(path.posix.join(configDirectory, options.baseUrl))
        : configDirectory;
      if (!options.paths || typeof options.paths !== "object" || Array.isArray(options.paths)) continue;
      for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
        if (!Array.isArray(targets)) continue;
        const safeTargets = targets.filter((target): target is string => typeof target === "string");
        if (safeTargets.length) aliases.push({ pattern, targets: safeTargets, baseDir: baseUrl });
      }
    } catch {
      // Invalid editor configs should not prevent graph extraction.
    }
  }
  return aliases;
}

function applyAlias(module: string, alias: ModuleAlias): string[] {
  const star = alias.pattern.indexOf("*");
  if (star < 0) {
    if (module !== alias.pattern) return [];
    return alias.targets.map((target) => normalizeRelativePath(path.posix.join(alias.baseDir ?? "", target)));
  }
  const prefix = alias.pattern.slice(0, star);
  const suffix = alias.pattern.slice(star + 1);
  if (!module.startsWith(prefix) || !module.endsWith(suffix)) return [];
  const capture = module.slice(prefix.length, module.length - suffix.length || undefined);
  return alias.targets.map((target) =>
    normalizeRelativePath(path.posix.join(alias.baseDir ?? "", target.replace("*", capture))),
  );
}

function resolvePathCandidate(candidate: string, files: Map<string, FileNode>): FileNode | undefined {
  const normalized = normalizeRelativePath(candidate).replace(/\.(?:js|jsx|mjs|cjs)$/u, "");
  const extensions = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".kt", ".go", ".rs", ".cs", ".rb", ".php", ".sql"];
  for (const extension of extensions) {
    const direct = files.get(`${normalized}${extension}`);
    if (direct) return direct;
  }
  for (const extension of extensions.slice(1)) {
    const indexed = files.get(`${normalized}/index${extension}`) ?? files.get(`${normalized}/__init__${extension}`);
    if (indexed) return indexed;
  }
  return undefined;
}

function resolveImport(
  importer: ScannedFile,
  module: string,
  files: Map<string, FileNode>,
  aliases: readonly ModuleAlias[],
): FileNode | undefined {
  const candidates: string[] = [];
  if (module.startsWith(".")) {
    if (importer.language === "python") {
      const dots = module.match(/^\.+/u)?.[0].length ?? 1;
      let base = path.posix.dirname(importer.path);
      for (let index = 1; index < dots; index += 1) base = path.posix.dirname(base);
      candidates.push(path.posix.join(base, module.slice(dots).replace(/\./g, "/")));
    } else {
      candidates.push(path.posix.join(path.posix.dirname(importer.path), module));
    }
  } else {
    for (const alias of aliases) candidates.push(...applyAlias(module, alias));
    candidates.push(module);
    if (["python", "java", "kotlin", "csharp"].includes(importer.language ?? "")) {
      candidates.push(module.replace(/\./g, "/"));
    }
  }
  for (const candidate of stableUnique(candidates)) {
    const resolved = resolvePathCandidate(candidate, files);
    if (resolved) return resolved;
    const underSourceRoot = ["src", "lib", "app"].map((root) => resolvePathCandidate(`${root}/${candidate}`, files)).find(Boolean);
    if (underSourceRoot) return underSourceRoot;
  }
  return undefined;
}

function maskedCodeLine(line: string): string {
  return line
    .replace(/\/\/.*$/u, "")
    .replace(/#.*$/u, "")
    .replace(/\/\*.*?\*\//gu, "")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/gu, (value) => " ".repeat(value.length));
}

function addEdge(edges: Map<string, CodeGraphEdge>, edge: Omit<CodeGraphEdge, "id">): void {
  const id = `edge:${edge.kind}:${edge.source}->${edge.target}`;
  if (!edges.has(id)) edges.set(id, { id, ...edge });
}

export async function extractCodeGraph(
  scan: ScanResult,
  options: GraphOptions = {},
): Promise<CodeGraph> {
  options.signal?.throwIfAborted();
  const maxSourceBytes = Math.max(1_024, options.maxSourceBytes ?? 1024 * 1024);
  const maxSymbolsPerFile = Math.max(1, options.maxSymbolsPerFile ?? 2_000);
  const maxReferenceEdgesPerFile = Math.max(0, options.maxReferenceEdgesPerFile ?? 5_000);
  const maxAmbiguousTargets = Math.max(1, options.maxAmbiguousSymbolTargets ?? 3);
  const syntaxes = options.syntaxes ?? [...DEFAULT_SOURCE_SYNTAXES, ...(options.extendSyntaxes ?? [])];
  const syntaxByLanguage = new Map(syntaxes.map((syntax) => [syntax.language, syntax]));
  const warnings: ScanWarning[] = [];
  const fileNodes = new Map<string, FileNode>();
  const nodes = new Map<string, CodeGraphNode>();
  for (const file of scan.files) {
    options.signal?.throwIfAborted();
    if (!file.language || file.isBinary) continue;
    const node: FileNode = {
      id: fileId(file.path),
      type: "file",
      path: file.path,
      language: file.language,
      kind: file.kind,
    };
    fileNodes.set(file.path, node);
    nodes.set(node.id, node);
  }

  const parsedSources: ParsedSource[] = [];
  for (const file of scan.files) {
    options.signal?.throwIfAborted();
    const syntax = file.language ? syntaxByLanguage.get(file.language) : undefined;
    if (!syntax || file.isBinary) continue;
    if (file.sizeBytes > maxSourceBytes) {
      warnings.push({
        code: "limit-reached",
        path: file.path,
        message: `Source graph extraction skipped this file because it exceeds the ${maxSourceBytes.toLocaleString("en-US")}-byte per-file limit.`,
      });
      continue;
    }
    try {
      const lines = (await fs.readFile(file.absolutePath, "utf8")).split(/\r?\n/u);
      const symbols = parseDefinitions(file, lines, syntax, maxSymbolsPerFile);
      parsedSources.push({ file, lines, syntax, symbols, imports: syntax.imports(lines) });
      for (const symbol of symbols) nodes.set(symbol.id, symbol);
    } catch {
      warnings.push({
        code: "read-failed",
        path: file.path,
        message: "Source graph extraction could not read this file.",
      });
    }
  }

  const aliases = [
    ...(options.aliases ?? []),
    ...(options.detectConfigAliases === false ? [] : await detectAliases(scan)),
  ];
  const edges = new Map<string, CodeGraphEdge>();
  const importedFilesBySource = new Map<string, Set<string>>();
  for (const source of parsedSources) {
    for (const symbol of source.symbols) {
      addEdge(edges, { source: fileId(source.file.path), target: symbol.id, kind: "contains", evidence: symbol.location });
    }
    for (const imported of source.imports) {
      options.signal?.throwIfAborted();
      const resolved = resolveImport(source.file, imported.module, fileNodes, aliases);
      const safeModuleName = redactSensitiveText(imported.module, { maxLength: 200 });
      const target = resolved?.id ?? externalId(safeModuleName);
      if (!resolved && !nodes.has(target)) {
        const external: ExternalModuleNode = { id: target, type: "external-module", name: safeModuleName };
        nodes.set(target, external);
      }
      if (resolved) {
        const importedSet = importedFilesBySource.get(fileId(source.file.path)) ?? new Set<string>();
        importedSet.add(resolved.id);
        importedFilesBySource.set(fileId(source.file.path), importedSet);
      }
      addEdge(edges, {
        source: fileId(source.file.path),
        target,
        kind: "imports",
        evidence: { path: source.file.path, line: imported.line, column: imported.column },
      });
    }
  }

  const symbolsByName = new Map<string, SymbolNode[]>();
  for (const node of nodes.values()) {
    if (node.type !== "symbol") continue;
    symbolsByName.set(node.name, [...(symbolsByName.get(node.name) ?? []), node]);
  }
  for (const candidates of symbolsByName.values()) {
    candidates.sort((a, b) => comparePaths(a.location.path, b.location.path) || a.location.line - b.location.line);
  }

  const identifier = /[$_\p{L}][$_\p{L}\p{N}]*/gu;
  for (const source of parsedSources) {
    options.signal?.throwIfAborted();
    let referenceCount = 0;
    const sourceId = fileId(source.file.path);
    const imported = importedFilesBySource.get(sourceId) ?? new Set<string>();
    for (let lineIndex = 0; lineIndex < source.lines.length && referenceCount < maxReferenceEdgesPerFile; lineIndex += 1) {
      const masked = maskedCodeLine(source.lines[lineIndex]);
      for (const match of masked.matchAll(identifier)) {
        const name = match[0];
        let targets = symbolsByName.get(name) ?? [];
        targets = targets.filter((target) => !(target.fileId === sourceId && target.location.line === lineIndex + 1));
        if (targets.length === 0) continue;
        const contextual = targets.filter((target) => imported.has(target.fileId) || target.fileId === sourceId);
        if (contextual.length) targets = contextual;
        const after = masked.slice((match.index ?? 0) + name.length);
        const kind: CodeGraphEdge["kind"] = /^\s*\(/u.test(after) ? "calls" : "references";
        for (const target of targets.slice(0, maxAmbiguousTargets)) {
          addEdge(edges, {
            source: sourceId,
            target: target.id,
            kind,
            evidence: { path: source.file.path, line: lineIndex + 1, column: (match.index ?? 0) + 1 },
          });
          referenceCount += 1;
          if (referenceCount >= maxReferenceEdgesPerFile) break;
        }
      }
    }
  }

  const orderedNodes = [...nodes.values()].sort((a, b) => comparePaths(a.id, b.id));
  const orderedEdges = [...edges.values()].sort((a, b) => comparePaths(a.id, b.id));
  warnings.sort((a, b) => comparePaths(a.path ?? "", b.path ?? ""));
  return { nodes: orderedNodes, edges: orderedEdges, warnings };
}

export function graphLocation(node: CodeGraphNode): SourceLocation | undefined {
  if (node.type === "symbol") return node.location;
  if (node.type === "file") return { path: node.path, line: 1 };
  return undefined;
}

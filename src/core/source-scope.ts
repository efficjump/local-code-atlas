import path from "node:path";
import type { FileKind, SourceScope, SourceScopeRule } from "./types";

export interface SourceScopeInput {
  path: string;
  kind?: FileKind;
}

export interface SourceScopeClassificationOptions {
  /** Replace the built-in rules entirely. */
  rules?: readonly SourceScopeRule[];
  /** Rules evaluated before the built-ins so callers can add specific scopes. */
  extendRules?: readonly SourceScopeRule[];
}

const NON_PRODUCTION_SCOPES = new Set<SourceScope>([
  "test",
  "example",
  "fixture",
  "documentation",
  "generated",
  "vendor",
]);

/**
 * Generic path rules shared by discovery and analyzer selection. They describe
 * common repository conventions, not any particular project layout.
 */
export const DEFAULT_SOURCE_SCOPE_RULES: readonly SourceScopeRule[] = [
  {
    id: "fixture-directory",
    scope: "fixture",
    pathSegments: ["fixture", "fixtures", "__fixtures__", "testdata"],
  },
  {
    id: "fixture-file",
    scope: "fixture",
    fileNamePatterns: [/\.(?:fixture|fixtures)\.[^/]+$/iu],
  },
  {
    id: "test-directory",
    scope: "test",
    pathSegments: ["test", "tests", "__tests__", "spec", "specs"],
  },
  {
    id: "test-file",
    scope: "test",
    fileNamePatterns: [/\.(?:test|spec)\.[^/]+$/iu],
  },
  {
    id: "example-directory",
    scope: "example",
    pathSegments: [
      "example",
      "examples",
      "sample",
      "samples",
      "demo",
      "demos",
      "playground",
    ],
  },
  {
    id: "example-file",
    scope: "example",
    fileNamePatterns: [/(?:^|\.)(?:example|sample|template)(?:\.|$)/iu],
  },
  {
    id: "documentation-directory",
    scope: "documentation",
    pathSegments: ["doc", "docs", "documentation"],
  },
  {
    id: "documentation-kind",
    scope: "documentation",
    kinds: ["documentation"],
  },
  {
    id: "generated-directory",
    scope: "generated",
    pathSegments: ["generated", "__generated__", "codegen"],
  },
  {
    id: "generated-file",
    scope: "generated",
    fileNamePatterns: [/\.(?:generated|gen)\.[^/]+$/iu],
  },
  {
    id: "vendored-source",
    scope: "vendor",
    pathSegments: ["vendor", "vendors", "third_party", "third-party"],
  },
];

export function classifySourceScope(
  input: SourceScopeInput,
  options: SourceScopeClassificationOptions = {},
): SourceScope {
  const normalizedPath = input.path.replaceAll("\\", "/").replace(/^\.\//u, "");
  const segments = normalizedPath.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLocaleLowerCase());
  const fileName = path.posix.basename(normalizedPath).toLocaleLowerCase();
  const rules = options.rules ?? [
    ...(options.extendRules ?? []),
    ...DEFAULT_SOURCE_SCOPE_RULES,
  ];

  for (const rule of rules) {
    if (ruleMatches(rule, normalizedPath, lowerSegments, fileName, input.kind)) {
      return rule.scope;
    }
  }
  return "production";
}

export function sourceScopeIncluded(
  scope: SourceScope,
  selection: "production" | "all" | readonly SourceScope[] = "production",
): boolean {
  if (selection === "all") return true;
  if (selection === "production") return !NON_PRODUCTION_SCOPES.has(scope);
  return selection.includes(scope);
}

function ruleMatches(
  rule: SourceScopeRule,
  normalizedPath: string,
  lowerSegments: readonly string[],
  fileName: string,
  kind?: FileKind,
): boolean {
  if (rule.kinds?.includes(kind ?? "unknown")) return true;
  const configuredSegments = rule.pathSegments?.map((segment) =>
    segment.toLocaleLowerCase(),
  );
  if (configuredSegments?.some((segment) => lowerSegments.includes(segment))) {
    return true;
  }
  if (rule.pathPatterns?.some((pattern) => testPattern(pattern, normalizedPath))) {
    return true;
  }
  return Boolean(
    rule.fileNamePatterns?.some((pattern) => testPattern(pattern, fileName)),
  );
}

function testPattern(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(value);
}

import { normalizeRelativePath } from "./path-utils";

export interface IgnoreRuleInput {
  pattern: string;
  baseDir?: string;
  source?: string;
}

export interface IgnoreDecision {
  ignored: boolean;
  rule?: IgnoreRule;
}

function escapeRegExp(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

/** Translate the subset of gitignore globs that applies to path components. */
function globSource(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    const next = pattern[index + 1];

    if (character === "*" && next === "*") {
      const after = pattern[index + 2];
      if (after === "/") {
        result += "(?:.*/)?";
        index += 2;
      } else {
        result += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      result += "[^/]*";
      continue;
    }
    if (character === "?") {
      result += "[^/]";
      continue;
    }
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing > index + 1) {
        const content = pattern.slice(index + 1, closing);
        const negated = content.startsWith("!") ? `^${content.slice(1)}` : content;
        result += `[${negated.replace(/\\/g, "\\\\")}]`;
        index = closing;
        continue;
      }
    }
    result += escapeRegExp(character);
  }
  return result;
}

function unescapeLeadingMarker(line: string): string {
  if (line.startsWith("\\#") || line.startsWith("\\!")) return line.slice(1);
  return line;
}

function trimGitIgnoreLine(line: string): string {
  // Gitignore treats unescaped trailing spaces as insignificant.
  return line.replace(/(?<!\\)\s+$/u, "").replace(/\\ /g, " ");
}

export class IgnoreRule {
  readonly pattern: string;
  readonly baseDir: string;
  readonly source?: string;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly anchored: boolean;
  private readonly exact: RegExp;
  private readonly descendant: RegExp;

  constructor(input: IgnoreRuleInput) {
    const trimmed = trimGitIgnoreLine(input.pattern);
    this.source = input.source;
    this.baseDir = normalizeRelativePath(input.baseDir ?? "");
    this.negated = trimmed.startsWith("!") && !trimmed.startsWith("\\!");

    let body = this.negated ? trimmed.slice(1) : unescapeLeadingMarker(trimmed);
    this.directoryOnly = body.endsWith("/");
    if (this.directoryOnly) body = body.slice(0, -1);
    this.anchored = body.startsWith("/");
    if (this.anchored) body = body.slice(1);
    this.pattern = body;

    const containsSlash = body.includes("/");
    const prefix = this.anchored || containsSlash ? "^" : "(?:^|/)";
    const source = `${prefix}${globSource(body)}`;
    this.exact = new RegExp(`${source}$`);
    this.descendant = new RegExp(`${source}/`);
  }

  matches(projectPath: string, isDirectory: boolean): boolean {
    const normalized = normalizeRelativePath(projectPath);
    if (
      this.baseDir &&
      normalized !== this.baseDir &&
      !normalized.startsWith(`${this.baseDir}/`)
    ) {
      return false;
    }

    const relative = this.baseDir
      ? normalized.slice(this.baseDir.length).replace(/^\//, "")
      : normalized;
    if (!relative || !this.pattern) return false;

    if (this.descendant.test(relative)) return true;
    return this.exact.test(relative) && (!this.directoryOnly || isDirectory);
  }
}

export function parseIgnoreFile(
  contents: string,
  options: { baseDir?: string; source?: string } = {},
): IgnoreRule[] {
  return parseIgnoreFileDetailed(contents, options).rules;
}

function parseIgnoreFileDetailed(
  contents: string,
  options: { baseDir?: string; source?: string } = {},
): { rules: IgnoreRule[]; invalidCount: number } {
  const rules: IgnoreRule[] = [];
  let invalidCount = 0;
  for (const rawLine of contents.replace(/^\uFEFF/, "").split(/\r?\n/u)) {
    const line = trimGitIgnoreLine(rawLine);
    if (!line || (line.startsWith("#") && !line.startsWith("\\#"))) continue;
    try {
      rules.push(new IgnoreRule({
        pattern: line,
        baseDir: options.baseDir,
        source: options.source,
      }));
    } catch {
      invalidCount += 1;
    }
  }
  return { rules, invalidCount };
}

export class IgnoreMatcher {
  private readonly rules: IgnoreRule[] = [];

  constructor(inputs: readonly (IgnoreRule | IgnoreRuleInput | string)[] = []) {
    this.addAll(inputs);
  }

  add(input: IgnoreRule | IgnoreRuleInput | string): void {
    this.rules.push(
      input instanceof IgnoreRule
        ? input
        : new IgnoreRule(typeof input === "string" ? { pattern: input } : input),
    );
  }

  addAll(inputs: readonly (IgnoreRule | IgnoreRuleInput | string)[]): void {
    for (const input of inputs) this.add(input);
  }

  addFile(
    contents: string,
    options: { baseDir?: string; source?: string } = {},
  ): number {
    const parsed = parseIgnoreFileDetailed(contents, options);
    this.rules.push(...parsed.rules);
    return parsed.invalidCount;
  }

  decide(projectPath: string, isDirectory: boolean): IgnoreDecision {
    let decision: IgnoreDecision = { ignored: false };
    for (const rule of this.rules) {
      if (!rule.matches(projectPath, isDirectory)) continue;
      decision = { ignored: !rule.negated, rule };
    }
    return decision;
  }

  isIgnored(projectPath: string, isDirectory: boolean): boolean {
    return this.decide(projectPath, isDirectory).ignored;
  }

  /**
   * An ignored directory still needs traversal when a later negative rule may
   * re-include a descendant. This keeps the matcher correct without coupling it
   * to any particular repository layout.
   */
  mayReincludeDescendant(projectPath: string): boolean {
    const normalized = normalizeRelativePath(projectPath);
    return this.rules.some((rule) => {
      if (!rule.negated) return false;
      if (!rule.baseDir) return true;
      return (
        rule.baseDir === normalized ||
        rule.baseDir.startsWith(`${normalized}/`) ||
        normalized.startsWith(`${rule.baseDir}/`)
      );
    });
  }

  get size(): number {
    return this.rules.length;
  }
}

import type {
  AnalysisFile,
  Confidence,
  ConfidenceLevel,
  SourcePoint,
  SourceProvenance,
} from "./types";

export function confidence(
  score: number,
  rationale: string,
): Confidence {
  const bounded = Math.min(1, Math.max(0, score));
  let level: ConfidenceLevel = "low";
  if (bounded >= 0.8) level = "high";
  else if (bounded >= 0.5) level = "medium";
  return { score: bounded, level, rationale };
}

export function provenance(
  file: AnalysisFile,
  startOffset: number,
  endOffset: number,
): SourceProvenance {
  const boundedStart = Math.min(
    file.content.length,
    Math.max(0, startOffset),
  );
  const boundedEnd = Math.min(
    file.content.length,
    Math.max(boundedStart, endOffset),
  );
  return {
    path: file.path,
    range: {
      start: pointAt(file.content, boundedStart),
      end: pointAt(file.content, boundedEnd),
    },
  };
}

export function pointAt(content: string, offset: number): SourcePoint {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1, offset };
}

export function offsetOfLine(content: string, oneBasedLine: number): number {
  if (oneBasedLine <= 1) return 0;
  let line = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      line += 1;
      if (line === oneBasedLine) return index + 1;
    }
  }
  return content.length;
}

export function basename(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function extension(path: string): string {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot);
}

export function isProbablyText(file: AnalysisFile): boolean {
  return !file.content.includes("\u0000");
}

export function stableId(...parts: readonly string[]): string {
  // FNV-1a is used for stable finding identity, not for secret fingerprinting.
  let hash = 0x811c9dc5;
  const input = parts.join("\u001f");
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface SourceLiteralContext {
  kind: "string" | "regular-expression";
  start: number;
}

/**
 * Best-effort lexical context for common C-style source languages. It is not a
 * parser, but it is deliberately bounded to the unambiguous cases needed to
 * avoid treating static detector rule literals as runtime configuration.
 */
export function sourceLiteralContextAt(
  file: AnalysisFile,
  offset: number,
): SourceLiteralContext | undefined {
  const boundedOffset = Math.min(Math.max(0, offset), file.content.length);
  const javascriptLike = /\.(?:[cm]?[jt]sx?|vue|svelte)$/iu.test(file.path);
  const hashComments = /\.(?:py|pyw|rb|sh|bash|zsh|ya?ml|toml)$/iu.test(file.path);
  let state: "code" | "string" | "regular-expression" | "line-comment" | "block-comment" = "code";
  let delimiter = "";
  let start = 0;
  let escaped = false;
  let characterClass = false;

  for (let index = 0; index < boundedOffset; index += 1) {
    const character = file.content[index];
    const next = file.content[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "string") {
      if (!escaped && character === delimiter) state = "code";
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      continue;
    }
    if (state === "regular-expression") {
      if (!escaped && character === "[") characterClass = true;
      if (!escaped && character === "]") characterClass = false;
      if (!escaped && !characterClass && character === "/") state = "code";
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      continue;
    }

    if (character === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (hashComments && character === "#") {
      state = "line-comment";
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      state = "string";
      delimiter = character;
      start = index;
      escaped = false;
      continue;
    }
    if (
      javascriptLike &&
      character === "/" &&
      canStartRegularExpression(file.content, index)
    ) {
      state = "regular-expression";
      start = index;
      escaped = false;
      characterClass = false;
    }
  }

  if (state === "string" || state === "regular-expression") {
    return { kind: state, start };
  }
  return undefined;
}

/** True only when a literal is clearly being used to define a matcher. */
export function isLikelyPatternDefinition(
  file: AnalysisFile,
  offset: number,
): boolean {
  const context = sourceLiteralContextAt(file, offset);
  if (!context) return false;
  if (context.kind === "regular-expression") return true;
  const prefix = file.content.slice(Math.max(0, context.start - 180), context.start);
  return (
    /(?:\bnew\s+)?\bRegExp\s*\(\s*$/iu.test(prefix) ||
    /\b(?:Pattern\.compile|Regex|re\.compile|regexp\.(?:Compile|MustCompile)|Regex::new)\s*\(\s*$/iu.test(
      prefix,
    ) ||
    /(?:pattern|regex|regexp|signature|matcher|detector|rule)[A-Za-z0-9_]*\s*[:=]\s*$/iu.test(
      prefix,
    )
  );
}

function canStartRegularExpression(content: string, slashOffset: number): boolean {
  const prefix = content.slice(0, slashOffset).trimEnd();
  if (!prefix) return true;
  const previous = prefix.at(-1) ?? "";
  if (/[([{=,:;!?&|+*%^~<>-]/u.test(previous)) return true;
  return /(?:^|\b)(?:return|case|throw|yield|typeof|instanceof|delete|void|in|of)\s*$/u.test(
    prefix.slice(-40),
  );
}

import type {
  AnalysisFile,
  FileAnalyzer,
} from "../types";
import {
  basename,
  confidence,
  isLikelyPatternDefinition,
  isProbablyText,
  provenance,
  stableId,
} from "../source";
import type { SecurityFinding } from "./types";

interface SecretSignature {
  id: string;
  title: string;
  pattern: RegExp;
  valueGroup?: number;
  rationale: string;
}

interface Candidate {
  ruleId: string;
  title: string;
  start: number;
  end: number;
  value: string;
  score: number;
  rationale: string;
  summary: string;
}

const SIGNATURES: readonly SecretSignature[] = [
  {
    id: "private-key",
    title: "Private key material appears in source",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    rationale: "The value has a recognized private-key envelope.",
  },
  {
    id: "github-token",
    title: "GitHub access token candidate",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{40,255})\b/g,
    rationale: "The value matches a GitHub token prefix and length.",
  },
  {
    id: "aws-access-key",
    title: "AWS access key identifier candidate",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    rationale: "The value matches the format of an AWS access key identifier.",
  },
  {
    id: "slack-token",
    title: "Slack token candidate",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,250}\b/g,
    rationale: "The value matches a Slack token prefix and structure.",
  },
  {
    id: "stripe-live-key",
    title: "Stripe live secret key candidate",
    pattern: /\bsk_live_[A-Za-z0-9]{16,200}\b/g,
    rationale: "The value matches a Stripe live secret-key prefix.",
  },
  {
    id: "google-api-key",
    title: "Google API key candidate",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    rationale: "The value matches the documented Google API key structure.",
  },
  {
    id: "jwt",
    title: "JSON Web Token candidate",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    rationale: "The value has three base64url-like JWT segments.",
  },
];

const SENSITIVE_KEY =
  /(?:^|[_.-])(?:api[_-]?key|access[_-]?key|auth[_-]?token|client[_-]?secret|credential|database[_-]?url|db[_-]?(?:pass|password)|password|passwd|private[_-]?key|secret|token)(?:$|[_.-])/i;

const ASSIGNMENT =
  /(?:^|[\s,{;])(?:export\s+)?(?:(?:const|let|var|final|static|readonly|private|public|protected)\s+)*(?:["']?)([A-Za-z][A-Za-z0-9_.-]{1,100})(?:["']?)\s*(:|=)\s*/gm;

export class SecretAnalyzer implements FileAnalyzer<SecurityFinding> {
  readonly id = "security.secrets";
  readonly domain = "security" as const;

  supports(file: AnalysisFile): boolean {
    const name = basename(file.path).toLowerCase();
    return (
      isProbablyText(file) &&
      !name.endsWith(".lock") &&
      !name.endsWith("-lock.json") &&
      file.content.length <= 5_000_000
    );
  }

  analyze(file: AnalysisFile): readonly SecurityFinding[] {
    const candidates = [
      ...signatureCandidates(file),
      ...assignmentCandidates(file),
    ];
    const specificRanges = candidates.filter((candidate) =>
      candidate.ruleId.startsWith("signature."),
    );
    const deduplicated = candidates
      .filter((candidate) => {
        if (candidate.ruleId.startsWith("signature.")) return true;
        return !specificRanges.some(
          (specific) =>
            specific.start >= candidate.start && specific.end <= candidate.end,
        );
      })
      .filter(
        (candidate, index, all) =>
          all.findIndex(
            (other) =>
              other.start === candidate.start && other.end === candidate.end,
          ) === index,
      );

    return deduplicated.map((candidate) => {
      const location = provenance(file, candidate.start, candidate.end);
      return {
        kind: "finding",
        id: `secret-${stableId(file.path, String(candidate.start), candidate.ruleId)}`,
        analyzerId: this.id,
        ruleId: candidate.ruleId,
        category: "exposed-secret",
        severity: candidate.ruleId === "signature.private-key" ? "critical" : "high",
        title: candidate.title,
        description:
          "A credential-like literal is present in a project file. The analyzer discards the original value and reports only its type, length, and source location.",
        confidence: confidence(candidate.score, candidate.rationale),
        evidence: {
          provenance: location,
          summary: candidate.summary,
          redactedValue: `[REDACTED:${[...candidate.value].length} chars]`,
        },
        remediation:
          "Revoke or rotate the credential, remove it from current and historical source, and load the replacement from an approved secret store or runtime environment.",
        cwe: "CWE-798",
      } satisfies SecurityFinding;
    });
  }
}

function signatureCandidates(file: AnalysisFile): Candidate[] {
  const candidates: Candidate[] = [];
  for (const signature of SIGNATURES) {
    const expression = cloneGlobal(signature.pattern);
    for (const match of file.content.matchAll(expression)) {
      const value = match[signature.valueGroup ?? 0];
      if (!value || match.index === undefined) continue;
      const relative = match[0].indexOf(value);
      const start = match.index + Math.max(0, relative);
      if (isLikelyPatternDefinition(file, start)) continue;
      candidates.push({
        ruleId: `signature.${signature.id}`,
        title: signature.title,
        start,
        end: start + value.length,
        value,
        score: 0.98,
        rationale: signature.rationale,
        summary: `A ${signature.id.replaceAll("-", " ")} signature begins at this location.`,
      });
    }
  }
  return candidates;
}

function assignmentCandidates(file: AnalysisFile): Candidate[] {
  const candidates: Candidate[] = [];
  const expression = cloneGlobal(ASSIGNMENT);
  for (const match of file.content.matchAll(expression)) {
    const key = match[1];
    if (!key || !SENSITIVE_KEY.test(normalizeKey(key)) || match.index === undefined) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    const literal = readLiteral(file.content, valueStart);
    if (!literal || !isCredentialLiteral(literal.value)) continue;
    if (
      match[2] === ":" &&
      !literal.quoted &&
      /\.(?:[cm]?[jt]sx?|py|pyw|java|kt|kts|cs|go|rs)$/i.test(file.path)
    ) {
      // In source languages, an unquoted colon value is commonly a type
      // annotation (`token: string`) rather than a configuration literal.
      continue;
    }
    const examplePath = /(?:^|\/)(?:examples?|fixtures?|tests?|docs?)(?:\/|$)/i.test(
      file.path,
    );
    candidates.push({
      ruleId: "literal.sensitive-assignment",
      title: `Credential-like literal assigned to ${redactIdentifier(key)}`,
      start: literal.start,
      end: literal.end,
      value: literal.value,
      score: examplePath ? 0.68 : 0.9,
      rationale: examplePath
        ? "A sensitive identifier has a literal value, but it is located under an example, fixture, test, or documentation path."
        : "A sensitive identifier is assigned a static literal rather than a runtime reference.",
      summary: `A static value is assigned to a ${secretKind(key)} field.`,
    });
  }
  return candidates;
}

function readLiteral(
  content: string,
  offset: number,
): { value: string; start: number; end: number; quoted: boolean } | undefined {
  let cursor = offset;
  while (cursor < content.length && /[ \t]/.test(content[cursor])) cursor += 1;
  const quote = content[cursor];
  if (quote === '"' || quote === "'" || quote === "`") {
    const start = cursor + 1;
    cursor += 1;
    let escaped = false;
    while (cursor < content.length) {
      const character = content[cursor];
      if (!escaped && character === quote) {
        return {
          value: content.slice(start, cursor),
          start,
          end: cursor,
          quoted: true,
        };
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      if (character === "\n" && quote !== "`") return undefined;
      cursor += 1;
    }
    return undefined;
  }

  const lineEnd = content.indexOf("\n", cursor);
  const endBoundary = lineEnd < 0 ? content.length : lineEnd;
  const raw = content
    .slice(cursor, endBoundary)
    .replace(/\s+(?:#|\/\/).*$/, "")
    .replace(/[,;]\s*$/, "")
    .trimEnd();
  if (!raw) return undefined;
  return { value: raw, start: cursor, end: cursor + raw.length, quoted: false };
}

function isCredentialLiteral(value: string): boolean {
  const normalized = value.trim();
  if (normalized.length < 4 || normalized.length > 20_000) return false;
  if (
    /^(?:null|undefined|none|true|false|0|string|number|boolean|unknown|any|object|str|bytes|["']?[x*._-]{3,}["']?)$/i.test(
      normalized,
    )
  ) {
    return false;
  }
  if (
    /^\/(?:\\.|[^/\n])+\/[dgimsuvy]*$/u.test(normalized) ||
    /^(?:new\s+)?RegExp\s*\(/u.test(normalized)
  ) {
    return false;
  }
  if (
    /(?:process\.env|os\.getenv|system\.getenv|import\.meta\.env|secret(?:s|manager)?[.([]|vault[.([]|\$\{|\{\{|<[^>]*(?:secret|token|password)[^>]*>)/i.test(
      normalized,
    )
  ) {
    return false;
  }
  return true;
}

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function secretKind(key: string): string {
  const normalized = normalizeKey(key);
  if (normalized.includes("password") || normalized.includes("passwd")) {
    return "password";
  }
  if (normalized.includes("private") && normalized.includes("key")) {
    return "private-key";
  }
  if (normalized.includes("url")) return "credential-bearing URL";
  if (normalized.includes("token")) return "access-token";
  if (normalized.includes("key")) return "API or access-key";
  return "secret";
}

function redactIdentifier(key: string): string {
  return `<${secretKind(key)} field>`;
}

function cloneGlobal(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

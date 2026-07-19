import type {
  AnalysisFile,
  FileAnalyzer,
} from "../types";
import {
  basename,
  confidence,
  isProbablyText,
  provenance,
  sourceLiteralContextAt,
  stableId,
} from "../source";
import type {
  SecurityCategory,
  SecurityFinding,
  SecuritySeverity,
} from "./types";

export interface RiskPatternRule {
  id: string;
  title: string;
  description: string;
  category: SecurityCategory;
  severity: SecuritySeverity;
  pattern: RegExp;
  evidenceSummary: string;
  remediation: string;
  confidence: number;
  rationale: string;
  cwe?: string;
  appliesTo?: (file: AnalysisFile) => boolean;
}

const JAVASCRIPT = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);
const PYTHON = new Set(["py", "pyw"]);

export const DEFAULT_RISK_RULES: readonly RiskPatternRule[] = [
  {
    id: "javascript-eval",
    title: "Dynamic JavaScript evaluation",
    description:
      "eval executes text as code in the current context and can turn attacker-controlled data into code execution.",
    category: "unsafe-execution",
    severity: "high",
    pattern: /\beval\s*\(/g,
    evidenceSummary: "A call to eval begins at this location.",
    remediation:
      "Replace dynamic code evaluation with explicit parsing, a constrained expression evaluator, or a fixed dispatch table.",
    confidence: 0.88,
    rationale: "The source contains a direct eval call.",
    cwe: "CWE-95",
    appliesTo: (file) => JAVASCRIPT.has(fileExtension(file.path)),
  },
  {
    id: "javascript-function-constructor",
    title: "Dynamic Function constructor",
    description:
      "Constructing a function from text has code-injection characteristics similar to eval.",
    category: "unsafe-execution",
    severity: "high",
    pattern: /\bnew\s+Function\s*\(/g,
    evidenceSummary: "A dynamic Function constructor begins at this location.",
    remediation:
      "Use explicit functions or a constrained parser instead of compiling strings as JavaScript.",
    confidence: 0.9,
    rationale: "The source directly constructs executable code from text.",
    cwe: "CWE-95",
    appliesTo: (file) => JAVASCRIPT.has(fileExtension(file.path)),
  },
  {
    id: "node-shell-exec",
    title: "Command executed through a system shell",
    description:
      "Shell-based process execution can interpret metacharacters when any command fragment is influenced by input.",
    category: "injection",
    severity: "high",
    pattern: /\b(?:(?:child_process|childProcess)\s*\.\s*)?(?:exec|execSync)\s*\(/g,
    evidenceSummary: "A shell-based Node.js process execution call begins here.",
    remediation:
      "Prefer execFile or spawn with a fixed executable and an argument array; validate any user-controlled argument separately.",
    confidence: 0.76,
    rationale:
      "The API invokes a shell, although reachability from untrusted input requires data-flow confirmation.",
    cwe: "CWE-78",
    appliesTo: (file) => JAVASCRIPT.has(fileExtension(file.path)),
  },
  {
    id: "python-dynamic-execution",
    title: "Dynamic Python evaluation",
    description:
      "Python eval or exec can execute attacker-controlled text as code.",
    category: "unsafe-execution",
    severity: "high",
    pattern: /\b(?:eval|exec)\s*\(/g,
    evidenceSummary: "A Python eval or exec call begins at this location.",
    remediation:
      "Use a purpose-built parser and a fixed operation dispatch table instead of evaluating source text.",
    confidence: 0.87,
    rationale: "The source contains a direct Python eval or exec call.",
    cwe: "CWE-95",
    appliesTo: (file) => PYTHON.has(fileExtension(file.path)),
  },
  {
    id: "subprocess-shell",
    title: "Python subprocess uses a shell",
    description:
      "Passing a command through a shell enables metacharacter interpretation and may lead to command injection.",
    category: "injection",
    severity: "high",
    pattern: /\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\([\s\S]{0,500}?shell\s*=\s*True/g,
    evidenceSummary: "A subprocess call enables shell interpretation.",
    remediation:
      "Pass a fixed executable and argument list with shell=False, and validate each externally controlled argument.",
    confidence: 0.84,
    rationale: "A subprocess API explicitly enables the system shell.",
    cwe: "CWE-78",
    appliesTo: (file) => PYTHON.has(fileExtension(file.path)),
  },
  {
    id: "sql-string-interpolation",
    title: "SQL statement constructed with interpolation",
    description:
      "Building SQL by concatenating or interpolating values can create an injection path when the value is externally controlled.",
    category: "injection",
    severity: "high",
    pattern:
      /\b(?:query|execute|executemany|raw|unsafe|createNativeQuery)\s*\(\s*(?:`[^`\n]*\$\{|f["'][^"'\n]*\{|["'][^"'\n]*["']\s*\+)/g,
    evidenceSummary: "A database execution call receives an interpolated or concatenated SQL expression.",
    remediation:
      "Use the database driver's parameter binding or the ORM's typed query builder; never splice values into SQL text.",
    confidence: 0.86,
    rationale:
      "String construction is visible at the database call site, although input trust still needs data-flow confirmation.",
    cwe: "CWE-89",
    appliesTo: isSourceFile,
  },
  {
    id: "tls-verification-disabled",
    title: "TLS certificate verification disabled",
    description:
      "Disabling certificate verification makes encrypted connections vulnerable to interception.",
    category: "transport-security",
    severity: "high",
    pattern:
      /(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0))/g,
    evidenceSummary: "A transport client explicitly disables certificate verification.",
    remediation:
      "Restore certificate and hostname verification. Configure the correct CA bundle for private certificate authorities.",
    confidence: 0.97,
    rationale: "A recognized TLS verification control is explicitly disabled.",
    cwe: "CWE-295",
    appliesTo: isSourceOrConfigFile,
  },
  {
    id: "cors-wildcard",
    title: "Broad cross-origin access",
    description:
      "A wildcard CORS origin can expose an API to browser requests from untrusted sites, especially when credentials or sensitive responses are involved.",
    category: "access-control",
    severity: "medium",
    pattern:
      /(?:Access-Control-Allow-Origin["']?\s*[:,=]\s*["']\*|(?:allowedOrigins|allow_origins|origin)\s*[:=]\s*\[?\s*["']\*["'])/g,
    evidenceSummary: "A CORS configuration allows every origin.",
    remediation:
      "Allow only the origins required by the deployed clients and keep credentialed requests disabled unless explicitly needed.",
    confidence: 0.83,
    rationale: "A recognized CORS setting contains the wildcard origin.",
    cwe: "CWE-942",
    appliesTo: isSourceOrConfigFile,
  },
  {
    id: "unsafe-deserialization-python",
    title: "Unsafe Python deserialization",
    description:
      "pickle and unrestricted YAML loading can instantiate arbitrary objects from untrusted data.",
    category: "unsafe-deserialization",
    severity: "high",
    pattern: /\b(?:pickle\.loads?\s*\(|yaml\.load\s*\((?![\s\S]{0,200}?SafeLoader))/g,
    evidenceSummary: "An unsafe deserialization API is called at this location.",
    remediation:
      "Use a data-only format such as JSON, or yaml.safe_load/SafeLoader, and validate the decoded structure.",
    confidence: 0.8,
    rationale:
      "A deserializer capable of object construction is used; exploitability depends on whether the input is trusted.",
    cwe: "CWE-502",
    appliesTo: (file) => PYTHON.has(fileExtension(file.path)),
  },
  {
    id: "weak-password-hash",
    title: "Weak cryptographic hash",
    description:
      "MD5 and SHA-1 are unsuitable for password hashing and collision-sensitive security operations.",
    category: "cryptography",
    severity: "medium",
    pattern:
      /(?:createHash\s*\(\s*["'](?:md5|sha1)["']|hashlib\.(?:md5|sha1)\s*\(|MessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-?1)["'])/gi,
    evidenceSummary: "A weak cryptographic hash algorithm is selected.",
    remediation:
      "For passwords use Argon2id, scrypt, bcrypt, or PBKDF2 with reviewed parameters; for integrity use SHA-256 or stronger as appropriate.",
    confidence: 0.7,
    rationale:
      "The algorithm is weak for security uses, but the analyzer cannot infer whether this call is security-sensitive.",
    cwe: "CWE-328",
    appliesTo: isSourceFile,
  },
  {
    id: "container-privileged",
    title: "Container granted privileged execution",
    description:
      "Privileged containers receive broad host capabilities and can substantially weaken workload isolation.",
    category: "configuration",
    severity: "high",
    pattern: /\b(?:privileged|allowPrivilegeEscalation)\s*:\s*true\b/g,
    evidenceSummary: "A container configuration enables privileged execution or escalation.",
    remediation:
      "Remove privileged mode, disable privilege escalation, run as a non-root user, and add only the capabilities the workload demonstrably requires.",
    confidence: 0.96,
    rationale: "A container privilege control is explicitly enabled.",
    cwe: "CWE-250",
    appliesTo: isDeploymentConfig,
  },
  {
    id: "container-root-user",
    title: "Container explicitly runs as root",
    description:
      "Running the application as root increases the impact of a container escape or application compromise.",
    category: "configuration",
    severity: "medium",
    pattern: /(?:^\s*USER\s+(?:root|0)\s*$|\brunAsUser\s*:\s*0\b)/gm,
    evidenceSummary: "The workload explicitly selects the root user.",
    remediation:
      "Create and select a dedicated unprivileged user and grant only the filesystem permissions required at runtime.",
    confidence: 0.95,
    rationale: "The container user is explicitly root or UID 0.",
    cwe: "CWE-250",
    appliesTo: isDeploymentConfig,
  },
  {
    id: "insecure-download",
    title: "Dependency or build artifact downloaded over HTTP",
    description:
      "An unencrypted artifact download can be modified in transit when no independent integrity check is enforced.",
    category: "supply-chain",
    severity: "medium",
    pattern: /\b(?:curl|wget|ADD)\s+(?:[^\n]*\s)?http:\/\//g,
    evidenceSummary: "A build or automation command downloads an artifact over plain HTTP.",
    remediation:
      "Use HTTPS and verify a pinned cryptographic digest or a trusted signature before consuming the artifact.",
    confidence: 0.86,
    rationale: "The command uses an unencrypted HTTP URL.",
    cwe: "CWE-494",
    appliesTo: isAutomationOrDeploymentFile,
  },
];

export class RiskPatternAnalyzer implements FileAnalyzer<SecurityFinding> {
  readonly id = "security.risky-patterns";
  readonly domain = "security" as const;
  readonly #rules: readonly RiskPatternRule[];

  constructor(rules: readonly RiskPatternRule[] = DEFAULT_RISK_RULES) {
    this.#rules = rules;
  }

  supports(file: AnalysisFile): boolean {
    return (
      isProbablyText(file) &&
      file.content.length <= 5_000_000 &&
      this.#rules.some((rule) => !rule.appliesTo || rule.appliesTo(file))
    );
  }

  analyze(file: AnalysisFile): readonly SecurityFinding[] {
    const findings: SecurityFinding[] = [];
    for (const rule of this.#rules) {
      if (rule.appliesTo && !rule.appliesTo(file)) continue;
      const expression = cloneGlobal(rule.pattern);
      for (const match of file.content.matchAll(expression)) {
        if (
          match.index === undefined ||
          isCommentOnlyMatch(file.content, match.index) ||
          (isSourceFile(file) && sourceLiteralContextAt(file, match.index)) ||
          (rule.id === "node-shell-exec" &&
            !isNodeShellExecution(file.content, match.index, match[0]))
        ) {
          continue;
        }
        findings.push({
          kind: "finding",
          id: `risk-${stableId(file.path, rule.id, String(match.index))}`,
          analyzerId: this.id,
          ruleId: rule.id,
          category: rule.category,
          severity: rule.severity,
          title: rule.title,
          description: rule.description,
          confidence: confidence(
            rule.confidence,
            rule.rationale,
          ),
          evidence: {
            provenance: provenance(
              file,
              match.index,
              match.index + match[0].length,
            ),
            summary: rule.evidenceSummary,
          },
          remediation: rule.remediation,
          cwe: rule.cwe,
        });
      }
    }
    return findings;
  }
}

function fileExtension(path: string): string {
  const name = basename(path).toLowerCase();
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index + 1);
}

function isSourceFile(file: AnalysisFile): boolean {
  return /^(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyw|java|kt|kts|go|rs|rb|php|cs|scala|sh|bash|zsh)$/.test(
    fileExtension(file.path),
  );
}

function isSourceOrConfigFile(file: AnalysisFile): boolean {
  return (
    isSourceFile(file) ||
    /^(?:json|jsonc|ya?ml|toml|ini|conf|config|properties|env)$/.test(
      fileExtension(file.path),
    ) ||
    basename(file.path).toLowerCase().startsWith(".env")
  );
}

function isDeploymentConfig(file: AnalysisFile): boolean {
  const name = basename(file.path).toLowerCase();
  return (
    name === "dockerfile" ||
    name.startsWith("dockerfile.") ||
    /(?:^|\/)(?:docker-compose|compose)(?:\.[^.]+)?\.ya?ml$/i.test(file.path) ||
    /(?:^|\/)(?:k8s|kubernetes|helm|charts?)(?:\/|$)/i.test(file.path) ||
    /\.ya?ml$/i.test(file.path)
  );
}

function isAutomationOrDeploymentFile(file: AnalysisFile): boolean {
  const name = basename(file.path).toLowerCase();
  return (
    isDeploymentConfig(file) ||
    name === "makefile" ||
    name.endsWith(".sh") ||
    /(?:^|\/)\.github\/workflows\//.test(file.path)
  );
}

function isCommentOnlyMatch(content: string, offset: number): boolean {
  const lineStart = content.lastIndexOf("\n", offset - 1) + 1;
  const prefix = content.slice(lineStart, offset).trimStart();
  return prefix.startsWith("//") || prefix.startsWith("#") || prefix.startsWith("--");
}

function isNodeShellExecution(
  content: string,
  offset: number,
  matchedText: string,
): boolean {
  const callName = matchedText.match(/(?:execSync|exec)(?=\s*\()/u)?.[0];
  if (!callName) return false;
  if (/\b(?:child_process|childProcess)\s*\.\s*(?:execSync|exec)\s*\(/u.test(matchedText)) {
    return true;
  }
  const receiverPrefix = content.slice(Math.max(0, offset - 80), offset);
  if (/(?:\bchild_process|\bchildProcess)\s*\.\s*$/u.test(receiverPrefix)) {
    return true;
  }
  if (/\.\s*$/u.test(receiverPrefix)) return false;

  const beforeCall = content.slice(0, offset);
  for (const match of beforeCall.matchAll(
    /\bimport\s*\{([^}]*)\}\s*from\s*["'](?:node:)?child_process["']/gu,
  )) {
    if (namedBindingMatches(match[1], callName)) return true;
  }
  for (const match of beforeCall.matchAll(
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*["'](?:node:)?child_process["']\s*\)/gu,
  )) {
    if (destructuredBindingMatches(match[1], callName)) return true;
  }
  return false;
}

function namedBindingMatches(bindings: string, callName: string): boolean {
  return bindings.split(",").some((binding) => {
    const [imported, local = imported] = binding.trim().split(/\s+as\s+/u);
    return imported === callName && local === callName;
  });
}

function destructuredBindingMatches(bindings: string, callName: string): boolean {
  return bindings.split(",").some((binding) => {
    const [imported, local = imported] = binding.trim().split(/\s*:\s*/u);
    return imported === callName && local === callName;
  });
}

function cloneGlobal(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

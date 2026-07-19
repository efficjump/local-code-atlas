const SENSITIVE_KEY =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie)\b/i;

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----.*$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const SENSITIVE_QUERY_VALUE =
  /([?&](?:access[_-]?token|api[_-]?key|key|password|secret|signature|sig|x-amz-signature)=)[^&#\s]+/gi;
const WELL_KNOWN_TOKEN =
  /\b(?:AKIA[0-9A-Z]{16}|(?:gh[opsu]_[A-Za-z0-9]{20,})|(?:sk-[A-Za-z0-9_-]{20,}))\b/g;
const ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie)(\s*[=:]\s*)(["'`]?)([^\s,;)}\]"'`]+|[^"'`]*)(\3)/gi;

export interface RedactionOptions {
  maxLength?: number;
}

/**
 * Redact common credential shapes before a source excerpt crosses a core API
 * boundary. This is deliberately conservative: losing a little context is
 * preferable to emitting a plausible secret.
 */
export function redactSensitiveText(
  input: string,
  options: RedactionOptions = {},
): string {
  const maxLength = Math.max(32, options.maxLength ?? 240);
  let value = input.replace(/[\r\n\t]+/g, " ").trim();

  if (PRIVATE_KEY_BLOCK.test(value)) return "[REDACTED PRIVATE KEY]";

  value = value
    .replace(JWT, "[REDACTED JWT]")
    .replace(BEARER, "$1[REDACTED]")
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(SENSITIVE_QUERY_VALUE, "$1[REDACTED]")
    .replace(WELL_KNOWN_TOKEN, "[REDACTED TOKEN]")
    .replace(ASSIGNMENT, (_match, key, separator) => `${key}${separator}[REDACTED]`);

  // A sensitive-looking line that could not be parsed safely should not be
  // returned verbatim (for example shell export syntax with unusual quoting).
  if (SENSITIVE_KEY.test(value) && /[=:]/.test(value) && !value.includes("[REDACTED]")) {
    return "[REDACTED SENSITIVE LINE]";
  }

  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function looksLikeSecretFile(relativePath: string): boolean {
  const name = relativePath.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === ".env.example" || name === ".env.sample" || name.endsWith(".example")) {
    return false;
  }
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    /\.(pem|p12|pfx|key|keystore|jks)$/i.test(name) ||
    /^(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(name)
  );
}

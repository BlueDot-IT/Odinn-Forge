const SENSITIVE_METADATA_ATOMS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authentication",
  "authorization",
  "bearer",
  "botsecret",
  "bottoken",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "idtoken",
  "jwt",
  "password",
  "passwordhash",
  "passwords",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "secrets",
  "token",
  "tokens"
]);

const SENSITIVE_METADATA_SHORTHANDS = new Set([
  "cred",
  "creds",
  "pwd"
]);

const SENSITIVE_MATERIAL_QUALIFIERS = [
  "base64url",
  "ciphertext",
  "configured",
  "fingerprint",
  "plaintext",
  "references",
  "signature",
  "base64",
  "contents",
  "encrypted",
  "encryption",
  "material",
  "present",
  "reference",
  "sha512",
  "sha384",
  "sha256",
  "sha224",
  "encoded",
  "headers",
  "values",
  "content",
  "digest",
  "header",
  "policy",
  "sha1",
  "string",
  "value",
  "blob",
  "bytes",
  "data",
  "env",
  "hash",
  "hex",
  "md5",
  "mode",
  "pem",
  "raw",
  "salt",
  "salted"
] as const;

const compactQualifierPattern = new RegExp(
  `^(?:${SENSITIVE_MATERIAL_QUALIFIERS.join("|")})+$`,
  "u"
);

const SENSITIVE_APPLICATION_VALUE_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|capability(?:[_-]?token)?|token|authorization|cookie|credentials?|password(?:[_-]?hash)?|passwd|secret|client[_-]?secret|bot[_-]?(?:secret|token)|private[_-]?key)\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/iu,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/iu,
  /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/iu,
  /\b(?:gh[pousr]_|github_pat_|glpat-|npm_|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bAIza[A-Za-z0-9_-]{30,}\b/u,
  /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{16,}\b/u,
  /\b(?:sk|rk)(?:[_-](?:live|test))?[_-][A-Za-z0-9_-]{8,}\b/u,
  /\b(?:access|refresh|id|api|client|bot)[ _-]?(?:key|token|secret)\s*(?:is|[:=])?\s*[A-Za-z0-9._~+\/-]{8,}\b/iu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\b(?:mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/u,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/iu,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u
];

/** Classify string values that appear to contain credential material. */
export function containsSensitiveApplicationValue(value: string): boolean {
  return SENSITIVE_APPLICATION_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Reject metadata keys whose visual representation and comparison form can
 * disagree. Application metadata is a machine contract, so ASCII field names
 * are intentional; user-facing text belongs in field values.
 */
export function isAmbiguousApplicationMetadataKey(key: string): boolean {
  return key.length === 0
    || key.normalize("NFKC") !== key
    || !/^[\x20-\x7e]+$/u.test(key);
}

/**
 * Classify fields that could directly carry credential or secret material.
 *
 * No field is globally exempt here. A known non-secret projection such as an
 * environment-variable reference or presence boolean must be admitted by its
 * owning schema at an exact path and with its exact value type. Generic and
 * plugin-defined metadata therefore fail closed.
 */
export function isSensitiveApplicationMetadataKey(key: string): boolean {
  if (isAmbiguousApplicationMetadataKey(key)) return true;
  const normalized = normalizeMetadataKey(key);
  if (SENSITIVE_METADATA_ATOMS.has(normalized)) return true;

  const words = metadataKeyWords(key);
  if (words.some((word) => SENSITIVE_METADATA_ATOMS.has(word) || SENSITIVE_METADATA_SHORTHANDS.has(word))) {
    return true;
  }
  for (let index = 0; index < words.length - 1; index += 1) {
    const pair = `${words[index]}${words[index + 1]}`;
    if (SENSITIVE_METADATA_ATOMS.has(pair)) return true;
  }

  for (const atom of SENSITIVE_METADATA_ATOMS) {
    let offset = normalized.indexOf(atom);
    while (offset >= 0) {
      const trailing = normalized.slice(offset + atom.length);
      if (trailing.length === 0 || compactQualifierPattern.test(trailing)) return true;
      offset = normalized.indexOf(atom, offset + 1);
    }
  }
  return false;
}

function normalizeMetadataKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]+/gu, "").toLowerCase();
}

function metadataKeyWords(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

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

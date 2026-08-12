const SAFE_APPLICATION_METADATA_KEYS = new Set([
  "apikeyenv",
  "authentication",
  "authorizationdecisionreferences",
  "authorizationstatus",
  "authmode",
  "cookiepolicy",
  "credentialconfigured",
  "credentialpresent",
  "credentialsconfigured",
  "credentialspresent",
  "secretreferences",
  "secretsexcludedfromdiagnostics",
  "tokenenv"
]);

const SENSITIVE_METADATA_ATOMS = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "botsecret",
  "bottoken",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "idtoken",
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

const SENSITIVE_METADATA_SUFFIXES = [
  "passwordhash",
  "privatekey",
  "clientsecret",
  "refreshtoken",
  "accesstoken",
  "bottoken",
  "botsecret",
  "idtoken",
  "apikey",
  "auth",
  "authorization",
  "credentials",
  "credential",
  "passwords",
  "password",
  "passwd",
  "cookies",
  "cookie",
  "secrets",
  "secret",
  "tokens",
  "token"
] as const;

const SENSITIVE_MATERIAL_QUALIFIERS = [
  "blob",
  "bytes",
  "content",
  "contents",
  "ciphertext",
  "data",
  "digest",
  "encoded",
  "header",
  "headers",
  "hash",
  "material",
  "pem",
  "string",
  "value",
  "values"
] as const;

/**
 * Classify fields that could directly carry credential or secret material.
 *
 * This deliberately recognizes semantic words and compound suffixes rather
 * than arbitrary substrings: `databasePassword` is protected while ordinary
 * words such as `secretary`, `tokenize`, and `monkey` remain usable. Explicit
 * non-secret projection fields are allowlisted because their schemas expose
 * presence, configuration, environment-variable names, or aggregate state —
 * never credential material.
 */
export function isSensitiveApplicationMetadataKey(key: string): boolean {
  const normalized = normalizeMetadataKey(key);
  if (SAFE_APPLICATION_METADATA_KEYS.has(normalized)) return false;
  if (SENSITIVE_METADATA_ATOMS.has(normalized)) return true;

  const words = metadataKeyWords(key);
  if (words.some((word) => SENSITIVE_METADATA_ATOMS.has(word))) return true;
  for (let index = 0; index < words.length - 1; index += 1) {
    const pair = `${words[index]}${words[index + 1]}`;
    if (SENSITIVE_METADATA_ATOMS.has(pair)) return true;
  }

  return SENSITIVE_METADATA_SUFFIXES.some((suffix) => (
    normalized.endsWith(suffix)
    || SENSITIVE_MATERIAL_QUALIFIERS.some((qualifier) => normalized.endsWith(`${suffix}${qualifier}`))
  ));
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

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { cwd as currentWorkingDirectory } from "node:process";
import { parseEnv } from "node:util";

export type EnvironmentLoadOptions = {
  workspaceRoot?: string;
  stateDir?: string;
  environment?: NodeJS.ProcessEnv;
  protectedKeys?: Iterable<string>;
  /** Only these workspace keys may be copied into the process environment. */
  workspaceAllowedKeys?: Iterable<string>;
  /** Kept for compatibility with direct callers; startup code uses readEnvironmentFiles. */
  applyToEnvironment?: boolean;
};

export const OPERATOR_ONLY_ENVIRONMENT_KEYS = new Set([
  "ODINN_CHROMIUM_PATH",
  "ODINN_EXTENSION_CONTAINER_RUNTIME",
  "ODINN_SEARCH_ENDPOINT"
]);

export type LoadedEnvironmentFile = {
  path: string;
  keys: string[];
  source?: "workspace" | "state";
};

export type ParsedEnvironmentFiles = {
  workspace: NodeJS.ProcessEnv;
  state: NodeJS.ProcessEnv;
  loaded: LoadedEnvironmentFile[];
};

const CREDENTIAL_ENV_FIELDS = new Set([
  "apiKeyEnv", "tokenEnv", "clientIdEnv", "clientSecretEnv", "accessTokenEnv", "refreshTokenEnv",
  "appTokenEnv", "appIdEnv", "tenantIdEnv", "appSecretEnv", "verifyTokenEnv"
]);
const CREDENTIAL_ENV_NAME = /(?:API_KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID|CLIENT_SECRET|APP_ID|TENANT_ID)$/u;
const CHILD_ENV_BLOCKLIST = new Set([
  "NODE_OPTIONS", "NODE_PATH", "INIT_CWD", "ODINN_STATE_DIR", "ODINN_HOST", "ODINN_PORT", "ODINN_ALLOW_REMOTE", "ODINN_GATEWAY_AUTH",
  "ODINN_ANTIGRAVITY_CLI", "ODINN_CHROMIUM_PATH", "ODINN_EXTENSION_CONTAINER_RUNTIME", "ODINN_SEARCH_ENDPOINT", "ODINN_USER_PASSWORD",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED"
]);
const RESERVED_CREDENTIAL_ENVIRONMENT_KEYS = new Set([
  ...CHILD_ENV_BLOCKLIST,
  ...OPERATOR_ONLY_ENVIRONMENT_KEYS,
]);

/** Return only environment names explicitly referenced as credential inputs by config. */
export function configuredCredentialEnvironmentKeys(config: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (CREDENTIAL_ENV_FIELDS.has(key)
        && typeof child === "string"
        && isAllowedCredentialEnvironmentKey(child)) keys.add(child);
      visit(child);
    }
  };
  visit(config);
  return keys;
}

export function isCredentialEnvironmentName(value: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/u.test(value) && CREDENTIAL_ENV_NAME.test(value);
}

export function isAllowedCredentialEnvironmentKey(value: string): boolean {
  return isCredentialEnvironmentName(value) && !RESERVED_CREDENTIAL_ENVIRONMENT_KEYS.has(value);
}

/** Resolve both paths physically and fail closed when containment cannot be established. */
export function isPhysicalPathInside(root: string, candidate: string): boolean {
  try {
    const relation = relative(realpathSync(root), realpathSync(candidate));
    return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
  } catch {
    return false;
  }
}

/** Build an explicit child environment from the already-classified process environment. */
export function sanitizedChildEnvironment(environment: NodeJS.ProcessEnv = process.env, additionalKeys: Iterable<string> = []): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  const explicitlyConfigured = new Set(additionalKeys);
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || CHILD_ENV_BLOCKLIST.has(key) || key.startsWith("LD_") || key.startsWith("DYLD_")) continue;
    if (explicitlyConfigured.has(key) || key === "PATH" || key === "SystemRoot" || key === "HOME" || key === "USERPROFILE" || key === "TMP" || key === "TEMP" || key === "TMPDIR" || key.startsWith("LC_") || isCredentialEnvironmentName(key)) child[key] = value;
  }
  if (process.platform === "win32" && environment.SystemRoot) child.SystemRoot = environment.SystemRoot;
  return child;
}

function safeEnvironmentPath(path: string): string {
  return path.replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|authorization|secret)\s*[=:])[^/\\\s]+/giu, "$1[redacted]");
}

const environmentFileEntries = (workspaceRoot: string, stateDir: string) => {
  const root = resolve(workspaceRoot);
  const state = isAbsolute(stateDir) ? resolve(stateDir) : resolve(root, stateDir);
  return [[join(root, ".env"), "workspace"], [join(state, ".env"), "state"]] as const;
};

/**
 * Read environment files without mutating process-global state. Workspace and
 * operator state are deliberately returned as separate maps so callers can
 * apply only the values allowed at their trust boundary.
 */
export function readEnvironmentFiles({
  workspaceRoot = currentWorkingDirectory(),
  stateDir = ".odinn"
}: Pick<EnvironmentLoadOptions, "workspaceRoot" | "stateDir"> = {}): ParsedEnvironmentFiles {
  const workspace: NodeJS.ProcessEnv = {};
  const state: NodeJS.ProcessEnv = {};
  const loaded: LoadedEnvironmentFile[] = [];
  const seen = new Set<string>();
  for (const [path, source] of environmentFileEntries(workspaceRoot, stateDir)) {
    let metadata;
    try { metadata = lstatSync(path); }
    catch (error: any) { if (error?.code === "ENOENT") continue; throw error; }
    if (metadata.isSymbolicLink()) throw new Error(`environment file must not be a symbolic link: ${safeEnvironmentPath(path)}`);
    if (!metadata.isFile()) throw new Error(`environment path is not a regular file: ${safeEnvironmentPath(path)}`);
    const resolvedPath = resolve(path);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    const values = parseEnv(readFileSync(path, "utf8"));
    const target = source === "workspace" && resolve(workspaceRoot) !== resolve(stateDir) ? workspace : state;
    for (const [key, value] of Object.entries(values)) if (value !== undefined) target[key] = value;
    loaded.push({ path: resolvedPath, source, keys: Object.keys(values).sort() });
  }
  return { workspace, state, loaded };
}

export function applyEnvironmentValues(
  values: NodeJS.ProcessEnv,
  environment: NodeJS.ProcessEnv,
  { protectedKeys = [], allowedKeys }: { protectedKeys?: Iterable<string>; allowedKeys?: Iterable<string> } = {}
): void {
  const protectedEnvironmentKeys = new Set(protectedKeys);
  const allowed = allowedKeys ? new Set(allowedKeys) : undefined;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || protectedEnvironmentKeys.has(key) || (allowed && !allowed.has(key))) continue;
    environment[key] = value;
  }
}

export function assertPhysicalDirectory(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error(`state directory must be a physical directory: ${safeEnvironmentPath(path)}`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * Load conventional workspace and state environment files without replacing
 * variables supplied by the parent process. State-local values take precedence
 * over workspace values, and duplicate paths are loaded only once.
 */
export function loadEnvironmentFiles({
  workspaceRoot = currentWorkingDirectory(),
  stateDir = ".odinn",
  environment = process.env,
  protectedKeys = Object.keys(environment),
  workspaceAllowedKeys = [],
  applyToEnvironment = true
}: EnvironmentLoadOptions = {}): LoadedEnvironmentFile[] {
  const parsed = readEnvironmentFiles({ workspaceRoot, stateDir });
  if (applyToEnvironment) {
    applyEnvironmentValues(parsed.workspace, environment, { protectedKeys, allowedKeys: workspaceAllowedKeys });
    applyEnvironmentValues(parsed.state, environment, { protectedKeys });
  }
  return parsed.loaded;
}

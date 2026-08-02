import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";

export type EnvironmentLoadOptions = {
  workspaceRoot?: string;
  stateDir?: string;
  environment?: NodeJS.ProcessEnv;
  protectedKeys?: Iterable<string>;
};

export const OPERATOR_ONLY_ENVIRONMENT_KEYS = new Set([
  "ODINN_CHROMIUM_PATH",
  "ODINN_EXTENSION_CONTAINER_RUNTIME",
  "ODINN_SEARCH_ENDPOINT"
]);

export type LoadedEnvironmentFile = {
  path: string;
  keys: string[];
};

/**
 * Load conventional workspace and state environment files without replacing
 * variables supplied by the parent process. State-local values take precedence
 * over workspace values, and duplicate paths are loaded only once.
 */
export function loadEnvironmentFiles({
  workspaceRoot = process.cwd(),
  stateDir = ".odinn",
  environment = process.env,
  protectedKeys = Object.keys(environment)
}: EnvironmentLoadOptions = {}): LoadedEnvironmentFile[] {
  const root = resolve(workspaceRoot);
  const state = isAbsolute(stateDir) ? resolve(stateDir) : resolve(root, stateDir);
  const protectedEnvironmentKeys = new Set(protectedKeys);
  const loadedValues = new Map<string, string>();
  const loaded: LoadedEnvironmentFile[] = [];
  const seen = new Set<string>();

  for (const [path, source] of [[join(root, ".env"), "workspace"], [join(state, ".env"), "state"]] as const) {
    if (!existsSync(path)) continue;
    const resolvedPath = realpathSync(path);
    if (seen.has(resolvedPath)) continue;
    seen.add(resolvedPath);
    if (!statSync(resolvedPath).isFile()) throw new Error(`environment path is not a regular file: ${path}`);
    const values = parseEnv(readFileSync(resolvedPath, "utf8"));
    for (const [key, value] of Object.entries(values)) {
      if (
        value !== undefined
        && !protectedEnvironmentKeys.has(key)
        && (source !== "workspace" || !OPERATOR_ONLY_ENVIRONMENT_KEYS.has(key))
      ) loadedValues.set(key, value);
    }
    loaded.push({ path: resolvedPath, keys: Object.keys(values).sort() });
  }

  for (const [key, value] of loadedValues) environment[key] = value;
  return loaded;
}

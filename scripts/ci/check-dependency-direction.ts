import { glob, readFile, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * Every permitted production-workspace edge is explicit. Keep this table in
 * sync with docs/architecture/package-dependency-graph.md.
 */
export const WORKSPACE_DEPENDENCY_GRAPH = {
  "@odinn/application": [],
  "@odinn/channel-discord": ["@odinn/channels"],
  "@odinn/channel-slack": ["@odinn/channels"],
  "@odinn/channel-teams": ["@odinn/channels"],
  "@odinn/channel-telegram": ["@odinn/channels"],
  "@odinn/channel-whatsapp": ["@odinn/channels"],
  "@odinn/channels": ["@odinn/store-file"],
  "@odinn/cli": [
    "@odinn/application",
    "@odinn/gateway",
    "@odinn/kernel",
    "@odinn/policy",
    "@odinn/runtime",
  ],
  "@odinn/gateway": [
    "@odinn/application",
    "@odinn/channel-discord",
    "@odinn/channel-slack",
    "@odinn/channel-teams",
    "@odinn/channel-telegram",
    "@odinn/channel-whatsapp",
    "@odinn/channels",
    "@odinn/kernel",
    "@odinn/policy",
    "@odinn/runtime",
    "@odinn/store-file",
  ],
  "@odinn/kernel": [
    "@odinn/channels",
    "@odinn/policy",
    "@odinn/protocol",
    "@odinn/store-file",
    "@odinn/store-sqlite",
  ],
  "@odinn/policy": [],
  "@odinn/protocol": [],
  "@odinn/runtime": ["@odinn/channel-discord", "@odinn/kernel"],
  "@odinn/store-file": ["@odinn/protocol"],
  "@odinn/store-sqlite": ["@odinn/protocol"],
} as const satisfies AllowedDependencyGraph;

export type AllowedDependencyGraph = Readonly<Record<string, readonly string[]>>;

export const DEPENDENCY_RULES = {
  adapterToAdapter: "adapters cannot depend on another adapter",
  crossPackageSourcePath: "cross-package imports must use an exported workspace package specifier",
  dependencyAliasSpecifier: "file, link, and npm dependency aliases are unsupported in production workspace packages",
  missingGraphPackage: "allowed dependency graph packages must be discovered from pnpm-workspace.yaml",
  packageImportAlias: "package.json imports aliases are unsupported in production workspace packages",
  packageToApp: "packages and adapters cannot depend on apps",
  privateWorkspaceSubpath: "workspace imports must use package.json exports",
  typescriptPathAlias: "TypeScript paths aliases are unsupported for production workspace architecture",
  undeclaredWorkspaceDependency: "workspace source imports must be declared in package.json",
  unknownGraphTarget: "allowed dependency graph targets must name discovered graph packages",
  unknownWorkspaceTarget: "@odinn and workspace protocol dependencies must resolve to a workspace package",
  unregisteredWorkspacePackage: "workspace packages must be registered in the allowed dependency graph",
  unsupportedModuleLoader: "indirect require and createRequire module loaders are unsupported",
  workspaceDependencyIdentity: "workspace dependencies must use their canonical name and exact workspace:* specifier",
  workspaceDynamicImports: "workspace packages cannot use non-literal dynamic imports",
  workspaceGraph: "workspace dependencies must follow the allowed package graph",
} as const;

export type DependencyRule = typeof DEPENDENCY_RULES[keyof typeof DEPENDENCY_RULES];

export type ImportKind =
  | "dynamic-import"
  | "export-declaration"
  | "import-declaration"
  | "import-equals"
  | "import-type"
  | "manifest-dependency"
  | "module-loader"
  | "package-import-alias"
  | "require-call"
  | "typescript-path-alias"
  | "workspace-graph"
  | "workspace-package";

export interface DependencyViolation {
  sourceFile: string;
  line: number;
  column: number;
  specifier: string;
  kind: ImportKind;
  rule: DependencyRule;
}

export interface LegacyDependencyBaselineEntry {
  sourceFile: string;
  specifier: string;
  kind: ImportKind;
  rule: DependencyRule;
  expectedOccurrences: number;
  removal: string;
}

export interface DependencyDirectionResult {
  scannedFileCount: number;
  scannedManifestCount: number;
  violations: readonly DependencyViolation[];
  baselineErrors: readonly string[];
  acceptedLegacyOccurrences: number;
}

type ImportReference = Omit<DependencyViolation, "rule">;
type WorkspacePackageKind = "adapter" | "app" | "package";
type PackageTargetResolution = "blocked" | "invalid" | "resolved" | "unmatched";

interface ManifestDependency {
  name: string;
  version: string;
  line: number;
  column: number;
}

interface ManifestAlias {
  name: string;
  line: number;
  column: number;
}

interface WorkspacePackage {
  name: string;
  kind: WorkspacePackageKind;
  directory: string;
  repositoryManifestPath: string;
  exports: unknown;
  dependencies: readonly ManifestDependency[];
  dependencyNames: ReadonlySet<string>;
  packageImports: readonly ManifestAlias[];
}

interface WorkspaceImportTarget {
  target: WorkspacePackage;
  packageSubpath?: string;
  crossesSourceBoundary: boolean;
}

const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const nonLiteralSpecifier = "<non-literal module specifier>";
const unsupportedModuleLoader = "<unsupported module loader>";

export const LEGACY_DEPENDENCY_BASELINE: readonly LegacyDependencyBaselineEntry[] = [];

function repositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function isPathInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function sourceFiles(directory: string, excludedDirectories: ReadonlySet<string> = new Set()): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules" && !excludedDirectories.has(absolutePath)) {
        files.push(...await sourceFiles(absolutePath, excludedDirectories));
      }
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function configurationFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules") {
        files.push(...await configurationFiles(absolutePath));
      }
    } else if (entry.isFile() && /^(?:jsconfig|tsconfig)(?:\.[^.]+)*\.json$/u.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

function yamlScalar(rawValue: string, sourceFile: string, line: number): string {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    const match = /^("(?:\\.|[^"\\])*")(?:\s+#.*)?$/u.exec(value);
    if (!match) throw new Error(`${sourceFile}:${line}: unsupported quoted workspace package glob`);
    const parsed: unknown = JSON.parse(match[1]!);
    if (typeof parsed !== "string") throw new Error(`${sourceFile}:${line}: workspace package glob must be a string`);
    return parsed;
  }
  if (value.startsWith("'")) {
    const match = /^'((?:''|[^'])*)'(?:\s+#.*)?$/u.exec(value);
    if (!match) throw new Error(`${sourceFile}:${line}: unsupported quoted workspace package glob`);
    return match[1]!.replaceAll("''", "'");
  }
  return value.replace(/\s+#.*$/u, "").trim();
}

function parseWorkspacePackageGlobs(content: string): string[] {
  const sourceFile = "pnpm-workspace.yaml";
  const lines = content.split(/\r?\n/u);
  let packagesIndent: number | undefined;
  const patterns: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (packagesIndent === undefined) {
      const packages = /^(\s*)packages\s*:\s*(?:#.*)?$/u.exec(line);
      if (packages) packagesIndent = packages[1]!.length;
      continue;
    }
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const indentation = /^\s*/u.exec(line)![0].length;
    if (indentation <= packagesIndent) break;
    const item = /^\s*-\s+(.+)$/u.exec(line);
    if (!item) throw new Error(`${sourceFile}:${index + 1}: packages must be a scalar YAML list`);
    const pattern = yamlScalar(item[1]!, sourceFile, index + 1);
    const unsigned = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (!unsigned || isAbsolute(unsigned) || unsigned.split(/[\\/]/u).includes("..")) {
      throw new Error(`${sourceFile}:${index + 1}: workspace package glob must remain relative to the repository`);
    }
    patterns.push(pattern.replace(/^\.\//u, "").replaceAll("\\", "/").replace(/\/$/u, ""));
  }
  if (packagesIndent === undefined || patterns.length === 0) {
    throw new Error(`${sourceFile}: packages must contain at least one workspace glob`);
  }
  return [...new Set(patterns)];
}

async function expandWorkspaceGlob(repositoryRoot: string, pattern: string): Promise<Set<string>> {
  const manifests = new Set<string>();
  for await (const candidate of glob(`${pattern}/package.json`, { cwd: repositoryRoot })) {
    const normalized = candidate.replaceAll("\\", "/");
    if (normalized.split("/").some((segment) => segment === "dist" || segment === "node_modules")) continue;
    const absolutePath = resolve(repositoryRoot, candidate);
    if (!isPathInside(repositoryRoot, absolutePath)) {
      throw new Error(`workspace package glob escaped repository: ${JSON.stringify(pattern)}`);
    }
    manifests.add(absolutePath);
  }
  return manifests;
}

async function workspaceManifestFiles(repositoryRoot: string): Promise<string[]> {
  const workspaceFile = resolve(repositoryRoot, "pnpm-workspace.yaml");
  const patterns = parseWorkspacePackageGlobs(await readFile(workspaceFile, "utf8"));
  const manifests = new Set<string>();
  for (const pattern of patterns.filter((candidate) => !candidate.startsWith("!"))) {
    for (const manifestPath of await expandWorkspaceGlob(repositoryRoot, pattern)) manifests.add(manifestPath);
  }
  for (const pattern of patterns.filter((candidate) => candidate.startsWith("!"))) {
    for (const manifestPath of await expandWorkspaceGlob(repositoryRoot, pattern.slice(1))) manifests.delete(manifestPath);
  }
  return [...manifests].sort((left, right) => repositoryPath(repositoryRoot, left)
    .localeCompare(repositoryPath(repositoryRoot, right)));
}

function lineAndColumn(content: string, index: number): { line: number; column: number } {
  const prefix = content.slice(0, Math.max(0, index));
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function manifestStringLocation(content: string, value: string): { line: number; column: number } {
  return lineAndColumn(content, content.indexOf(JSON.stringify(value)));
}

function manifestDependencies(content: string, manifest: Record<string, unknown>): ManifestDependency[] {
  const dependencies: ManifestDependency[] = [];
  for (const field of dependencyFields) {
    const values = manifest[field];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [name, version] of Object.entries(values as Record<string, unknown>)) {
      if (typeof version !== "string") continue;
      dependencies.push({ name, version, ...manifestStringLocation(content, name) });
    }
  }
  return dependencies.sort((left, right) => left.name.localeCompare(right.name)
    || left.line - right.line);
}

function manifestPackageImports(content: string, manifest: Record<string, unknown>): ManifestAlias[] {
  if (manifest.imports === undefined) return [];
  if (!manifest.imports || typeof manifest.imports !== "object" || Array.isArray(manifest.imports)) {
    return [{ name: "<invalid imports map>", ...manifestStringLocation(content, "imports") }];
  }
  return Object.keys(manifest.imports as Record<string, unknown>)
    .map((name) => ({ name, ...manifestStringLocation(content, name) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function workspacePackageKind(repositoryManifestPath: string): WorkspacePackageKind {
  if (repositoryManifestPath.startsWith("adapters/")) return "adapter";
  if (repositoryManifestPath.startsWith("apps/")) return "app";
  return "package";
}

async function workspacePackages(repositoryRoot: string): Promise<WorkspacePackage[]> {
  const manifestPaths = await workspaceManifestFiles(repositoryRoot);
  const packages = await Promise.all(manifestPaths.map(async (manifestPath): Promise<WorkspacePackage> => {
    const content = await readFile(manifestPath, "utf8");
    const manifest: unknown = JSON.parse(content);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`${repositoryPath(repositoryRoot, manifestPath)} must contain a JSON object`);
    }
    const record = manifest as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) {
      throw new Error(`${repositoryPath(repositoryRoot, manifestPath)} must declare a package name`);
    }
    const dependencies = manifestDependencies(content, record);
    return {
      name: record.name,
      kind: workspacePackageKind(repositoryPath(repositoryRoot, manifestPath)),
      directory: dirname(manifestPath),
      repositoryManifestPath: repositoryPath(repositoryRoot, manifestPath),
      exports: record.exports,
      dependencies,
      dependencyNames: new Set(dependencies.map(({ name }) => name)),
      packageImports: manifestPackageImports(content, record),
    };
  }));
  const names = new Set<string>();
  for (const workspacePackage of packages) {
    if (names.has(workspacePackage.name)) {
      throw new Error(`duplicate workspace package name ${JSON.stringify(workspacePackage.name)}`);
    }
    names.add(workspacePackage.name);
  }
  return packages.sort((left, right) => left.repositoryManifestPath.localeCompare(right.repositoryManifestPath));
}

function stringSpecifier(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function propertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return stringSpecifier(node.argumentExpression);
  return undefined;
}

function isDirectCallTarget(node: ts.Node): boolean {
  return Boolean(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node);
}

function extractImportReferences(
  repositoryRoot: string,
  absolutePath: string,
  content: string,
): ImportReference[] {
  const source = ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true);
  const sourceFile = repositoryPath(repositoryRoot, absolutePath);
  const references: ImportReference[] = [];

  const record = (
    node: ts.Node,
    specifierNode: ts.Node | undefined,
    kind: ImportKind,
    requireLiteral = true,
    syntheticSpecifier?: string,
  ): void => {
    const specifier = syntheticSpecifier
      ?? stringSpecifier(specifierNode)
      ?? (requireLiteral ? undefined : nonLiteralSpecifier);
    if (specifier === undefined) return;
    const location = source.getLineAndCharacterOfPosition(specifierNode?.getStart(source) ?? node.getStart(source));
    references.push({
      sourceFile,
      line: location.line + 1,
      column: location.character + 1,
      specifier,
      kind,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      record(node, node.moduleSpecifier, "import-declaration");
      const moduleName = stringSpecifier(node.moduleSpecifier);
      if (moduleName === "node:module" || moduleName === "module") {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if ((element.propertyName ?? element.name).text === "createRequire") {
              record(element, undefined, "module-loader", true, unsupportedModuleLoader);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      record(node, node.moduleSpecifier, "export-declaration");
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      record(node, node.moduleReference.expression, "import-equals");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node, node.argument.literal, "import-type");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node, node.arguments[0], "dynamic-import", false);
      } else if ((ts.isIdentifier(node.expression) && node.expression.text === "require")
        || propertyName(node.expression) === "require") {
        record(node, node.arguments[0], "require-call", false);
      }
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && propertyName(node) === "require" && !isDirectCallTarget(node)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && propertyName(node) === "createRequire") {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isBindingElement(node)
      && ((node.propertyName && ts.isIdentifier(node.propertyName)
        && (node.propertyName.text === "createRequire" || node.propertyName.text === "require"))
        || (ts.isIdentifier(node.name) && node.name.text === "createRequire"))) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isIdentifier(node) && node.text === "require") {
      const directRequire = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
      const propertyNameIdentifier = node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
      const bindingPropertyIdentifier = node.parent && ts.isBindingElement(node.parent) && node.parent.propertyName === node;
      if (!directRequire && !propertyNameIdentifier && !bindingPropertyIdentifier) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function normalizedSpecifier(specifier: string): string {
  return specifier.replaceAll("\\", "/").split(/[?#]/u, 1)[0] ?? "";
}

function packageForPath(packages: readonly WorkspacePackage[], absolutePath: string): WorkspacePackage | undefined {
  return [...packages]
    .sort((left, right) => right.directory.length - left.directory.length)
    .find((workspacePackage) => isPathInside(workspacePackage.directory, absolutePath));
}

function workspaceImportTarget(
  repositoryRoot: string,
  sourcePackage: WorkspacePackage,
  sourceFile: string,
  specifier: string,
  packages: readonly WorkspacePackage[],
): WorkspaceImportTarget | undefined {
  const normalized = normalizedSpecifier(specifier);
  const packageTarget = [...packages]
    .sort((left, right) => right.name.length - left.name.length)
    .find(({ name }) => normalized === name || normalized.startsWith(`${name}/`));
  if (packageTarget) {
    return {
      target: packageTarget,
      packageSubpath: normalized === packageTarget.name
        ? "."
        : `./${normalized.slice(packageTarget.name.length + 1)}`,
      crossesSourceBoundary: false,
    };
  }

  let absoluteTarget: string | undefined;
  if (normalized.startsWith(".")) {
    absoluteTarget = resolve(dirname(resolve(repositoryRoot, sourceFile)), normalized);
  } else if (/^(?:adapters|apps|packages)\//u.test(normalized)) {
    absoluteTarget = resolve(repositoryRoot, normalized);
  } else if (isAbsolute(normalized)) {
    absoluteTarget = resolve(normalized);
  }
  if (!absoluteTarget || !isPathInside(repositoryRoot, absoluteTarget)) return undefined;
  const target = packageForPath(packages, absoluteTarget);
  if (!target) return undefined;
  const repositoryRootSpecifier = /^(?:adapters|apps|packages)\//u.test(normalized) || isAbsolute(normalized);
  if (target.name === sourcePackage.name && !repositoryRootSpecifier) return undefined;
  return { target, crossesSourceBoundary: true };
}

function validExportTarget(target: string, patternMatch?: string): boolean {
  if (!target.startsWith("./")) return false;
  const resolved = patternMatch === undefined ? target : target.replaceAll("*", patternMatch);
  const segments = resolved.slice(2).split("/");
  return segments.every((segment) => segment !== ".." && segment.toLowerCase() !== "node_modules");
}

function resolvePackageTarget(
  target: unknown,
  conditions: ReadonlySet<string>,
  patternMatch?: string,
): PackageTargetResolution {
  if (target === null) return "blocked";
  if (typeof target === "string") return validExportTarget(target, patternMatch) ? "resolved" : "invalid";
  if (Array.isArray(target)) {
    if (target.length === 0) return "blocked";
    for (const candidate of target) {
      const resolution = resolvePackageTarget(candidate, conditions, patternMatch);
      if (resolution === "invalid" || resolution === "unmatched") continue;
      return resolution;
    }
    return "invalid";
  }
  if (!target || typeof target !== "object") return "invalid";
  for (const [condition, candidate] of Object.entries(target as Record<string, unknown>)) {
    if (condition === "default" || conditions.has(condition)) {
      const resolution = resolvePackageTarget(candidate, conditions, patternMatch);
      if (resolution !== "unmatched") return resolution;
    }
  }
  return "unmatched";
}

function conditionsForImport(kind: ImportKind): ReadonlySet<string> {
  if (kind === "require-call" || kind === "import-equals") {
    return new Set(["node", "require"]);
  }
  if (kind === "import-type") return new Set(["types", "node", "import"]);
  return new Set(["node", "import"]);
}

function matchingExportPattern(key: string, subpath: string): string | undefined {
  const wildcard = key.indexOf("*");
  if (wildcard < 0) return undefined;
  const prefix = key.slice(0, wildcard);
  const suffix = key.slice(wildcard + 1);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)
    || subpath.length < prefix.length + suffix.length) return undefined;
  return subpath.slice(prefix.length, subpath.length - suffix.length);
}

function compareExportPatterns(left: string, right: string): number {
  const leftWildcard = left.indexOf("*");
  const rightWildcard = right.indexOf("*");
  if (leftWildcard !== rightWildcard) return rightWildcard - leftWildcard;
  return right.length - left.length;
}

function exportedSubpath(exportsValue: unknown, subpath: string, kind: ImportKind): boolean {
  const conditions = conditionsForImport(kind);
  if (typeof exportsValue === "string" || Array.isArray(exportsValue) || exportsValue === null) {
    return subpath === "." && resolvePackageTarget(exportsValue, conditions) === "resolved";
  }
  if (!exportsValue || typeof exportsValue !== "object") return false;
  const exportsMap = exportsValue as Record<string, unknown>;
  const keys = Object.keys(exportsMap);
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    return subpath === "." && resolvePackageTarget(exportsMap, conditions) === "resolved";
  }
  if (subpathKeys.length !== keys.length) return false;
  if (Object.hasOwn(exportsMap, subpath) && !subpath.includes("*")) {
    return resolvePackageTarget(exportsMap[subpath], conditions) === "resolved";
  }
  const patterns = subpathKeys
    .filter((key) => key.includes("*") && matchingExportPattern(key, subpath) !== undefined)
    .sort(compareExportPatterns);
  const selected = patterns[0];
  if (!selected) return false;
  return resolvePackageTarget(
    exportsMap[selected],
    conditions,
    matchingExportPattern(selected, subpath),
  ) === "resolved";
}

function graphRule(
  source: WorkspacePackage,
  target: WorkspacePackage,
  allowedGraph: AllowedDependencyGraph,
): DependencyRule | undefined {
  if (source.name === target.name) return undefined;
  if (source.kind !== "app" && target.kind === "app") return DEPENDENCY_RULES.packageToApp;
  if (source.kind === "adapter" && target.kind === "adapter") return DEPENDENCY_RULES.adapterToAdapter;
  return allowedGraph[source.name]?.includes(target.name) ? undefined : DEPENDENCY_RULES.workspaceGraph;
}

function unknownWorkspaceTarget(specifier: string): boolean {
  return normalizedSpecifier(specifier).startsWith("@odinn/");
}

function sourceViolationRule(
  repositoryRoot: string,
  sourcePackage: WorkspacePackage,
  reference: ImportReference,
  packages: readonly WorkspacePackage[],
  allowedGraph: AllowedDependencyGraph,
): DependencyRule | undefined {
  if (reference.kind === "module-loader") return DEPENDENCY_RULES.unsupportedModuleLoader;
  if (reference.specifier === nonLiteralSpecifier) return DEPENDENCY_RULES.workspaceDynamicImports;
  if (reference.specifier.startsWith("#")) return DEPENDENCY_RULES.packageImportAlias;
  const target = workspaceImportTarget(
    repositoryRoot,
    sourcePackage,
    reference.sourceFile,
    reference.specifier,
    packages,
  );
  if (!target) {
    return unknownWorkspaceTarget(reference.specifier) ? DEPENDENCY_RULES.unknownWorkspaceTarget : undefined;
  }
  if (target.crossesSourceBoundary) return DEPENDENCY_RULES.crossPackageSourcePath;
  if (target.packageSubpath && !exportedSubpath(target.target.exports, target.packageSubpath, reference.kind)) {
    return DEPENDENCY_RULES.privateWorkspaceSubpath;
  }
  const directionRule = graphRule(sourcePackage, target.target, allowedGraph);
  if (directionRule) return directionRule;
  if (sourcePackage.name !== target.target.name && !sourcePackage.dependencyNames.has(target.target.name)) {
    return DEPENDENCY_RULES.undeclaredWorkspaceDependency;
  }
  return undefined;
}

function packageNameFromAlias(version: string): string | undefined {
  const alias = /^(?:npm|workspace):(.+)$/u.exec(version)?.[1];
  if (!alias || alias.startsWith(".") || alias.startsWith("/")) return undefined;
  if (alias.startsWith("@")) {
    const slash = alias.indexOf("/");
    if (slash < 0) return undefined;
    const versionSeparator = alias.indexOf("@", slash);
    return versionSeparator < 0 ? alias : alias.slice(0, versionSeparator);
  }
  const versionSeparator = alias.indexOf("@");
  return versionSeparator < 0 ? alias : alias.slice(0, versionSeparator);
}

function dependencyAliasTarget(
  dependency: ManifestDependency,
  sourcePackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
): WorkspacePackage | undefined {
  const namedAlias = packageNameFromAlias(dependency.version);
  if (namedAlias) return packagesByName.get(namedAlias);
  const pathAlias = /^(?:file|link|workspace):(.+)$/u.exec(dependency.version)?.[1];
  if (!pathAlias || (!pathAlias.startsWith(".") && !isAbsolute(pathAlias))) return undefined;
  let decodedPath = pathAlias;
  try {
    decodedPath = decodeURIComponent(pathAlias);
  } catch {
    return undefined;
  }
  const absolutePath = resolve(sourcePackage.directory, decodedPath);
  return packages.find((workspacePackage) => workspacePackage.directory === absolutePath);
}

function manifestViolations(
  workspacePackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  allowedGraph: AllowedDependencyGraph,
): DependencyViolation[] {
  const violations: DependencyViolation[] = workspacePackage.packageImports.map((entry) => ({
    sourceFile: workspacePackage.repositoryManifestPath,
    line: entry.line,
    column: entry.column,
    specifier: entry.name,
    kind: "package-import-alias",
    rule: DEPENDENCY_RULES.packageImportAlias,
  }));
  for (const dependency of workspacePackage.dependencies) {
    const target = packagesByName.get(dependency.name);
    const aliasTarget = dependencyAliasTarget(dependency, workspacePackage, packages, packagesByName);
    let rule: DependencyRule | undefined;
    if (/^(?:file|link|npm):/u.test(dependency.version)) {
      rule = DEPENDENCY_RULES.dependencyAliasSpecifier;
    } else if (target && dependency.version !== "workspace:*") {
      rule = DEPENDENCY_RULES.workspaceDependencyIdentity;
    } else if (aliasTarget && aliasTarget.name !== dependency.name) {
      rule = DEPENDENCY_RULES.workspaceDependencyIdentity;
    } else if (target) {
      rule = graphRule(workspacePackage, target, allowedGraph);
    } else if (dependency.name.startsWith("@odinn/") || dependency.version.startsWith("workspace:")) {
      rule = DEPENDENCY_RULES.unknownWorkspaceTarget;
    }
    if (rule) {
      violations.push({
        sourceFile: workspacePackage.repositoryManifestPath,
        line: dependency.line,
        column: dependency.column,
        specifier: dependency.name,
        kind: "manifest-dependency",
        rule,
      });
    }
  }
  return violations;
}

function graphIntegrityViolations(
  packages: readonly WorkspacePackage[],
  allowedGraph: AllowedDependencyGraph,
): DependencyViolation[] {
  const packagesByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const violations: DependencyViolation[] = [];
  for (const workspacePackage of packages) {
    if (!Object.hasOwn(allowedGraph, workspacePackage.name)) {
      violations.push({
        sourceFile: workspacePackage.repositoryManifestPath,
        line: 1,
        column: 1,
        specifier: workspacePackage.name,
        kind: "workspace-package",
        rule: DEPENDENCY_RULES.unregisteredWorkspacePackage,
      });
    }
  }
  for (const [source, targets] of Object.entries(allowedGraph)) {
    if (!packagesByName.has(source)) {
      violations.push({
        sourceFile: "pnpm-workspace.yaml",
        line: 1,
        column: 1,
        specifier: source,
        kind: "workspace-graph",
        rule: DEPENDENCY_RULES.missingGraphPackage,
      });
    }
    for (const target of targets) {
      if (!Object.hasOwn(allowedGraph, target) || !packagesByName.has(target)) {
        violations.push({
          sourceFile: "pnpm-workspace.yaml",
          line: 1,
          column: 1,
          specifier: `${source} -> ${target}`,
          kind: "workspace-graph",
          rule: DEPENDENCY_RULES.unknownGraphTarget,
        });
      }
    }
  }
  return violations;
}

async function typescriptPathViolations(repositoryRoot: string): Promise<DependencyViolation[]> {
  const violations: DependencyViolation[] = [];
  for (const configPath of await configurationFiles(repositoryRoot)) {
    const content = await readFile(configPath, "utf8");
    const rawConfig = ts.parseConfigFileTextToJson(configPath, content).config as
      | { compilerOptions?: { paths?: Record<string, unknown> } }
      | undefined;
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    });
    const aliases = new Set([
      ...Object.keys(rawConfig?.compilerOptions?.paths ?? {}),
      ...Object.keys(parsed?.options.paths ?? {}),
    ]);
    for (const alias of [...aliases].sort()) {
      const location = manifestStringLocation(content, alias);
      violations.push({
        sourceFile: repositoryPath(repositoryRoot, configPath),
        line: location.line,
        column: location.column,
        specifier: alias,
        kind: "typescript-path-alias",
        rule: DEPENDENCY_RULES.typescriptPathAlias,
      });
    }
  }
  return violations;
}

function baselineKey(entry: Pick<LegacyDependencyBaselineEntry, "sourceFile" | "specifier" | "kind" | "rule">): string {
  return JSON.stringify([entry.sourceFile, entry.specifier, entry.kind, entry.rule]);
}

export async function checkDependencyDirection(
  repositoryRoot: string,
  baseline: readonly LegacyDependencyBaselineEntry[] = LEGACY_DEPENDENCY_BASELINE,
  allowedGraph: AllowedDependencyGraph = WORKSPACE_DEPENDENCY_GRAPH,
): Promise<DependencyDirectionResult> {
  const packages = await workspacePackages(repositoryRoot);
  const packagesByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const packageDirectories = new Set(packages.map((workspacePackage) => workspacePackage.directory));
  const packageFiles = await Promise.all(packages.map(async (workspacePackage) => ({
    workspacePackage,
    files: await sourceFiles(
      workspacePackage.directory,
      new Set([...packageDirectories].filter((directory) => directory !== workspacePackage.directory
        && isPathInside(workspacePackage.directory, directory))),
    ),
  })));
  const references = (await Promise.all(packageFiles.flatMap(({ workspacePackage, files }) =>
    files.map(async (absolutePath) => ({
      workspacePackage,
      references: extractImportReferences(repositoryRoot, absolutePath, await readFile(absolutePath, "utf8")),
    }))))).flat();
  const candidates = [
    ...graphIntegrityViolations(packages, allowedGraph),
    ...packages.flatMap((workspacePackage) => manifestViolations(
      workspacePackage,
      packages,
      packagesByName,
      allowedGraph,
    )),
    ...await typescriptPathViolations(repositoryRoot),
    ...references.flatMap(({ workspacePackage, references: fileReferences }) =>
      fileReferences.flatMap((reference): DependencyViolation[] => {
        const rule = sourceViolationRule(
          repositoryRoot,
          workspacePackage,
          reference,
          packages,
          allowedGraph,
        );
        return rule ? [{ ...reference, rule }] : [];
      })),
  ].sort((left, right) => left.sourceFile.localeCompare(right.sourceFile)
    || left.line - right.line
    || left.column - right.column
    || left.specifier.localeCompare(right.specifier)
    || left.rule.localeCompare(right.rule));

  const baselineErrors: string[] = [];
  const baselineKeys = new Set<string>();
  const accepted = new Set<DependencyViolation>();
  for (const entry of baseline) {
    const key = baselineKey(entry);
    if (baselineKeys.has(key)) {
      baselineErrors.push(`${entry.sourceFile}: duplicate legacy dependency baseline for ${entry.kind} ${JSON.stringify(entry.specifier)} [rule: ${entry.rule}]`);
      continue;
    }
    baselineKeys.add(key);
    if (!Number.isSafeInteger(entry.expectedOccurrences) || entry.expectedOccurrences < 1) {
      baselineErrors.push(`${entry.sourceFile}: legacy dependency baseline expectedOccurrences must be a positive integer for ${JSON.stringify(entry.specifier)}`);
      continue;
    }
    const matches = candidates.filter((candidate) => baselineKey(candidate) === key);
    for (const match of matches.slice(0, entry.expectedOccurrences)) accepted.add(match);
    if (matches.length < entry.expectedOccurrences) {
      baselineErrors.push(
        `${entry.sourceFile}: stale legacy dependency baseline expected ${entry.expectedOccurrences} ${entry.kind} occurrence(s) of ${JSON.stringify(entry.specifier)} but found ${matches.length}; ${entry.removal}`,
      );
    }
  }

  return {
    scannedFileCount: packageFiles.reduce((count, { files }) => count + files.length, 0),
    scannedManifestCount: packages.length,
    violations: candidates.filter((candidate) => !accepted.has(candidate)),
    baselineErrors,
    acceptedLegacyOccurrences: accepted.size,
  };
}

export function formatDependencyViolation(violation: DependencyViolation): string {
  const subject = violation.kind === "manifest-dependency"
    || violation.kind === "package-import-alias"
    || violation.kind === "workspace-graph"
    || violation.kind === "workspace-package"
    ? "dependency"
    : violation.kind === "module-loader" || violation.kind === "typescript-path-alias"
      ? "construct"
      : "import";
  return `${violation.sourceFile}:${violation.line}:${violation.column}: forbidden ${subject} ${JSON.stringify(violation.specifier)} [rule: ${violation.rule}]`;
}

async function main(): Promise<void> {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const result = await checkDependencyDirection(repositoryRoot);
  if (result.violations.length || result.baselineErrors.length) {
    console.error("dependency direction check failed");
    for (const violation of result.violations) console.error(formatDependencyViolation(violation));
    for (const error of result.baselineErrors) console.error(`legacy baseline error: ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `dependency direction check passed (${result.scannedManifestCount} package manifests, ${result.scannedFileCount} source files, ${result.acceptedLegacyOccurrences} temporary legacy occurrences)`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();

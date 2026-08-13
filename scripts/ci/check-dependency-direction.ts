import { glob, lstat, readFile, readdir, realpath } from "node:fs/promises";
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
  crossPackageExportTarget: "workspace package exports cannot target another workspace package",
  crossPackageSourcePath: "cross-package imports must use an exported workspace package specifier",
  dependencyAliasSpecifier: "file, link, and npm dependency aliases are unsupported in production workspace packages",
  encodedModuleSpecifier: "percent-encoded module specifiers are unsupported in production workspace packages",
  executableExportTarget: "workspace exports must use statically auditable source or inert JSON targets",
  missingGraphPackage: "allowed dependency graph packages must be discovered from pnpm-workspace.yaml",
  packageImportAlias: "package.json imports aliases are unsupported in production workspace packages",
  packageToApp: "packages and adapters cannot depend on apps",
  physicalExportTarget: "workspace exports must resolve to an existing regular file inside their package",
  privateWorkspaceSubpath: "workspace imports must use package.json exports",
  unscannedSourcePath: "production file references must remain in the scanned source of their workspace package",
  productionSymlink: "production workspace packages cannot contain symbolic links",
  typescriptPathAlias: "TypeScript paths aliases are unsupported for production workspace architecture",
  undeclaredWorkspaceDependency: "workspace source imports must be declared in package.json",
  unknownGraphTarget: "allowed dependency graph targets must name discovered graph packages",
  unknownWorkspaceTarget: "@odinn and workspace protocol dependencies must resolve to a workspace package",
  unregisteredWorkspacePackage: "workspace packages must be registered in the allowed dependency graph",
  unsupportedModuleLoader: "indirect, private, or runtime-generated module loaders are unsupported",
  urlModuleSpecifier: "URL module specifiers are unsupported in production workspace packages",
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
  | "manifest-export"
  | "module-loader"
  | "package-import-alias"
  | "require-call"
  | "triple-slash-reference"
  | "typescript-path-alias"
  | "workspace-graph"
  | "workspace-package"
  | "workspace-symlink";

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

type ModuleResolutionMode = "import" | "require";
type ImportReference = Omit<DependencyViolation, "rule"> & {
  filesystemReference?: boolean;
  resolutionMode?: ModuleResolutionMode;
  typeOnly?: boolean;
};
type WorkspacePackageKind = "adapter" | "app" | "package";
type PackageTargetResolution =
  | { status: "blocked" | "invalid" | "unmatched" }
  | { status: "resolved"; target: string };

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

interface ManifestExportTarget {
  target: string;
  line: number;
  column: number;
}

interface WorkspacePackage {
  name: string;
  kind: WorkspacePackageKind;
  directory: string;
  physicalDirectory: string;
  repositoryManifestPath: string;
  moduleType: "commonjs" | "module";
  exports: unknown;
  exportTargets: readonly ManifestExportTarget[];
  dependencies: readonly ManifestDependency[];
  dependencyNames: ReadonlySet<string>;
  packageImports: readonly ManifestAlias[];
}

interface WorkspaceImportTarget {
  target: WorkspacePackage;
  packageSubpath?: string;
  crossesSourceBoundary: boolean;
}

interface SourceInventory {
  files: readonly string[];
  violations: readonly DependencyViolation[];
}

interface PackageExportAudit {
  files: ReadonlySet<string>;
  violations: readonly DependencyViolation[];
}

const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const inertExportExtensions = new Set([".json"]);
const unscannedPackageDirectories = new Set(["bower_components", "dist", "node_modules"]);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const nonLiteralSpecifier = "<non-literal module specifier>";
const unsupportedModuleLoader = "<unsupported module loader>";

function isExportedSourceTarget(path: string): boolean {
  const extension = extname(path).toLowerCase();
  return extension === "" || sourceExtensions.has(extension);
}

function isAuditableExportTarget(path: string): boolean {
  return isExportedSourceTarget(path) || inertExportExtensions.has(extname(path).toLowerCase());
}

export const LEGACY_DEPENDENCY_BASELINE: readonly LegacyDependencyBaselineEntry[] = [];

function repositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function isPathInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function physicalPathWithoutLinks(repositoryRoot: string, candidate: string, label: string): Promise<string> {
  if (!isPathInside(repositoryRoot, candidate)) {
    throw new Error(`${label} must remain inside the physical repository root`);
  }
  const path = relative(repositoryRoot, candidate);
  let current = repositoryRoot;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`${label} must not traverse symbolic link ${repositoryPath(repositoryRoot, current)}`);
    }
  }
  const physical = await realpath(candidate);
  if (!isPathInside(repositoryRoot, physical)) {
    throw new Error(`${label} resolves outside the physical repository root`);
  }
  return physical;
}

async function sourceInventory(
  repositoryRoot: string,
  directory: string,
  excludedDirectories: ReadonlySet<string> = new Set(),
  explicitSourceFiles: ReadonlySet<string> = new Set(),
  includeSourceFiles = true,
): Promise<SourceInventory> {
  const files: string[] = [];
  const violations: DependencyViolation[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.name === "node_modules" || entry.name === "bower_components"
      || excludedDirectories.has(absolutePath)) continue;
    if (entry.isSymbolicLink()) {
      const sourceFile = repositoryPath(repositoryRoot, absolutePath);
      violations.push({
        sourceFile,
        line: 1,
        column: 1,
        specifier: sourceFile,
        kind: "workspace-symlink",
        rule: DEPENDENCY_RULES.productionSymlink,
      });
      continue;
    }
    if (entry.isDirectory()) {
      const nested = await sourceInventory(
        repositoryRoot,
        absolutePath,
        excludedDirectories,
        explicitSourceFiles,
        includeSourceFiles && entry.name !== "dist",
      );
      files.push(...nested.files);
      violations.push(...nested.violations);
    } else if (entry.isFile()
      && ((includeSourceFiles && isExportedSourceTarget(entry.name))
        || (explicitSourceFiles.has(absolutePath) && isExportedSourceTarget(absolutePath)))) {
      files.push(absolutePath);
    }
  }
  return { files, violations };
}

async function configurationFiles(
  directory: string,
  excludedDirectories: ReadonlySet<string>,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules" && !excludedDirectories.has(absolutePath)) {
        files.push(...await configurationFiles(absolutePath, excludedDirectories));
      }
    } else if (entry.isFile() && /^(?:jsconfig|tsconfig)(?:\.[^.]+)*\.json$/u.test(entry.name)) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function productionConfigurationFiles(packages: readonly WorkspacePackage[]): Promise<string[]> {
  const packageDirectories = new Set(packages.map((workspacePackage) => workspacePackage.directory));
  return (await Promise.all(packages.map((workspacePackage) => configurationFiles(
    workspacePackage.directory,
    new Set([...packageDirectories].filter((directory) => directory !== workspacePackage.directory
      && isPathInside(workspacePackage.directory, directory))),
  )))).flat().sort((left, right) => left.localeCompare(right));
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
    if (normalized.split("/").some((segment) => segment === "node_modules" || segment === "bower_components")) {
      continue;
    }
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

function manifestExportTargets(content: string, exportsValue: unknown): ManifestExportTarget[] {
  const targets: ManifestExportTarget[] = [];
  const pending = [exportsValue];
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (typeof candidate === "string") {
      if (normalizedExportTarget(candidate) !== undefined) {
        targets.push({ target: candidate, ...manifestStringLocation(content, candidate) });
      }
    } else if (Array.isArray(candidate)) {
      pending.push(...candidate);
    } else if (candidate && typeof candidate === "object") {
      pending.push(...Object.values(candidate as Record<string, unknown>));
    }
  }
  return targets.sort((left, right) => left.line - right.line
    || left.column - right.column
    || left.target.localeCompare(right.target));
}

function workspacePackageKind(repositoryManifestPath: string): WorkspacePackageKind {
  if (repositoryManifestPath.startsWith("adapters/")) return "adapter";
  if (repositoryManifestPath.startsWith("apps/")) return "app";
  return "package";
}

async function workspacePackages(repositoryRoot: string): Promise<WorkspacePackage[]> {
  const manifestPaths = await workspaceManifestFiles(repositoryRoot);
  const packages = await Promise.all(manifestPaths.map(async (manifestPath): Promise<WorkspacePackage> => {
    const repositoryManifestPath = repositoryPath(repositoryRoot, manifestPath);
    const directory = dirname(manifestPath);
    const physicalDirectory = await physicalPathWithoutLinks(
      repositoryRoot,
      directory,
      `${repositoryManifestPath} package root`,
    );
    await physicalPathWithoutLinks(repositoryRoot, manifestPath, repositoryManifestPath);
    const content = await readFile(manifestPath, "utf8");
    const manifest: unknown = JSON.parse(content);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw new Error(`${repositoryManifestPath} must contain a JSON object`);
    }
    const record = manifest as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) {
      throw new Error(`${repositoryManifestPath} must declare a package name`);
    }
    const dependencies = manifestDependencies(content, record);
    return {
      name: record.name,
      kind: workspacePackageKind(repositoryManifestPath),
      directory,
      physicalDirectory,
      repositoryManifestPath,
      moduleType: record.type === "module" ? "module" : "commonjs",
      exports: record.exports,
      exportTargets: manifestExportTargets(content, record.exports),
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

function staticStringExpression(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticStringExpression(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringExpression(node.left);
    const right = staticStringExpression(node.right);
    return left === undefined || right === undefined ? undefined : `${left}${right}`;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticStringExpression(span.expression);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  return undefined;
}

function propertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) return staticStringExpression(node.argumentExpression);
  return undefined;
}

function bindingPropertyName(node: ts.PropertyName | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isComputedPropertyName(node)) return staticStringExpression(node.expression);
  return node.text;
}

function nodeModuleSpecifier(node: ts.Node | undefined): boolean {
  const moduleName = stringSpecifier(node);
  return moduleName === "node:module" || moduleName === "module";
}

function exportExposesModuleLoader(node: ts.ExportDeclaration): boolean {
  if (!nodeModuleSpecifier(node.moduleSpecifier)) return false;
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true;
  return node.exportClause.elements.some((element) => {
    const exportedName = (element.propertyName ?? element.name).text;
    return exportedName === "createRequire"
      || exportedName === "default"
      || exportedName === "Module"
      || exportedName === "register"
      || exportedName === "registerHooks";
  });
}

function isDirectCallTarget(node: ts.Node): boolean {
  return Boolean(node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node);
}

function resolutionModeAttribute(node: ts.ImportAttributes | undefined): ModuleResolutionMode | undefined {
  const attribute = node?.elements.find((element) => stringSpecifier(element.name) === "resolution-mode"
    || (ts.isIdentifier(element.name) && element.name.text === "resolution-mode"));
  const value = stringSpecifier(attribute?.value);
  return value === "import" || value === "require" ? value : undefined;
}

function sourceResolutionMode(absolutePath: string, moduleType: WorkspacePackage["moduleType"]): ModuleResolutionMode {
  const extension = extname(absolutePath).toLowerCase();
  if (extension === ".cjs" || extension === ".cts") return "require";
  if (extension === ".mjs" || extension === ".mts") return "import";
  return moduleType === "module" ? "import" : "require";
}

function importDeclarationIsTypeOnly(node: ts.ImportDeclaration, source: ts.SourceFile): boolean {
  if (source.isDeclarationFile || node.importClause?.isTypeOnly) return true;
  const bindings = node.importClause?.namedBindings;
  return Boolean(bindings && ts.isNamedImports(bindings)
    && bindings.elements.length > 0
    && bindings.elements.every((element) => element.isTypeOnly));
}

function exportDeclarationIsTypeOnly(node: ts.ExportDeclaration, source: ts.SourceFile): boolean {
  if (source.isDeclarationFile || node.isTypeOnly) return true;
  return Boolean(node.exportClause && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((element) => element.isTypeOnly));
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)
    || ts.isAwaitExpression(node)) return unwrapExpression(node.expression);
  return node;
}

function callTargetNamed(node: ts.CallExpression, object: string, method: string): boolean {
  return (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === object
    && propertyName(node.expression) === method;
}

function moduleLoaderAuthorityName(name: string | undefined): boolean {
  return name === undefined
    || name.startsWith("_")
    || name === "createRequire"
    || name === "load"
    || name === "register"
    || name === "registerHooks"
    || name === "require";
}

function bindingExposesModuleLoader(node: ts.BindingElement, roots: ReadonlySet<string>): boolean {
  const name = bindingPropertyName(node.propertyName)
    ?? (ts.isIdentifier(node.name) ? node.name.text : undefined);
  if (name === "createRequire" || name === "register" || name === "registerHooks" || name === "require") return true;
  const pattern = node.parent;
  const declaration = ts.isObjectBindingPattern(pattern) ? pattern.parent : undefined;
  return name !== undefined
    && declaration !== undefined
    && ts.isVariableDeclaration(declaration)
    && Boolean(declaration.initializer && isModuleLoaderObject(declaration.initializer, roots))
    && moduleLoaderAuthorityName(name);
}

function isModuleLoaderObject(node: ts.Expression, roots: ReadonlySet<string>): boolean {
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) return roots.has(node.text);
  if (ts.isNewExpression(node)) return isModuleLoaderObject(node.expression, roots);
  if (ts.isClassExpression(node)) {
    return node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
      && clause.types.some((type) => isModuleLoaderObject(type.expression, roots))) ?? false;
  }
  if (ts.isCallExpression(node)) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return nodeModuleSpecifier(node.arguments[0]);
    if (((ts.isIdentifier(node.expression) && node.expression.text === "require")
      || propertyName(node.expression) === "require") && nodeModuleSpecifier(node.arguments[0])) return true;
    if (propertyName(node.expression) === "getBuiltinModule") {
      return nodeModuleSpecifier(node.arguments[0]);
    }
    if ((callTargetNamed(node, "Object", "create") || callTargetNamed(node, "Reflect", "construct"))
      && node.arguments[0]
      && isModuleLoaderObject(node.arguments[0], roots)) return true;
    if (callTargetNamed(node, "Reflect", "get")
      && node.arguments[0]
      && isModuleLoaderObject(node.arguments[0], roots)) {
      const name = staticStringExpression(node.arguments[1]);
      return name === "Module" || name === "constructor" || name === "default" || name === "prototype";
    }
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = propertyName(node);
    if (name === "mainModule" && ts.isIdentifier(node.expression) && node.expression.text === "process") return true;
    return (name === "Module" || name === "constructor" || name === "default" || name === "prototype")
      && isModuleLoaderObject(node.expression, roots);
  }
  return false;
}

function moduleLoaderCapability(node: ts.Expression, roots: ReadonlySet<string>): boolean {
  node = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = propertyName(node);
    if ((name === "call" || name === "apply" || name === "bind")
      && moduleLoaderCapability(node.expression, roots)) return true;
    return moduleLoaderAuthorityName(name) && isModuleLoaderObject(node.expression, roots);
  }
  if (ts.isCallExpression(node) && callTargetNamed(node, "Reflect", "get")
    && node.arguments[0]
    && isModuleLoaderObject(node.arguments[0], roots)) {
    return moduleLoaderAuthorityName(staticStringExpression(node.arguments[1]));
  }
  return false;
}

function moduleLoaderRoots(source: ts.SourceFile): ReadonlySet<string> {
  const roots = new Set(["module", "Module"]);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && nodeModuleSpecifier(statement.moduleSpecifier)) {
      if (statement.importClause?.name) roots.add(statement.importClause.name.text);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) roots.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          if ((element.propertyName ?? element.name).text === "Module") roots.add(element.name.text);
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && nodeModuleSpecifier(statement.moduleReference.expression)) {
      roots.add(statement.name.text);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && isModuleLoaderObject(node.initializer, roots) && !roots.has(node.name.text)) {
        roots.add(node.name.text);
        changed = true;
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
        && isModuleLoaderObject(node.initializer, roots)) {
        for (const element of node.name.elements) {
          const property = bindingPropertyName(element.propertyName)
            ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
          if ((property === "Module" || property === "default")
            && ts.isIdentifier(element.name)
            && !roots.has(element.name.text)) {
            roots.add(element.name.text);
            changed = true;
          }
        }
      } else if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name
        && node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
          && clause.types.some((type) => isModuleLoaderObject(type.expression, roots)))
        && !roots.has(node.name.text)) {
        roots.add(node.name.text);
        changed = true;
      } else if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)
        && isModuleLoaderObject(node.right, roots)
        && !roots.has(node.left.text)) {
        roots.add(node.left.text);
        changed = true;
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
  }
  return roots;
}

interface DynamicCodeRoots {
  evaluators: ReadonlySet<string>;
  globals: ReadonlySet<string>;
}

function globalObjectTarget(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  node = unwrapExpression(node);
  return ts.isIdentifier(node) && roots.globals.has(node.text);
}

function dynamicCodeTarget(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  if (ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isNonNullExpression(node)
    || ts.isSatisfiesExpression(node)) return dynamicCodeTarget(node.expression, roots);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return dynamicCodeTarget(node.right, roots);
  }
  if (ts.isIdentifier(node)) return roots.evaluators.has(node.text);
  if (ts.isCallExpression(node) && callTargetNamed(node, "Reflect", "get")
    && node.arguments[0]
    && globalObjectTarget(node.arguments[0], roots)) {
    const name = staticStringExpression(node.arguments[1]);
    return name === undefined || name === "eval" || name === "Function";
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = propertyName(node);
    if ((name === undefined || name === "eval" || name === "Function")
      && globalObjectTarget(node.expression, roots)) return true;
    if (name === "call" || name === "apply" || name === "bind" || name === "prototype") {
      return dynamicCodeTarget(node.expression, roots);
    }
  }
  return false;
}

function dynamicCodeRoots(source: ts.SourceFile): DynamicCodeRoots {
  const evaluators = new Set(["eval", "Function"]);
  const globals = new Set(["global", "globalThis", "self", "window"]);
  const roots: DynamicCodeRoots = { evaluators, globals };
  let changed = true;
  while (changed) {
    changed = false;
    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (globalObjectTarget(node.initializer, roots) && !globals.has(node.name.text)) {
          globals.add(node.name.text);
          changed = true;
        } else if (dynamicCodeTarget(node.initializer, roots) && !evaluators.has(node.name.text)) {
          evaluators.add(node.name.text);
          changed = true;
        }
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
        && globalObjectTarget(node.initializer, roots)) {
        for (const element of node.name.elements) {
          const property = bindingPropertyName(element.propertyName)
            ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
          if ((property === "eval" || property === "Function")
            && ts.isIdentifier(element.name)
            && !evaluators.has(element.name.text)) {
            evaluators.add(element.name.text);
            changed = true;
          }
        }
      } else if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)) {
        if (globalObjectTarget(node.right, roots) && !globals.has(node.left.text)) {
          globals.add(node.left.text);
          changed = true;
        } else if (dynamicCodeTarget(node.right, roots) && !evaluators.has(node.left.text)) {
          evaluators.add(node.left.text);
          changed = true;
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
  }
  return roots;
}

function isDynamicCodeCall(node: ts.CallExpression | ts.NewExpression, roots: DynamicCodeRoots): boolean {
  if (dynamicCodeTarget(node.expression, roots)) return true;
  if (ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "Reflect"
    && node.expression.name.text === "construct") {
    return Boolean(node.arguments[0] && dynamicCodeTarget(node.arguments[0], roots));
  }
  return propertyName(node.expression) === "constructor";
}

function extractImportReferences(
  repositoryRoot: string,
  absolutePath: string,
  content: string,
  moduleType: WorkspacePackage["moduleType"],
): ImportReference[] {
  const source = ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true);
  const loaderRoots = moduleLoaderRoots(source);
  const evaluatorRoots = dynamicCodeRoots(source);
  const sourceFile = repositoryPath(repositoryRoot, absolutePath);
  const references: ImportReference[] = [];

  const record = (
    node: ts.Node,
    specifierNode: ts.Node | undefined,
    kind: ImportKind,
    requireLiteral = true,
    syntheticSpecifier?: string,
    options: Pick<ImportReference, "resolutionMode" | "typeOnly"> = {},
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
      ...options,
    });
  };

  const recordText = (
    position: number,
    specifier: string,
    options: Pick<ImportReference, "filesystemReference" | "resolutionMode" | "typeOnly"> = {},
  ): void => {
    const location = source.getLineAndCharacterOfPosition(position);
    references.push({
      sourceFile,
      line: location.line + 1,
      column: location.character + 1,
      specifier,
      kind: "triple-slash-reference",
      ...options,
    });
  };

  for (const reference of source.referencedFiles) {
    recordText(reference.pos, reference.fileName, { filesystemReference: true, typeOnly: true });
  }
  for (const reference of source.typeReferenceDirectives) {
    recordText(reference.pos, reference.fileName, { typeOnly: true });
  }
  for (const reference of source.amdDependencies) {
    recordText(Math.max(0, content.indexOf(reference.path)), reference.path, { resolutionMode: "require" });
  }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      record(node, node.moduleSpecifier, "import-declaration", true, undefined, {
        resolutionMode: resolutionModeAttribute(node.attributes)
          ?? sourceResolutionMode(absolutePath, moduleType),
        typeOnly: importDeclarationIsTypeOnly(node, source),
      });
      if (nodeModuleSpecifier(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (["createRequire", "register", "registerHooks"].includes((element.propertyName ?? element.name).text)) {
              record(element, undefined, "module-loader", true, unsupportedModuleLoader);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      record(node, node.moduleSpecifier, "export-declaration", true, undefined, {
        resolutionMode: resolutionModeAttribute(node.attributes)
          ?? sourceResolutionMode(absolutePath, moduleType),
        typeOnly: exportDeclarationIsTypeOnly(node, source),
      });
      if (exportExposesModuleLoader(node)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      }
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      record(node, node.moduleReference.expression, "import-equals");
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      record(node, node.argument.literal, "import-type", true, undefined, {
        resolutionMode: resolutionModeAttribute(node.attributes)
          ?? sourceResolutionMode(absolutePath, moduleType),
        typeOnly: true,
      });
    } else if (ts.isCallExpression(node)) {
      if (isDynamicCodeCall(node, evaluatorRoots)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      } else if (dynamicCodeTarget(node, evaluatorRoots)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      } else if (propertyName(node.expression) === "getBuiltinModule"
        && (!stringSpecifier(node.arguments[0]) || nodeModuleSpecifier(node.arguments[0]))) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        record(node, node.arguments[0], "dynamic-import", false);
      } else if ((ts.isIdentifier(node.expression) && node.expression.text === "require")
        || propertyName(node.expression) === "require") {
        record(node, node.arguments[0], "require-call", false);
      } else if (moduleLoaderCapability(node, loaderRoots)
        || moduleLoaderCapability(node.expression, loaderRoots)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      }
    } else if (ts.isNewExpression(node) && isDynamicCodeCall(node, evaluatorRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && propertyName(node) === "require" && !isDirectCallTarget(node)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isElementAccessExpression(node)
      && isModuleLoaderObject(node.expression, loaderRoots)
      && staticStringExpression(node.argumentExpression) === undefined) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isPropertyAccessExpression(node)
      && isModuleLoaderObject(node.expression, loaderRoots)
      && moduleLoaderAuthorityName(node.name.text)
      && !isDirectCallTarget(node)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && moduleLoaderCapability(node, loaderRoots)
      && !isDirectCallTarget(node)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && propertyName(node) === "createRequire"
      && (!isDirectCallTarget(node) || !isModuleLoaderObject(node.expression, loaderRoots))) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isBindingElement(node)
      && bindingExposesModuleLoader(node, loaderRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isVariableDeclaration(node) && node.initializer
      && dynamicCodeTarget(node.initializer, evaluatorRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
      && globalObjectTarget(node.initializer, evaluatorRoots)
      && node.name.elements.some((element) => {
        const name = bindingPropertyName(element.propertyName)
          ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
        return name === "eval" || name === "Function";
      })) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && dynamicCodeTarget(node.right, evaluatorRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && dynamicCodeTarget(node, evaluatorRoots)
      && !isDirectCallTarget(node)
      && !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node)
      && !(ts.isBinaryExpression(node.parent) && node.parent.right === node)) {
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

function localSourceViolationRule(
  repositoryRoot: string,
  sourcePackage: WorkspacePackage,
  reference: ImportReference,
): DependencyRule | undefined {
  const normalized = normalizedSpecifier(reference.specifier);
  const repositoryRootSpecifier = /^(?:adapters|apps|packages)\//u.test(normalized);
  const absoluteSpecifier = isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//");
  const relativeSpecifier = reference.filesystemReference || normalized.startsWith(".");
  if (!repositoryRootSpecifier && !absoluteSpecifier && !relativeSpecifier) return undefined;
  if (repositoryRootSpecifier || absoluteSpecifier) return DEPENDENCY_RULES.crossPackageSourcePath;

  const absoluteTarget = resolve(dirname(resolve(repositoryRoot, reference.sourceFile)), normalized);
  if (!isPathInside(sourcePackage.directory, absoluteTarget)) return DEPENDENCY_RULES.crossPackageSourcePath;
  const segments = relative(sourcePackage.directory, absoluteTarget).split(sep).filter(Boolean);
  if (segments.some((segment) => unscannedPackageDirectories.has(segment))) {
    return DEPENDENCY_RULES.unscannedSourcePath;
  }
  return isAuditableExportTarget(absoluteTarget) ? undefined : DEPENDENCY_RULES.unscannedSourcePath;
}

function packageForPath(packages: readonly WorkspacePackage[], absolutePath: string): WorkspacePackage | undefined {
  return [...packages]
    .sort((left, right) => right.directory.length - left.directory.length)
    .find((workspacePackage) => isPathInside(workspacePackage.directory, absolutePath));
}

function packageForPhysicalPath(
  packages: readonly WorkspacePackage[],
  physicalPath: string,
): WorkspacePackage | undefined {
  return [...packages]
    .sort((left, right) => right.physicalDirectory.length - left.physicalDirectory.length)
    .find((workspacePackage) => isPathInside(workspacePackage.physicalDirectory, physicalPath));
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

function normalizedExportTarget(target: string, patternMatch?: string): string | undefined {
  if (!target.startsWith("./")) return undefined;
  const resolved = patternMatch === undefined ? target : target.replaceAll("*", patternMatch);
  const segments = resolved.slice(2).split("/");
  return segments.every((segment) => segment !== ".." && segment.toLowerCase() !== "node_modules")
    ? resolved
    : undefined;
}

function resolvePackageTarget(
  target: unknown,
  conditions: ReadonlySet<string>,
  patternMatch?: string,
): PackageTargetResolution {
  if (target === null) return { status: "blocked" };
  if (typeof target === "string") {
    const resolved = normalizedExportTarget(target, patternMatch);
    return resolved === undefined ? { status: "invalid" } : { status: "resolved", target: resolved };
  }
  if (Array.isArray(target)) {
    if (target.length === 0) return { status: "blocked" };
    let sawInvalid = false;
    for (const candidate of target) {
      const resolution = resolvePackageTarget(candidate, conditions, patternMatch);
      if (resolution.status === "resolved") return resolution;
      if (resolution.status === "invalid") sawInvalid = true;
    }
    return { status: sawInvalid ? "invalid" : "blocked" };
  }
  if (!target || typeof target !== "object") return { status: "invalid" };
  for (const [condition, candidate] of Object.entries(target as Record<string, unknown>)) {
    if (condition === "default" || conditions.has(condition)) {
      const resolution = resolvePackageTarget(candidate, conditions, patternMatch);
      if (resolution.status !== "unmatched") return resolution;
    }
  }
  return { status: "unmatched" };
}

function conditionsForImport(reference: Pick<ImportReference, "kind" | "resolutionMode" | "typeOnly">): ReadonlySet<string> {
  const requireMode = reference.resolutionMode === "require"
    || reference.kind === "require-call"
    || reference.kind === "import-equals";
  if (reference.typeOnly || reference.kind === "import-type") {
    return new Set(["types", "node", requireMode ? "require" : "import"]);
  }
  if (requireMode) {
    return new Set(["node", "node-addons", "module-sync", "require"]);
  }
  return new Set(["node", "node-addons", "module-sync", "import"]);
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

function resolveExportedSubpath(
  exportsValue: unknown,
  subpath: string,
  reference: Pick<ImportReference, "kind" | "resolutionMode" | "typeOnly">,
): PackageTargetResolution {
  const conditions = conditionsForImport(reference);
  if (typeof exportsValue === "string" || Array.isArray(exportsValue) || exportsValue === null) {
    return subpath === "."
      ? resolvePackageTarget(exportsValue, conditions)
      : { status: "unmatched" };
  }
  if (!exportsValue || typeof exportsValue !== "object") return { status: "invalid" };
  const exportsMap = exportsValue as Record<string, unknown>;
  const keys = Object.keys(exportsMap);
  const subpathKeys = keys.filter((key) => key.startsWith("."));
  if (subpathKeys.length === 0) {
    return subpath === "."
      ? resolvePackageTarget(exportsMap, conditions)
      : { status: "unmatched" };
  }
  if (subpathKeys.length !== keys.length) return { status: "invalid" };
  if (Object.hasOwn(exportsMap, subpath) && !subpath.includes("*")) {
    return resolvePackageTarget(exportsMap[subpath], conditions);
  }
  const patterns = subpathKeys
    .filter((key) => key.includes("*") && matchingExportPattern(key, subpath) !== undefined)
    .sort(compareExportPatterns);
  const selected = patterns[0];
  if (!selected) return { status: "unmatched" };
  return resolvePackageTarget(
    exportsMap[selected],
    conditions,
    matchingExportPattern(selected, subpath),
  );
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

async function physicalExportViolationRule(
  repositoryRoot: string,
  targetPackage: WorkspacePackage,
  exportTarget: string,
  packages: readonly WorkspacePackage[],
): Promise<DependencyRule | undefined> {
  const lexicalTarget = resolve(targetPackage.directory, exportTarget);
  let physicalTarget: string;
  try {
    physicalTarget = await realpath(lexicalTarget);
  } catch {
    return DEPENDENCY_RULES.physicalExportTarget;
  }
  if (!isPathInside(repositoryRoot, physicalTarget)) return DEPENDENCY_RULES.physicalExportTarget;
  const metadata = await lstat(physicalTarget).catch(() => undefined);
  if (!metadata?.isFile()) return DEPENDENCY_RULES.physicalExportTarget;
  const owner = packageForPhysicalPath(packages, physicalTarget);
  if (owner && owner.name !== targetPackage.name) return DEPENDENCY_RULES.crossPackageExportTarget;
  if (owner?.name !== targetPackage.name || !isPathInside(targetPackage.physicalDirectory, physicalTarget)) {
    return DEPENDENCY_RULES.physicalExportTarget;
  }
  return isAuditableExportTarget(physicalTarget) ? undefined : DEPENDENCY_RULES.executableExportTarget;
}

async function packageExportAudit(
  repositoryRoot: string,
  targetPackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
): Promise<PackageExportAudit> {
  const files = new Set<string>();
  const violations: DependencyViolation[] = [];
  for (const entry of targetPackage.exportTargets) {
    const normalizedTarget = normalizedExportTarget(entry.target);
    let rule: DependencyRule | undefined;
    if (!normalizedTarget) {
      rule = DEPENDENCY_RULES.physicalExportTarget;
    } else if (normalizedTarget.includes("*")) {
      for await (const candidate of glob(normalizedTarget.slice(2), { cwd: targetPackage.directory })) {
        const lexicalTarget = resolve(targetPackage.directory, candidate);
        rule ??= await physicalExportViolationRule(
          repositoryRoot,
          targetPackage,
          `./${candidate.replaceAll("\\", "/")}`,
          packages,
        );
        if (!rule && isExportedSourceTarget(lexicalTarget)) files.add(lexicalTarget);
      }
    } else {
      const lexicalTarget = resolve(targetPackage.directory, normalizedTarget);
      rule = await physicalExportViolationRule(repositoryRoot, targetPackage, normalizedTarget, packages);
      if (!rule && isExportedSourceTarget(lexicalTarget)) files.add(lexicalTarget);
    }
    if (rule) {
      violations.push({
        sourceFile: targetPackage.repositoryManifestPath,
        line: entry.line,
        column: entry.column,
        specifier: entry.target,
        kind: "manifest-export",
        rule,
      });
    }
  }
  return { files, violations };
}

async function sourceViolationRule(
  repositoryRoot: string,
  sourcePackage: WorkspacePackage,
  reference: ImportReference,
  packages: readonly WorkspacePackage[],
  allowedGraph: AllowedDependencyGraph,
): Promise<DependencyRule | undefined> {
  if (reference.kind === "module-loader") return DEPENDENCY_RULES.unsupportedModuleLoader;
  if (reference.specifier === nonLiteralSpecifier) return DEPENDENCY_RULES.workspaceDynamicImports;
  if (/^[a-z][a-z\d+.-]*:/iu.test(reference.specifier) && !reference.specifier.startsWith("node:")) {
    return DEPENDENCY_RULES.urlModuleSpecifier;
  }
  if (reference.specifier.includes("%")) return DEPENDENCY_RULES.encodedModuleSpecifier;
  if (reference.specifier.startsWith("#")) return DEPENDENCY_RULES.packageImportAlias;
  const localRule = localSourceViolationRule(repositoryRoot, sourcePackage, reference);
  if (localRule) return localRule;
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
  if (target.packageSubpath) {
    const exportResolution = resolveExportedSubpath(
      target.target.exports,
      target.packageSubpath,
      reference,
    );
    if (exportResolution.status !== "resolved") return DEPENDENCY_RULES.privateWorkspaceSubpath;
    const physicalRule = await physicalExportViolationRule(
      repositoryRoot,
      target.target,
      exportResolution.target,
      packages,
    );
    if (physicalRule) return physicalRule;
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

async function typescriptPathViolations(
  repositoryRoot: string,
  packages: readonly WorkspacePackage[],
): Promise<DependencyViolation[]> {
  const violations: DependencyViolation[] = [];
  for (const configPath of await productionConfigurationFiles(packages)) {
    const content = await readFile(configPath, "utf8");
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    });
    for (const alias of Object.keys(parsed?.options.paths ?? {}).sort()) {
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
  repositoryRoot = await realpath(repositoryRoot);
  const packages = await workspacePackages(repositoryRoot);
  const packagesByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const packageDirectories = new Set(packages.map((workspacePackage) => workspacePackage.directory));
  const exportAudits = new Map(await Promise.all(packages.map(async (workspacePackage) => [
    workspacePackage.name,
    await packageExportAudit(repositoryRoot, workspacePackage, packages),
  ] as const)));
  const packageFiles = await Promise.all(packages.map(async (workspacePackage) => ({
    workspacePackage,
    inventory: await sourceInventory(
      repositoryRoot,
      workspacePackage.directory,
      new Set([...packageDirectories].filter((directory) => directory !== workspacePackage.directory
        && isPathInside(workspacePackage.directory, directory))),
      exportAudits.get(workspacePackage.name)?.files,
    ),
  })));
  const references = (await Promise.all(packageFiles.flatMap(({ workspacePackage, inventory }) =>
    inventory.files.map(async (absolutePath) => ({
      workspacePackage,
      references: extractImportReferences(
        repositoryRoot,
        absolutePath,
        await readFile(absolutePath, "utf8"),
        workspacePackage.moduleType,
      ),
    }))))).flat();
  const sourceViolations = (await Promise.all(references.flatMap(({ workspacePackage, references: fileReferences }) =>
    fileReferences.map(async (reference): Promise<DependencyViolation[]> => {
      const rule = await sourceViolationRule(
        repositoryRoot,
        workspacePackage,
        reference,
        packages,
        allowedGraph,
      );
      return rule ? [{ ...reference, rule }] : [];
    })))).flat();
  const candidates = [
    ...graphIntegrityViolations(packages, allowedGraph),
    ...packages.flatMap((workspacePackage) => manifestViolations(
      workspacePackage,
      packages,
      packagesByName,
      allowedGraph,
    )),
    ...await typescriptPathViolations(repositoryRoot, packages),
    ...[...exportAudits.values()].flatMap(({ violations }) => violations),
    ...packageFiles.flatMap(({ inventory }) => inventory.violations),
    ...sourceViolations,
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
    scannedFileCount: packageFiles.reduce((count, { inventory }) => count + inventory.files.length, 0),
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
      : violation.kind === "workspace-symlink"
        ? "path"
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

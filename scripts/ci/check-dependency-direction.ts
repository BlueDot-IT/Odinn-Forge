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
  ambiguousModuleSpecifier: "backslashes and CommonJS query or fragment suffixes are unsupported in production module specifiers",
  crossPackageExportTarget: "workspace package exports cannot target another workspace package",
  crossPackageSourcePath: "cross-package imports must use an exported workspace package specifier",
  dependencyAliasSpecifier: "file, link, and npm dependency aliases are unsupported in production workspace packages",
  encodedModuleSpecifier: "percent-encoded module specifiers are unsupported in production workspace packages",
  executableExportTarget: "workspace exports must use statically auditable source or inert JSON targets",
  missingGraphPackage: "allowed dependency graph packages must be discovered from pnpm-workspace.yaml",
  moduleHookScript: "production workspace scripts must be closed-form typechecks or package-owned audited Node entrypoints",
  packageBinEntrypoint: "workspace package bins must be uniquely named package-owned audited Node entrypoints",
  packageImportAlias: "package.json imports aliases are unsupported in production workspace packages",
  packageToApp: "packages and adapters cannot depend on apps",
  physicalExportTarget: "workspace exports must resolve to an existing regular file inside their package",
  privateWorkspaceSubpath: "workspace imports must use package.json exports",
  unscannedSourcePath: "production file references must remain in the scanned source of their workspace package",
  unmanagedNodeModulesLink: "package-local node_modules links must resolve to declared package-manager dependencies",
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
  | "manifest-bin"
  | "manifest-export"
  | "manifest-script"
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

interface ManifestScript {
  name: string;
  command: string;
  line: number;
  column: number;
}

interface ManifestBin {
  command: string;
  target: string;
  line: number;
  column: number;
  shape: "entry" | "invalid" | "directories";
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
  bins: readonly ManifestBin[];
  scripts: readonly ManifestScript[];
  scriptSourceFiles: ReadonlySet<string>;
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

interface PackageBinAudit {
  files: ReadonlySet<string>;
  violations: readonly DependencyViolation[];
}

const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const inertExportExtensions = new Set([".json"]);
const unscannedPackageDirectories = new Set(["bower_components", "dist", "node_modules"]);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const nonLiteralSpecifier = "<non-literal module specifier>";
const unsupportedModuleLoader = "<unsupported module loader>";
const nodeModuleStoreDirectory = "node_modules/.pnpm";

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
      targets.push({ target: candidate, ...manifestStringLocation(content, candidate) });
    } else if (Array.isArray(candidate)) {
      pending.push(...candidate);
    } else if (candidate && typeof candidate === "object") {
      pending.push(...Object.values(candidate as Record<string, unknown>));
    } else if (candidate !== null && candidate !== undefined) {
      targets.push({
        target: "<invalid export target>",
        ...manifestStringLocation(content, "exports"),
      });
    }
  }
  return targets.sort((left, right) => left.line - right.line
    || left.column - right.column
    || left.target.localeCompare(right.target));
}

function manifestScripts(content: string, manifest: Record<string, unknown>): ManifestScript[] {
  const scriptsValue = manifest.scripts;
  if (!scriptsValue || typeof scriptsValue !== "object" || Array.isArray(scriptsValue)) return [];
  return Object.entries(scriptsValue as Record<string, unknown>)
    .flatMap(([name, command]) => typeof command === "string"
      ? [{ name, command, ...manifestStringLocation(content, command) }]
      : [])
    .sort((left, right) => left.line - right.line
      || left.column - right.column
      || left.name.localeCompare(right.name));
}

function manifestBins(
  content: string,
  manifest: Record<string, unknown>,
  packageName: string,
): ManifestBin[] {
  const bins: ManifestBin[] = [];
  const directories = manifest.directories;
  if (directories && typeof directories === "object" && !Array.isArray(directories)
    && Object.hasOwn(directories, "bin")) {
    bins.push({
      command: "<directories.bin>",
      target: "<directories.bin>",
      ...manifestStringLocation(content, "directories"),
      shape: "directories",
    });
  }

  const bin = manifest.bin;
  if (bin === undefined) return bins;
  if (typeof bin === "string") {
    const command = packageName.startsWith("@") ? packageName.split("/")[1] ?? "" : packageName;
    bins.push({ command, target: bin, ...manifestStringLocation(content, bin), shape: "entry" });
  } else if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    for (const [command, target] of Object.entries(bin as Record<string, unknown>)) {
      bins.push({
        command,
        target: typeof target === "string" ? target : "<invalid bin target>",
        ...manifestStringLocation(content, command),
        shape: typeof target === "string" ? "entry" : "invalid",
      });
    }
  } else {
    bins.push({
      command: "<invalid bin declaration>",
      target: "<invalid bin declaration>",
      ...manifestStringLocation(content, "bin"),
      shape: "invalid",
    });
  }
  return bins.sort((left, right) => left.line - right.line
    || left.column - right.column
    || left.command.localeCompare(right.command));
}

function manifestScriptSourceFiles(directory: string, scripts: readonly ManifestScript[]): ReadonlySet<string> {
  const files = new Set<string>();
  for (const script of scripts) {
    const match = /^node (\.\/[A-Za-z\d_./-]+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx))$/u.exec(script.command);
    if (match) files.add(resolve(directory, match[1]!));
  }
  return files;
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
    const scripts = manifestScripts(content, record);
    return {
      name: record.name,
      kind: workspacePackageKind(repositoryManifestPath),
      directory,
      physicalDirectory,
      repositoryManifestPath,
      moduleType: record.type === "module" ? "module" : "commonjs",
      exports: record.exports,
      exportTargets: manifestExportTargets(content, record.exports),
      bins: manifestBins(content, record, record.name),
      scripts,
      scriptSourceFiles: manifestScriptSourceFiles(directory, scripts),
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

interface NodeModulesLink {
  moduleName: string;
  path: string;
}

async function physicalPackageName(directory: string): Promise<string | undefined> {
  try {
    const content: unknown = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8"));
    if (!content || typeof content !== "object" || Array.isArray(content)) return undefined;
    const name = (content as Record<string, unknown>).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function unmanagedNodeModulesViolation(
  repositoryRoot: string,
  moduleName: string,
  path: string,
): DependencyViolation {
  return {
    sourceFile: repositoryPath(repositoryRoot, path),
    line: 1,
    column: 1,
    specifier: moduleName,
    kind: "workspace-symlink",
    rule: DEPENDENCY_RULES.unmanagedNodeModulesLink,
  };
}

async function packageNodeModulesLinks(
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
): Promise<{ links: NodeModulesLink[]; violations: DependencyViolation[] }> {
  const nodeModules = resolve(workspacePackage.directory, "node_modules");
  const violations: DependencyViolation[] = [];
  const links: NodeModulesLink[] = [];
  const metadata = await lstat(nodeModules).catch(() => undefined);
  if (!metadata) return { links, violations };
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    violations.push(unmanagedNodeModulesViolation(repositoryRoot, "node_modules", nodeModules));
    return { links, violations };
  }

  for (const entry of (await readdir(nodeModules, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = resolve(nodeModules, entry.name);
    if (entry.name === ".bin" || entry.name === ".pnpm") continue;
    if (entry.name === ".vite-temp" && entry.isDirectory() && (await readdir(entryPath)).length === 0) continue;
    if (entry.name.startsWith("@")) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        violations.push(unmanagedNodeModulesViolation(repositoryRoot, entry.name, entryPath));
        continue;
      }
      for (const child of (await readdir(entryPath, { withFileTypes: true }))
        .sort((left, right) => left.name.localeCompare(right.name))) {
        if (child.isSymbolicLink()) {
          links.push({ moduleName: `${entry.name}/${child.name}`, path: resolve(entryPath, child.name) });
        } else {
          violations.push(unmanagedNodeModulesViolation(
            repositoryRoot,
            `${entry.name}/${child.name}`,
            resolve(entryPath, child.name),
          ));
        }
      }
    } else if (entry.isSymbolicLink()) {
      links.push({ moduleName: entry.name, path: entryPath });
    } else {
      violations.push(unmanagedNodeModulesViolation(repositoryRoot, entry.name, entryPath));
    }
  }
  return { links, violations };
}

async function nodeModulesLinkViolations(
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
): Promise<DependencyViolation[]> {
  const { links, violations } = await packageNodeModulesLinks(repositoryRoot, workspacePackage);
  const packageManagerStore = resolve(repositoryRoot, nodeModuleStoreDirectory);
  for (const link of links) {
    const physical = await realpath(link.path).catch(() => undefined);
    const targetPackage = physical
      ? packages.find((candidate) => candidate.physicalDirectory === physical)
      : undefined;
    const targetName = physical ? await physicalPackageName(physical) : undefined;
    const declared = workspacePackage.dependencyNames.has(link.moduleName);
    const canonicalWorkspaceLink = declared
      && targetPackage?.name === link.moduleName
      && targetName === link.moduleName;
    const packageManagerLink = declared
      && physical !== undefined
      && isPathInside(packageManagerStore, physical)
      && targetName === link.moduleName;
    if (canonicalWorkspaceLink || packageManagerLink) continue;
    violations.push(unmanagedNodeModulesViolation(repositoryRoot, link.moduleName, link.path));
  }
  return violations;
}

function barePackageName(specifier: string): string | undefined {
  if (specifier.includes("\\")) return undefined;
  const normalized = normalizedSpecifier(specifier);
  if (!normalized || relativeModuleSpecifier(normalized) || normalized.startsWith("/")
    || normalized.startsWith("#") || /^[A-Za-z]:\//u.test(normalized)
    || normalized.startsWith("node:") || normalized.includes(":")) return undefined;
  const segments = normalized.split("/");
  if (normalized.startsWith("@")) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : undefined;
  }
  return segments[0];
}

async function firstResolverVisiblePackage(
  repositoryRoot: string,
  sourceFile: string,
  moduleName: string,
): Promise<string | undefined> {
  const moduleSegments = moduleName.split("/");
  let current = dirname(resolve(repositoryRoot, sourceFile));
  while (isPathInside(repositoryRoot, current)) {
    const candidate = resolve(current, "node_modules", ...moduleSegments);
    if (await lstat(candidate).then(() => true).catch(() => false)) return candidate;
    if (current === repositoryRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

async function resolverVisibleNodeModulesViolations(
  repositoryRoot: string,
  references: readonly { workspacePackage: WorkspacePackage; references: readonly ImportReference[] }[],
  packages: readonly WorkspacePackage[],
): Promise<DependencyViolation[]> {
  const packageManagerStore = resolve(repositoryRoot, nodeModuleStoreDirectory);
  const violations = new Map<string, DependencyViolation>();
  for (const { workspacePackage, references: fileReferences } of references) {
    for (const reference of fileReferences) {
      const moduleName = barePackageName(reference.specifier);
      if (!moduleName) continue;
      const visible = await firstResolverVisiblePackage(repositoryRoot, reference.sourceFile, moduleName);
      if (!visible) continue;
      const physical = await realpath(visible).catch(() => undefined);
      const expectedWorkspace = packages.find((candidate) => candidate.name === moduleName);
      const targetName = physical ? await physicalPackageName(physical) : undefined;
      const validWorkspace = expectedWorkspace !== undefined
        && physical === expectedWorkspace.physicalDirectory
        && targetName === moduleName;
      const validExternal = expectedWorkspace === undefined
        && workspacePackage.dependencyNames.has(moduleName)
        && physical !== undefined
        && isPathInside(packageManagerStore, physical)
        && targetName === moduleName;
      if (validWorkspace || validExternal) continue;
      const violation = unmanagedNodeModulesViolation(repositoryRoot, moduleName, visible);
      violations.set(`${violation.sourceFile}\0${moduleName}`, violation);
    }
  }
  return [...violations.values()];
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

function staticArrayIndex(node: ts.Expression | undefined): number | undefined {
  if (!node) return undefined;
  node = unwrapExpression(node);
  const text = ts.isNumericLiteral(node) ? node.text : staticStringExpression(node);
  if (text === undefined || !/^(?:0|[1-9]\d*)$/u.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
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

function nodeVmSpecifier(node: ts.Node | undefined): boolean {
  const moduleName = stringSpecifier(node);
  return moduleName === "node:vm" || moduleName === "vm";
}

function nodeProcessSpecifier(node: ts.Node | undefined): boolean {
  const moduleName = stringSpecifier(node);
  return moduleName === "node:process" || moduleName === "process";
}

const auditedNamedProcessExports = new Set(["cwd", "exit", "kill"]);

function runtimeAuthorityModuleSpecifier(node: ts.Node | undefined): boolean {
  return nodeModuleSpecifier(node) || nodeVmSpecifier(node) || nodeProcessSpecifier(node);
}

function importExposesModuleLoader(node: ts.ImportDeclaration, source: ts.SourceFile): boolean {
  if (importDeclarationIsTypeOnly(node, source)) return false;
  if (nodeProcessSpecifier(node.moduleSpecifier)) {
    if (stringSpecifier(node.moduleSpecifier) !== "node:process") return true;
    const clause = node.importClause;
    if (!clause || clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) return true;
    return clause.namedBindings.elements.some((element) =>
      !element.isTypeOnly
      && !auditedNamedProcessExports.has((element.propertyName ?? element.name).text));
  }
  if (nodeVmSpecifier(node.moduleSpecifier)) return true;
  if (!nodeModuleSpecifier(node.moduleSpecifier)) return false;
  const bindings = node.importClause?.namedBindings;
  return !bindings || !ts.isNamedImports(bindings) || bindings.elements.some((element) =>
    !element.isTypeOnly && (element.propertyName ?? element.name).text !== "builtinModules");
}

function exportExposesModuleLoader(node: ts.ExportDeclaration, source: ts.SourceFile): boolean {
  if (exportDeclarationIsTypeOnly(node, source)) return false;
  if (nodeProcessSpecifier(node.moduleSpecifier)) return true;
  if (nodeVmSpecifier(node.moduleSpecifier)) return true;
  if (!nodeModuleSpecifier(node.moduleSpecifier)) return false;
  return !node.exportClause || ts.isNamespaceExport(node.exportClause)
    || node.exportClause.elements.some((element) =>
      !element.isTypeOnly && (element.propertyName ?? element.name).text !== "builtinModules");
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
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return unwrapExpression(node.right);
  }
  return node;
}

interface LexicalBinding {
  name: string;
  start: number;
  end: number;
}

type LexicalBindings = ReadonlyMap<string, readonly LexicalBinding[]>;

function nearestRuntimeScope(node: ts.Node, functionScoped = false): ts.Node {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isFunctionLike(current)) return current;
    if (!functionScoped && (ts.isBlock(current) || ts.isCaseBlock(current)
      || ts.isForStatement(current) || ts.isForInStatement(current)
      || ts.isForOfStatement(current) || ts.isCatchClause(current))) return current;
  }
  return node.getSourceFile();
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element)
    ? []
    : bindingIdentifiers(element.name));
}

function runtimeLexicalBindings(source: ts.SourceFile): LexicalBindings {
  const bindings = new Map<string, LexicalBinding[]>();
  const record = (identifier: ts.Identifier, scope: ts.Node): void => {
    const entries = bindings.get(identifier.text) ?? [];
    entries.push({ name: identifier.text, start: scope.getFullStart(), end: scope.getEnd() });
    bindings.set(identifier.text, entries);
  };
  const visit = (node: ts.Node): void => {
    if (ts.canHaveModifiers(node)
      && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return;
    if (ts.isVariableDeclaration(node)) {
      const declarationList = node.parent;
      const functionScoped = ts.isVariableDeclarationList(declarationList)
        && (declarationList.flags & ts.NodeFlags.BlockScoped) === 0;
      const scope = nearestRuntimeScope(node, functionScoped);
      for (const identifier of bindingIdentifiers(node.name)) record(identifier, scope);
    } else if (ts.isParameter(node)) {
      const scope = nearestRuntimeScope(node);
      for (const identifier of bindingIdentifiers(node.name)) record(identifier, scope);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node))
      && node.name) {
      record(node.name, nearestRuntimeScope(node));
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      record(node.name, nearestRuntimeScope(node));
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      record(node.name, node);
    } else if (ts.isImportClause(node) && node.name && !node.isTypeOnly) {
      record(node.name, source);
    } else if (ts.isNamespaceImport(node)
      && !ts.findAncestor(node, ts.isImportClause)?.isTypeOnly) {
      record(node.name, source);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      record(node.name, source);
    } else if (ts.isImportSpecifier(node)
      && !node.isTypeOnly
      && !ts.findAncestor(node, ts.isImportClause)?.isTypeOnly) {
      record(node.name, source);
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      for (const identifier of bindingIdentifiers(node.variableDeclaration.name)) record(identifier, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function unshadowedAmbientIdentifier(
  node: ts.Expression,
  name: string,
  bindings: LexicalBindings,
): node is ts.Identifier {
  if (!ts.isIdentifier(node) || node.text !== name) return false;
  const position = node.getStart(node.getSourceFile());
  return !(bindings.get(name) ?? []).some((binding) =>
    binding.start <= position && position < binding.end);
}

function scopedIdentifierKey(identifier: ts.Identifier, bindings: LexicalBindings): string {
  const position = identifier.getStart(identifier.getSourceFile());
  const binding = [...(bindings.get(identifier.text) ?? [])]
    .filter((candidate) => candidate.start <= position && position < candidate.end)
    .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
  return binding
    ? `${identifier.text}\0${binding.start}\0${binding.end}`
    : `${identifier.text}\0<ambient>`;
}

function callTargetNamed(
  node: ts.CallExpression,
  object: string,
  method: string,
  bindings: LexicalBindings,
): boolean {
  return (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
    && unshadowedAmbientIdentifier(unwrapExpression(node.expression.expression), object, bindings)
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

interface ModuleLoaderRoots {
  aliases: Set<string>;
  bindings: LexicalBindings;
}

function bindingExposesModuleLoader(node: ts.BindingElement, roots: ModuleLoaderRoots): boolean {
  const name = bindingPropertyName(node.propertyName)
    ?? (ts.isIdentifier(node.name) ? node.name.text : undefined);
  const pattern = node.parent;
  const declaration = ts.isObjectBindingPattern(pattern) ? pattern.parent : undefined;
  return name !== undefined
    && declaration !== undefined
    && ts.isVariableDeclaration(declaration)
    && Boolean(declaration.initializer && isModuleLoaderObject(declaration.initializer, roots))
    && moduleLoaderAuthorityName(name);
}

function isModuleLoaderObject(node: ts.Expression, roots: ModuleLoaderRoots): boolean {
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) {
    return roots.aliases.has(scopedIdentifierKey(node, roots.bindings))
      || unshadowedAmbientIdentifier(node, "module", roots.bindings);
  }
  if (ts.isNewExpression(node)) return isModuleLoaderObject(node.expression, roots);
  if (ts.isElementAccessExpression(node)
    && ts.isArrayLiteralExpression(unwrapExpression(node.expression))) {
    const array = unwrapExpression(node.expression) as ts.ArrayLiteralExpression;
    const index = staticArrayIndex(node.argumentExpression);
    return index !== undefined
      && index < array.elements.length
      && !ts.isSpreadElement(array.elements[index]!)
      && isModuleLoaderObject(array.elements[index]! as ts.Expression, roots);
  }
  if (ts.isConditionalExpression(node)) {
    return isModuleLoaderObject(node.whenTrue, roots) || isModuleLoaderObject(node.whenFalse, roots);
  }
  if (ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return isModuleLoaderObject(node.left, roots) || isModuleLoaderObject(node.right, roots);
  }
  if (ts.isClassExpression(node)) {
    return node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
      && clause.types.some((type) => isModuleLoaderObject(type.expression, roots))) ?? false;
  }
  if (ts.isCallExpression(node)) {
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) return nodeModuleSpecifier(node.arguments[0]);
    if ((unshadowedAmbientIdentifier(unwrapExpression(node.expression), "require", roots.bindings)
      || ((ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
        && propertyName(node.expression) === "require"
        && isModuleLoaderObject(node.expression.expression, roots)))
      && nodeModuleSpecifier(node.arguments[0])) return true;
    if ((ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
      && propertyName(node.expression) === "getBuiltinModule"
      && unshadowedAmbientIdentifier(unwrapExpression(node.expression.expression), "process", roots.bindings)) {
      return nodeModuleSpecifier(node.arguments[0]);
    }
    if ((callTargetNamed(node, "Object", "create", roots.bindings)
      || callTargetNamed(node, "Reflect", "construct", roots.bindings))
      && node.arguments[0]
      && isModuleLoaderObject(node.arguments[0], roots)) return true;
    if (callTargetNamed(node, "Reflect", "get", roots.bindings)
      && node.arguments[0]
      && isModuleLoaderObject(node.arguments[0], roots)) {
      const name = staticStringExpression(node.arguments[1]);
      return name === "Module" || name === "constructor" || name === "default" || name === "prototype";
    }
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = propertyName(node);
    if (name === "mainModule"
      && unshadowedAmbientIdentifier(unwrapExpression(node.expression), "process", roots.bindings)) return true;
    return (name === "Module" || name === "constructor" || name === "default" || name === "prototype")
      && isModuleLoaderObject(node.expression, roots);
  }
  return false;
}

function moduleLoaderCapability(node: ts.Expression, roots: ModuleLoaderRoots): boolean {
  node = unwrapExpression(node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = propertyName(node);
    if ((name === "call" || name === "apply" || name === "bind")
      && moduleLoaderCapability(node.expression, roots)) return true;
    return moduleLoaderAuthorityName(name) && isModuleLoaderObject(node.expression, roots);
  }
  if (ts.isCallExpression(node) && callTargetNamed(node, "Reflect", "get", roots.bindings)
    && node.arguments[0]
    && isModuleLoaderObject(node.arguments[0], roots)) {
    return moduleLoaderAuthorityName(staticStringExpression(node.arguments[1]));
  }
  return false;
}

function moduleLoaderRoots(source: ts.SourceFile, bindings: LexicalBindings): ModuleLoaderRoots {
  const aliases = new Set<string>();
  const roots: ModuleLoaderRoots = { aliases, bindings };
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && nodeModuleSpecifier(statement.moduleSpecifier)) {
      if (statement.importClause?.name) {
        aliases.add(scopedIdentifierKey(statement.importClause.name, bindings));
      }
      const namedBindings = statement.importClause?.namedBindings;
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        aliases.add(scopedIdentifierKey(namedBindings.name, bindings));
      }
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          if ((element.propertyName ?? element.name).text === "Module") {
            aliases.add(scopedIdentifierKey(element.name, bindings));
          }
        }
      }
    } else if (ts.isImportEqualsDeclaration(statement)
      && ts.isExternalModuleReference(statement.moduleReference)
      && nodeModuleSpecifier(statement.moduleReference.expression)) {
      aliases.add(scopedIdentifierKey(statement.name, bindings));
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const key = scopedIdentifierKey(node.name, bindings);
        if (isModuleLoaderObject(node.initializer, roots) && !aliases.has(key)) {
          aliases.add(key);
          changed = true;
        }
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
        && isModuleLoaderObject(node.initializer, roots)) {
        for (const element of node.name.elements) {
          const property = bindingPropertyName(element.propertyName)
            ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
          if ((property === "Module" || property === "default") && ts.isIdentifier(element.name)) {
            const key = scopedIdentifierKey(element.name, bindings);
            if (!aliases.has(key)) {
              aliases.add(key);
              changed = true;
            }
          }
        }
      } else if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name
        && node.heritageClauses?.some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword
          && clause.types.some((type) => isModuleLoaderObject(type.expression, roots)))) {
        const key = scopedIdentifierKey(node.name, bindings);
        if (!aliases.has(key)) {
          aliases.add(key);
          changed = true;
        }
      } else if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)
        && isModuleLoaderObject(node.right, roots)) {
        const key = scopedIdentifierKey(node.left, bindings);
        if (!aliases.has(key)) {
          aliases.add(key);
          changed = true;
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
  }
  return roots;
}

type LocalAuthorityCallback = ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression;

interface DynamicCodeRoots {
  callbackAliases: Map<string, Set<LocalAuthorityCallback>>;
  callbacks: ReadonlyMap<string, LocalAuthorityCallback>;
  evaluators: Set<string>;
  globals: Set<string>;
  proxies: Set<string>;
  processes: Set<string>;
  reflectGets: Set<string>;
  descriptorGets: Set<string>;
  descriptorMaps: Set<string>;
  ordinaryConstructors: Set<string>;
  bindings: LexicalBindings;
}

const dynamicEvaluatorNames = new Set(["eval", "Function"]);

function ambientOrAliasTarget(
  node: ts.Expression,
  aliases: ReadonlySet<string>,
  ambientNames: ReadonlySet<string>,
  bindings: LexicalBindings,
): boolean {
  node = unwrapExpression(node);
  if (!ts.isIdentifier(node)) return false;
  return aliases.has(scopedIdentifierKey(node, bindings))
    || (ambientNames.has(node.text) && unshadowedAmbientIdentifier(node, node.text, bindings));
}

function methodAliasTarget(
  node: ts.Expression,
  object: string,
  method: string,
  aliases: ReadonlySet<string>,
  roots: DynamicCodeRoots,
): boolean {
  node = unwrapExpression(node);
  if (ts.isIdentifier(node)) return aliases.has(scopedIdentifierKey(node, roots.bindings));
  if (ts.isCallExpression(node)
    && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
    && propertyName(node.expression) === "bind") {
    return methodAliasTarget(node.expression.expression, object, method, aliases, roots);
  }
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  if (propertyName(node) === "bind") {
    return methodAliasTarget(node.expression, object, method, aliases, roots);
  }
  return unshadowedAmbientIdentifier(unwrapExpression(node.expression), object, roots.bindings)
    && propertyName(node) === method;
}

function methodCallArguments(
  node: ts.CallExpression,
  object: string,
  method: string,
  aliases: ReadonlySet<string>,
  roots: DynamicCodeRoots,
): readonly ts.Expression[] | undefined {
  const target = unwrapExpression(node.expression);
  if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
    && (propertyName(target) === "call" || propertyName(target) === "apply")
    && methodAliasTarget(target.expression, object, method, aliases, roots)) {
    if (propertyName(target) === "call") return node.arguments.slice(1);
    const values = unwrapExpression(node.arguments[1] ?? ts.factory.createArrayLiteralExpression());
    return ts.isArrayLiteralExpression(values) && values.elements.every((element) => !ts.isSpreadElement(element))
      ? values.elements as readonly ts.Expression[]
      : [];
  }
  return methodAliasTarget(target, object, method, aliases, roots) ? node.arguments : undefined;
}

function proxyTarget(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  node = unwrapExpression(node);
  if (ambientOrAliasTarget(node, roots.proxies, new Set(["Proxy"]), roots.bindings)) return true;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = propertyName(node);
    if (name === "value") return proxyTarget(node.expression, roots);
    return name === "Proxy" && globalObjectTarget(node.expression, roots);
  }
  if (ts.isCallExpression(node)) {
    const args = methodCallArguments(node, "Object", "getOwnPropertyDescriptor", roots.descriptorGets, roots);
    if (args?.[0] && globalObjectTarget(args[0], roots)) {
      return staticStringExpression(args[1]) === "Proxy";
    }
  }
  return false;
}

function globalObjectTarget(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  node = unwrapExpression(node);
  if (ambientOrAliasTarget(
    node,
    roots.globals,
    new Set(["global", "globalThis", "self", "window"]),
    roots.bindings,
  )) return true;
  if (ts.isElementAccessExpression(node)
    && ts.isArrayLiteralExpression(unwrapExpression(node.expression))) {
    const array = unwrapExpression(node.expression) as ts.ArrayLiteralExpression;
    const index = staticArrayIndex(node.argumentExpression);
    return index !== undefined
      && index < array.elements.length
      && !ts.isSpreadElement(array.elements[index]!)
      && globalObjectTarget(array.elements[index]! as ts.Expression, roots);
  }
  if (ts.isConditionalExpression(node)) {
    return globalObjectTarget(node.whenTrue, roots) || globalObjectTarget(node.whenFalse, roots);
  }
  if (ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return globalObjectTarget(node.left, roots) || globalObjectTarget(node.right, roots);
  }
  if ((ts.isCallExpression(node) || ts.isNewExpression(node))
    && proxyTarget(node.expression, roots)
    && Boolean(node.arguments?.[0] && globalObjectTarget(node.arguments[0], roots))) return true;
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const name = propertyName(node);
  if ((name === "global" || name === "globalThis" || name === "self" || name === "window")
    && globalObjectTarget(node.expression, roots)) return true;
  const revocableCall = unwrapExpression(node.expression);
  return name === "proxy"
    && ts.isCallExpression(revocableCall)
    && propertyName(revocableCall.expression) === "revocable"
    && (ts.isPropertyAccessExpression(revocableCall.expression)
      || ts.isElementAccessExpression(revocableCall.expression))
    && proxyTarget(revocableCall.expression.expression, roots)
    && Boolean(revocableCall.arguments[0]
      && globalObjectTarget(revocableCall.arguments[0], roots));
}

function processObjectTarget(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  node = unwrapExpression(node);
  if (ambientOrAliasTarget(node, roots.processes, new Set(["process"]), roots.bindings)) return true;
  if (ts.isElementAccessExpression(node)
    && ts.isArrayLiteralExpression(unwrapExpression(node.expression))) {
    const array = unwrapExpression(node.expression) as ts.ArrayLiteralExpression;
    const index = staticArrayIndex(node.argumentExpression);
    return index !== undefined
      && index < array.elements.length
      && !ts.isSpreadElement(array.elements[index]!)
      && processObjectTarget(array.elements[index]! as ts.Expression, roots);
  }
  if (ts.isConditionalExpression(node)) {
    return processObjectTarget(node.whenTrue, roots) || processObjectTarget(node.whenFalse, roots);
  }
  if (ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return processObjectTarget(node.left, roots) || processObjectTarget(node.right, roots);
  }
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    && propertyName(node) === "process"
    && globalObjectTarget(node.expression, roots);
}

function objectAssignmentBinding(
  node: ts.BinaryExpression,
  target: (expression: ts.Expression) => boolean,
  acceptedProperties: ReadonlySet<string>,
): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    || !ts.isObjectLiteralExpression(unwrapExpression(node.left))
    || !target(node.right)) return false;
  const pattern = unwrapExpression(node.left) as ts.ObjectLiteralExpression;
  return pattern.properties.some((property) => {
    if (ts.isSpreadAssignment(property)) return true;
    if (ts.isShorthandPropertyAssignment(property)) return acceptedProperties.has(property.name.text);
    return ts.isPropertyAssignment(property)
      && (bindingPropertyName(property.name) === undefined
        || acceptedProperties.has(bindingPropertyName(property.name)!));
  });
}

function ordinaryConstructorMethod(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const target = unwrapExpression(node.expression);
  return propertyName(node) === "constructor"
    && ts.isIdentifier(target)
    && roots.ordinaryConstructors.has(scopedIdentifierKey(target, roots.bindings));
}

function callableTarget(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  node = unwrapExpression(node);
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassExpression(node);
}

function dynamicCodeTarget(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  node = unwrapExpression(node);
  if (ambientOrAliasTarget(node, roots.evaluators, dynamicEvaluatorNames, roots.bindings)) return true;
  if (ts.isElementAccessExpression(node)
    && ts.isArrayLiteralExpression(unwrapExpression(node.expression))) {
    const array = unwrapExpression(node.expression) as ts.ArrayLiteralExpression;
    const index = staticArrayIndex(node.argumentExpression);
    return index !== undefined
      && index < array.elements.length
      && !ts.isSpreadElement(array.elements[index]!)
      && dynamicCodeTarget(array.elements[index]! as ts.Expression, roots);
  }
  if (ts.isConditionalExpression(node)) {
    return dynamicCodeTarget(node.whenTrue, roots) || dynamicCodeTarget(node.whenFalse, roots);
  }
  if (ts.isBinaryExpression(node)
    && (node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return dynamicCodeTarget(node.left, roots) || dynamicCodeTarget(node.right, roots);
  }
  if (ts.isCallExpression(node)) {
    const descriptorArgs = methodCallArguments(
      node,
      "Object",
      "getOwnPropertyDescriptor",
      roots.descriptorGets,
      roots,
    ) ?? methodCallArguments(
      node,
      "Reflect",
      "getOwnPropertyDescriptor",
      roots.descriptorGets,
      roots,
    );
    if (descriptorArgs) {
      if (!descriptorArgs[0]) return true;
      const name = staticStringExpression(descriptorArgs[1]);
      if (name === "constructor") return true;
      return globalObjectTarget(descriptorArgs[0], roots)
        && (name === undefined || name === "process" || dynamicEvaluatorNames.has(name));
    }
    const descriptorMapArgs = methodCallArguments(
      node,
      "Object",
      "getOwnPropertyDescriptors",
      roots.descriptorMaps,
      roots,
    );
    if (descriptorMapArgs) {
      return !descriptorMapArgs[0] || globalObjectTarget(descriptorMapArgs[0], roots);
    }
    const reflectArgs = methodCallArguments(node, "Reflect", "get", roots.reflectGets, roots);
    if (reflectArgs) {
      if (!reflectArgs[0]) return true;
      const name = staticStringExpression(reflectArgs[1]);
      if (name === undefined || name === "constructor") return true;
      return globalObjectTarget(reflectArgs[0], roots)
        && (name === "process" || dynamicEvaluatorNames.has(name));
    }
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    const name = propertyName(node);
    if ((name === undefined || (name !== undefined && dynamicEvaluatorNames.has(name)))
      && globalObjectTarget(node.expression, roots)) return true;
    if (name === "constructor" && !ordinaryConstructorMethod(node, roots)) return true;
    if (name === undefined && callableTarget(node.expression, roots)) return true;
    if (name === undefined && isDirectCallTarget(node)) return true;
    if (name === undefined && ts.isCallExpression(unwrapExpression(node.expression))
      && methodCallArguments(
        unwrapExpression(node.expression) as ts.CallExpression,
        "Object",
        "getOwnPropertyDescriptors",
        roots.descriptorMaps,
        roots,
      )) return true;
    if (name === "call" || name === "apply" || name === "bind" || name === "prototype"
      || name === "value" || (name !== undefined && dynamicEvaluatorNames.has(name))) {
      return dynamicCodeTarget(node.expression, roots);
    }
  }
  return false;
}

function localAuthorityCallbacks(
  source: ts.SourceFile,
  bindings: LexicalBindings,
): ReadonlyMap<string, LocalAuthorityCallback> {
  const callbacks = new Map<string, LocalAuthorityCallback>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      callbacks.set(scopedIdentifierKey(node.name, bindings), node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        callbacks.set(scopedIdentifierKey(node.name, bindings), initializer);
      }
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      const value = unwrapExpression(node.right);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        callbacks.set(scopedIdentifierKey(node.left, bindings), value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return callbacks;
}

function localCallbackTargets(
  node: ts.Expression,
  roots: DynamicCodeRoots,
): ReadonlySet<LocalAuthorityCallback> {
  node = unwrapExpression(node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return new Set([node]);
  if (!ts.isIdentifier(node)) return new Set();
  const key = scopedIdentifierKey(node, roots.bindings);
  const targets = new Set(roots.callbackAliases.get(key) ?? []);
  const direct = roots.callbacks.get(key);
  if (direct) targets.add(direct);
  return targets;
}

function localCallbackInvocations(
  node: ts.CallExpression,
  roots: DynamicCodeRoots,
): readonly { callback: LocalAuthorityCallback; arguments: readonly ts.Expression[] }[] {
  const invocations: { callback: LocalAuthorityCallback; arguments: readonly ts.Expression[] }[] = [];
  const direct = localCallbackTargets(node.expression, roots);
  for (const callback of direct) invocations.push({ callback, arguments: node.arguments });
  if (invocations.length > 0) return invocations;
  const target = unwrapExpression(node.expression);
  if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))
    && (propertyName(target) === "call" || propertyName(target) === "apply")) {
    const callbacks = localCallbackTargets(target.expression, roots);
    if (propertyName(target) === "call") {
      for (const callback of callbacks) {
        invocations.push({ callback, arguments: node.arguments.slice(1) });
      }
      return invocations;
    }
    const values = unwrapExpression(node.arguments[1] ?? ts.factory.createArrayLiteralExpression());
    if (ts.isArrayLiteralExpression(values)
      && values.elements.every((element) => !ts.isSpreadElement(element))) {
      for (const callback of callbacks) {
        invocations.push({ callback, arguments: values.elements as readonly ts.Expression[] });
      }
      return invocations;
    }
  }
  if (callTargetNamed(node, "Reflect", "apply", roots.bindings) && node.arguments[0]) {
    const callbacks = localCallbackTargets(node.arguments[0], roots);
    const values = unwrapExpression(node.arguments[2] ?? ts.factory.createArrayLiteralExpression());
    if (ts.isArrayLiteralExpression(values)
      && values.elements.every((element) => !ts.isSpreadElement(element))) {
      for (const callback of callbacks) {
        invocations.push({ callback, arguments: values.elements as readonly ts.Expression[] });
      }
    }
  }
  return invocations;
}

function mergeCallbackAliases(
  identifier: ts.Identifier,
  value: ts.Expression,
  roots: DynamicCodeRoots,
): boolean {
  const targets = localCallbackTargets(value, roots);
  if (targets.size === 0) return false;
  const key = scopedIdentifierKey(identifier, roots.bindings);
  const known = roots.callbackAliases.get(key) ?? new Set<LocalAuthorityCallback>();
  let changed = false;
  for (const target of targets) {
    if (!known.has(target)) {
      known.add(target);
      changed = true;
    }
  }
  if (changed) roots.callbackAliases.set(key, known);
  return changed;
}

function dynamicCodeRoots(source: ts.SourceFile, bindings: LexicalBindings): DynamicCodeRoots {
  const callbacks = localAuthorityCallbacks(source, bindings);
  const roots: DynamicCodeRoots = {
    callbackAliases: new Map(),
    callbacks,
    evaluators: new Set(),
    globals: new Set(),
    proxies: new Set(),
    processes: new Set(),
    reflectGets: new Set(),
    descriptorGets: new Set(),
    descriptorMaps: new Set(),
    ordinaryConstructors: new Set(),
    bindings,
  };
  const { descriptorGets, descriptorMaps, evaluators, globals, ordinaryConstructors, processes,
    proxies, reflectGets } = roots;
  const collectOrdinaryConstructors = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer)
        && initializer.properties.some((property) => bindingPropertyName(property.name) === "constructor")) {
        ordinaryConstructors.add(scopedIdentifierKey(node.name, bindings));
      }
    }
    ts.forEachChild(node, collectOrdinaryConstructors);
  };
  collectOrdinaryConstructors(source);
  let changed = true;
  while (changed) {
    changed = false;
    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const key = scopedIdentifierKey(node.name, bindings);
        if (globalObjectTarget(node.initializer, roots) && !globals.has(key)) {
          globals.add(key);
          changed = true;
        } else if (dynamicCodeTarget(node.initializer, roots) && !evaluators.has(key)) {
          evaluators.add(key);
          changed = true;
        } else if (proxyTarget(node.initializer, roots) && !proxies.has(key)) {
          proxies.add(key);
          changed = true;
        } else if (processObjectTarget(node.initializer, roots) && !processes.has(key)) {
          processes.add(key);
          changed = true;
        } else if (methodAliasTarget(
          node.initializer,
          "Reflect",
          "get",
          reflectGets,
          roots,
        ) && !reflectGets.has(key)) {
          reflectGets.add(key);
          changed = true;
        } else if ((methodAliasTarget(
          node.initializer,
          "Object",
          "getOwnPropertyDescriptor",
          descriptorGets,
          roots,
        ) || methodAliasTarget(
          node.initializer,
          "Reflect",
          "getOwnPropertyDescriptor",
          descriptorGets,
          roots,
        )) && !descriptorGets.has(key)) {
          descriptorGets.add(key);
          changed = true;
        } else if (methodAliasTarget(
          node.initializer,
          "Object",
          "getOwnPropertyDescriptors",
          descriptorMaps,
          roots,
        ) && !descriptorMaps.has(key)) {
          descriptorMaps.add(key);
          changed = true;
        }
        if (mergeCallbackAliases(node.name, node.initializer, roots)) changed = true;
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
        && globalObjectTarget(node.initializer, roots)) {
        for (const element of node.name.elements) {
          const property = bindingPropertyName(element.propertyName)
            ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
          if (ts.isIdentifier(element.name)) {
            const key = scopedIdentifierKey(element.name, bindings);
            if (property !== undefined && dynamicEvaluatorNames.has(property)
              && !evaluators.has(key)) {
              evaluators.add(key);
              changed = true;
            } else if (property === "Proxy" && !proxies.has(key)) {
              proxies.add(key);
              changed = true;
            }
          }
        }
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
        && unshadowedAmbientIdentifier(unwrapExpression(node.initializer), "Reflect", bindings)) {
        for (const element of node.name.elements) {
          const property = bindingPropertyName(element.propertyName)
            ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
          if (property === "get" && ts.isIdentifier(element.name)) {
            const key = scopedIdentifierKey(element.name, bindings);
            if (!reflectGets.has(key)) {
              reflectGets.add(key);
              changed = true;
            }
          } else if (property === "getOwnPropertyDescriptor" && ts.isIdentifier(element.name)) {
            const key = scopedIdentifierKey(element.name, bindings);
            if (!descriptorGets.has(key)) {
              descriptorGets.add(key);
              changed = true;
            }
          }
        }
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
        && unshadowedAmbientIdentifier(unwrapExpression(node.initializer), "Object", bindings)) {
        for (const element of node.name.elements) {
          const property = bindingPropertyName(element.propertyName)
            ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
          const key = ts.isIdentifier(element.name) ? scopedIdentifierKey(element.name, bindings) : undefined;
          if (property === "getOwnPropertyDescriptor" && key && !descriptorGets.has(key)) {
            descriptorGets.add(key);
            changed = true;
          } else if (property === "getOwnPropertyDescriptors" && key && !descriptorMaps.has(key)) {
            descriptorMaps.add(key);
            changed = true;
          }
        }
      } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer
        && ts.isCallExpression(unwrapExpression(node.initializer))) {
        const call = unwrapExpression(node.initializer) as ts.CallExpression;
        if (propertyName(call.expression) === "revocable"
          && (ts.isPropertyAccessExpression(call.expression) || ts.isElementAccessExpression(call.expression))
          && proxyTarget(call.expression.expression, roots)
          && call.arguments[0]
          && globalObjectTarget(call.arguments[0], roots)) {
          for (const element of node.name.elements) {
            const property = bindingPropertyName(element.propertyName)
              ?? (ts.isIdentifier(element.name) ? element.name.text : undefined);
            if (property === "proxy" && ts.isIdentifier(element.name)) {
              const key = scopedIdentifierKey(element.name, bindings);
              if (!globals.has(key)) {
                globals.add(key);
                changed = true;
              }
            }
          }
        }
      } else if (ts.isBinaryExpression(node)
        && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(node.left)) {
        const key = scopedIdentifierKey(node.left, bindings);
        if (globalObjectTarget(node.right, roots) && !globals.has(key)) {
          globals.add(key);
          changed = true;
        } else if (dynamicCodeTarget(node.right, roots) && !evaluators.has(key)) {
          evaluators.add(key);
          changed = true;
        } else if (proxyTarget(node.right, roots) && !proxies.has(key)) {
          proxies.add(key);
          changed = true;
        } else if (processObjectTarget(node.right, roots) && !processes.has(key)) {
          processes.add(key);
          changed = true;
        }
        if (mergeCallbackAliases(node.left, node.right, roots)) changed = true;
      } else if (ts.isCallExpression(node)) {
        for (const invocation of localCallbackInvocations(node, roots)) {
          for (let index = 0; index < invocation.callback.parameters.length; index += 1) {
            const parameter = invocation.callback.parameters[index];
            const argument = invocation.arguments[index];
            if (!parameter || !argument || !ts.isIdentifier(parameter.name)) continue;
            if (mergeCallbackAliases(parameter.name, argument, roots)) changed = true;
          }
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
  }
  return roots;
}

const auditedAmbientProcessReadProperties = new Set([
  "arch",
  "argv",
  "cwd",
  "env",
  "execPath",
  "exit",
  "exitCode",
  "getuid",
  "kill",
  "pid",
  "platform",
  "stdin",
  "stdout",
  "version",
]);

const identityComparisonOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const directOperationalProcessMethods = new Set(["on", "once", "removeListener", "send"]);

function runtimeValueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent)
      || ts.isPropertySignature(parent) || ts.isGetAccessorDeclaration(parent)
      || ts.isSetAccessorDeclaration(parent)) && parent.name === node)
    || (ts.isEnumMember(parent) && parent.name === node)
    || (ts.isModuleDeclaration(parent) && parent.name === node)
    || (ts.isJsxAttribute(parent) && parent.name === node)
    || (ts.isJsxOpeningElement(parent) && parent.tagName === node)
    || (ts.isJsxSelfClosingElement(parent) && parent.tagName === node)
    || (ts.isJsxClosingElement(parent) && parent.tagName === node)
    || (ts.isBindingElement(parent) && parent.propertyName === node)
    || (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
    || (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node))
    || (ts.isLabeledStatement(parent) && parent.label === node)
    || ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node)) return false;
  for (let current: ts.Node | undefined = parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return false;
    if (ts.isStatement(current) || ts.isSourceFile(current) || ts.isFunctionLike(current)) break;
  }
  return true;
}

function transparentAuthorityUse(node: ts.Expression): ts.Expression {
  let current = node;
  while (true) {
    const parent = current.parent;
    if ((ts.isParenthesizedExpression(parent)
      || ts.isAsExpression(parent)
      || ts.isNonNullExpression(parent)
      || ts.isSatisfiesExpression(parent))
      && parent.expression === current) {
      current = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.CommaToken
      && parent.right === current) {
      current = parent;
      continue;
    }
    return current;
  }
}

function ambientProcessOrigin(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  if (ts.isIdentifier(node)) {
    return runtimeValueIdentifier(node)
      && unshadowedAmbientIdentifier(node, "process", roots.bindings);
  }
  if ((!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))
    || propertyName(node) !== "process") return false;
  return globalObjectTarget(node.expression, roots);
}

interface ProcessUseCheckState {
  readonly activeParameters: Set<string>;
}

function nodeIsAssigned(node: ts.Node): boolean {
  let current = node;
  for (let parent = current.parent; parent; current = parent, parent = parent.parent) {
    if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
      && parent.expression === current) return false;
    if (ts.isBinaryExpression(parent)
      && parent.left === current
      && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
    if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
      && parent.operand === current
      && (parent.operator === ts.SyntaxKind.PlusPlusToken
        || parent.operator === ts.SyntaxKind.MinusMinusToken)) return true;
    if (ts.isDeleteExpression(parent) && parent.expression === current) return true;
    if ((ts.isForInStatement(parent) || ts.isForOfStatement(parent))
      && parent.initializer === current) return true;
    if (ts.isStatement(parent) || ts.isFunctionLike(parent) || ts.isSourceFile(parent)) return false;
  }
  return false;
}

function localAuthorityCallbackIsStable(
  callback: LocalAuthorityCallback,
  roots: DynamicCodeRoots,
): boolean {
  if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) {
    const value = transparentAuthorityUse(callback);
    const parent = value.parent;
    if (ts.isCallExpression(parent)
      && (parent.expression === value || parent.arguments.some((argument) => argument === value))) return true;
    if (!ts.isVariableDeclaration(parent)
      || parent.initializer !== value
      || !ts.isIdentifier(parent.name)
      || !ts.isVariableDeclarationList(parent.parent)
      || (parent.parent.flags & ts.NodeFlags.Const) === 0) return false;
    return roots.callbacks.get(scopedIdentifierKey(parent.name, roots.bindings)) === callback;
  }
  if (!callback.name) return false;
  const key = scopedIdentifierKey(callback.name, roots.bindings);
  let stable = roots.callbacks.get(key) === callback;
  const visit = (node: ts.Node): void => {
    if (!stable) return;
    if (ts.isIdentifier(node)
      && node !== callback.name
      && runtimeValueIdentifier(node)
      && scopedIdentifierKey(node, roots.bindings) === key
      && nodeIsAssigned(node)) {
      stable = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(callback.getSourceFile());
  return stable;
}

function callbackParameterUsesAreClosed(
  callback: LocalAuthorityCallback,
  parameterIndex: number,
  roots: DynamicCodeRoots,
  state: ProcessUseCheckState,
): boolean {
  const parameter = callback.parameters[parameterIndex];
  if (!parameter || !ts.isIdentifier(parameter.name)
    || parameter.dotDotDotToken !== undefined || parameter.initializer !== undefined) return false;
  const parameterKey = scopedIdentifierKey(parameter.name, roots.bindings);
  const callbackName = callback.name;
  const callbackNameKey = callbackName ? scopedIdentifierKey(callbackName, roots.bindings) : undefined;
  const cycleKey = `${callback.pos}:${parameterIndex}`;
  if (state.activeParameters.has(cycleKey)) return false;
  state.activeParameters.add(cycleKey);
  let closed = true;
  let sawReference = false;

  const visit = (node: ts.Node, nestedFunction = false): void => {
    if (!closed) return;
    if (!nestedFunction
      && node.kind === ts.SyntaxKind.ThisKeyword
      && !ts.isArrowFunction(callback)) {
      closed = false;
      return;
    }
    if (!nestedFunction
      && ts.isIdentifier(node)
      && runtimeValueIdentifier(node)
      && unshadowedAmbientIdentifier(node, "arguments", roots.bindings)) {
      closed = false;
      return;
    }
    if (!nestedFunction
      && ts.isIdentifier(node)
      && callbackNameKey !== undefined
      && scopedIdentifierKey(node, roots.bindings) === callbackNameKey
      && (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent))
      && node.parent.expression === node
      && (propertyName(node.parent) === "arguments" || propertyName(node.parent) === "caller")) {
      closed = false;
      return;
    }
    if (ts.isIdentifier(node)
      && node !== parameter.name
      && runtimeValueIdentifier(node)
      && scopedIdentifierKey(node, roots.bindings) === parameterKey) {
      sawReference = true;
      if (nestedFunction || !processValueUseIsClosed(node, roots, state, false)) closed = false;
      return;
    }
    const nested = nestedFunction || (node !== callback && ts.isFunctionLike(node));
    ts.forEachChild(node, (child) => visit(child, nested));
  };
  if (callback.body) visit(callback.body);
  state.activeParameters.delete(cycleKey);
  return closed && sawReference;
}

function localCallbackReferenceIsStable(
  node: ts.Expression,
  roots: DynamicCodeRoots,
): boolean {
  node = unwrapExpression(node);
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    return localAuthorityCallbackIsStable(node, roots);
  }
  if (!ts.isIdentifier(node) || localCallbackTargets(node, roots).size === 0) return false;
  const key = scopedIdentifierKey(node, roots.bindings);
  let stable = true;
  const visit = (candidate: ts.Node): void => {
    if (!stable) return;
    if (ts.isIdentifier(candidate)
      && runtimeValueIdentifier(candidate)
      && scopedIdentifierKey(candidate, roots.bindings) === key
      && nodeIsAssigned(candidate)) {
      stable = false;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node.getSourceFile());
  return stable;
}

function localCallbackArgumentUseIsClosed(
  call: ts.CallExpression,
  value: ts.Expression,
  roots: DynamicCodeRoots,
  state: ProcessUseCheckState,
): boolean {
  const callTarget = unwrapExpression(call.expression);
  const callbackReference = (ts.isPropertyAccessExpression(callTarget)
    || ts.isElementAccessExpression(callTarget))
    && (propertyName(callTarget) === "call" || propertyName(callTarget) === "apply")
    ? callTarget.expression
    : callTargetNamed(call, "Reflect", "apply", roots.bindings)
      ? call.arguments[0]
      : callTarget;
  if (!callbackReference || !localCallbackReferenceIsStable(callbackReference, roots)) return false;
  let matched = false;
  for (const invocation of localCallbackInvocations(call, roots)) {
    for (let index = 0; index < invocation.arguments.length; index += 1) {
      if (invocation.arguments[index] !== value) continue;
      matched = true;
      if (!ts.isArrowFunction(invocation.callback)) return false;
      if (!localAuthorityCallbackIsStable(invocation.callback, roots)) return false;
      if (!callbackParameterUsesAreClosed(invocation.callback, index, roots, state)) return false;
    }
  }
  return matched;
}

function authorityMemberIsMutated(
  member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): boolean {
  return nodeIsAssigned(transparentAuthorityUse(member));
}

function ambientExitCodeAssignmentIsClosed(
  member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  roots: DynamicCodeRoots,
): boolean {
  if (!ts.isPropertyAccessExpression(member)
    || member.name.text !== "exitCode"
    || !ts.isIdentifier(unwrapExpression(member.expression))
    || !unshadowedAmbientIdentifier(
      unwrapExpression(member.expression) as ts.Identifier,
      "process",
      roots.bindings,
    )) return false;
  const value = transparentAuthorityUse(member);
  return ts.isBinaryExpression(value.parent)
    && value.parent.left === value
    && value.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

function processOperationalCallIsClosed(
  member: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  roots: DynamicCodeRoots,
): boolean {
  if (!ts.isPropertyAccessExpression(member)
    || !ts.isIdentifier(unwrapExpression(member.expression))
    || !unshadowedAmbientIdentifier(
      unwrapExpression(member.expression) as ts.Identifier,
      "process",
      roots.bindings,
    )) return false;
  const name = member.name.text;
  if (!directOperationalProcessMethods.has(name)) return false;
  const call = member.parent;
  if (!ts.isCallExpression(call)
    || call.expression !== member
    || !ts.isExpressionStatement(call.parent)) return false;
  if (name === "send") return true;
  const listener = call.arguments[1];
  if (!listener) return false;
  const callbacks = localCallbackTargets(listener, roots);
  return callbacks.size > 0 && [...callbacks].every((callback) =>
    ts.isArrowFunction(callback) && localAuthorityCallbackIsStable(callback, roots));
}

function localProcessContainerUseIsClosed(
  property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment,
  roots: DynamicCodeRoots,
  state: ProcessUseCheckState,
): boolean {
  const processProperty = ts.isShorthandPropertyAssignment(property)
    ? property.name.text
    : bindingPropertyName(property.name);
  if (processProperty === undefined || !ts.isObjectLiteralExpression(property.parent)) return false;
  const objectValue = transparentAuthorityUse(property.parent);
  if (property.parent.properties.some((candidate) =>
    (ts.isPropertyAssignment(candidate) && bindingPropertyName(candidate.name) === "__proto__")
    || ts.isMethodDeclaration(candidate)
    || ts.isGetAccessorDeclaration(candidate)
    || ts.isSetAccessorDeclaration(candidate))) return false;
  const declaration = objectValue.parent;
  if (!ts.isVariableDeclaration(declaration)
    || declaration.initializer !== objectValue
    || !ts.isIdentifier(declaration.name)) return false;
  const holderKey = scopedIdentifierKey(declaration.name, roots.bindings);
  const ownPropertyNames = new Set(property.parent.properties.flatMap((candidate) => {
    if (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) {
      const name = ts.isShorthandPropertyAssignment(candidate)
        ? candidate.name.text
        : bindingPropertyName(candidate.name);
      return name === undefined ? [] : [name];
    }
    return [];
  }));
  let sawProcessProperty = false;
  let closed = true;

  const visit = (node: ts.Node): void => {
    if (!closed) return;
    if (ts.isIdentifier(node)
      && node !== declaration.name
      && runtimeValueIdentifier(node)
      && scopedIdentifierKey(node, roots.bindings) === holderKey) {
      const holder = transparentAuthorityUse(node);
      const member = holder.parent;
      if ((!ts.isPropertyAccessExpression(member) && !ts.isElementAccessExpression(member))
        || member.expression !== holder) {
        closed = false;
        return;
      }
      const name = propertyName(member);
      if (name === undefined || !ownPropertyNames.has(name)) {
        closed = false;
        return;
      }
      if (name !== processProperty) {
        const use = transparentAuthorityUse(member).parent;
        if (ts.isCallExpression(use) && use.expression === transparentAuthorityUse(member)) {
          closed = false;
          return;
        }
      }
      if (name === processProperty) {
        sawProcessProperty = true;
        if (!processValueUseIsClosed(member, roots, state, false)) closed = false;
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.getSourceFile());
  return closed && sawProcessProperty;
}

function processValueUseIsClosed(
  node: ts.Expression,
  roots: DynamicCodeRoots,
  state: ProcessUseCheckState,
  allowLocalContainer: boolean,
): boolean {
  const value = transparentAuthorityUse(node);
  const parent = value.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
    && parent.expression === value) {
    const name = propertyName(parent);
    if (name === undefined) return false;
    if (directOperationalProcessMethods.has(name)) {
      return processOperationalCallIsClosed(parent, roots);
    }
    if (!auditedAmbientProcessReadProperties.has(name)) return false;
    if (authorityMemberIsMutated(parent)) {
      return name === "exitCode" && ambientExitCodeAssignmentIsClosed(parent, roots);
    }
    const member = transparentAuthorityUse(parent);
    return !(((ts.isCallExpression(member.parent) || ts.isNewExpression(member.parent))
      && member.parent.expression === member)
      || (ts.isTaggedTemplateExpression(member.parent) && member.parent.tag === member));
  }
  if (ts.isBinaryExpression(parent)
    && identityComparisonOperators.has(parent.operatorToken.kind)
    && (parent.left === value || parent.right === value)) return true;
  if (ts.isCallExpression(parent)
    && parent.arguments.some((argument) => argument === value)) {
    return localCallbackArgumentUseIsClosed(parent, value, roots, state);
  }
  if (allowLocalContainer && ts.isPropertyAssignment(parent) && parent.initializer === value) {
    return localProcessContainerUseIsClosed(parent, roots, state);
  }
  if (allowLocalContainer && ts.isShorthandPropertyAssignment(parent) && parent.name === value) {
    return localProcessContainerUseIsClosed(parent, roots, state);
  }
  return false;
}

function ambientProcessAuthorityEscapes(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  return ambientProcessOrigin(node, roots)
    && !processValueUseIsClosed(node, roots, { activeParameters: new Set() }, true);
}

function globalProcessBindingEscapes(node: ts.BindingElement, roots: DynamicCodeRoots): boolean {
  const name = bindingPropertyName(node.propertyName)
    ?? (ts.isIdentifier(node.name) ? node.name.text : undefined);
  if ((name !== "process" && node.dotDotDotToken === undefined)
    || !ts.isObjectBindingPattern(node.parent)) return false;
  const declaration = node.parent.parent;
  return ts.isVariableDeclaration(declaration)
    && Boolean(declaration.initializer && globalObjectTarget(declaration.initializer, roots));
}

const auditedGlobalObjectProperties = new Set(["fetch", "Math"]);
const globalObjectSelfProperties = new Set(["global", "globalThis", "self", "window"]);

function globalObjectValueUseIsClosed(node: ts.Expression): boolean {
  const value = transparentAuthorityUse(node);
  const parent = value.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
    && parent.expression === value) {
    const name = propertyName(parent);
    if (name === undefined || name === "process" || authorityMemberIsMutated(parent)) return false;
    if (globalObjectSelfProperties.has(name)) return globalObjectValueUseIsClosed(parent);
    if (!auditedGlobalObjectProperties.has(name)
      && !dynamicEvaluatorNames.has(name)
      && name !== "Proxy") return false;
    const member = transparentAuthorityUse(parent);
    return !(((ts.isCallExpression(member.parent) || ts.isNewExpression(member.parent))
      && member.parent.expression === member)
      || (ts.isTaggedTemplateExpression(member.parent) && member.parent.tag === member));
  }
  return ts.isBinaryExpression(parent)
    && identityComparisonOperators.has(parent.operatorToken.kind)
    && (parent.left === value || parent.right === value);
}

function globalObjectAuthorityEscapes(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  const directGlobal = unwrapExpression(node);
  if (!ts.isIdentifier(directGlobal)
    || !runtimeValueIdentifier(directGlobal)
    || !unshadowedAmbientIdentifier(directGlobal, directGlobal.text, roots.bindings)
    || !globalObjectSelfProperties.has(directGlobal.text)) return false;
  for (let current: ts.Node | undefined = directGlobal.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return false;
    if (ts.isStatement(current) || ts.isSourceFile(current)) break;
  }
  return !globalObjectValueUseIsClosed(node);
}

function isDynamicCodeCall(node: ts.CallExpression | ts.NewExpression, roots: DynamicCodeRoots): boolean {
  if (dynamicCodeTarget(node.expression, roots)) return true;
  const proxyCall = propertyName(node.expression) === "revocable"
    && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
    ? proxyTarget(node.expression.expression, roots)
    : proxyTarget(node.expression, roots);
  const firstArgument = node.arguments?.[0];
  if (proxyCall && firstArgument && globalObjectTarget(firstArgument, roots)) return true;
  if (ts.isCallExpression(node)
    && (callTargetNamed(node, "Reflect", "apply", roots.bindings)
      || callTargetNamed(node, "Reflect", "construct", roots.bindings))) {
    return Boolean(node.arguments[0] && dynamicCodeTarget(node.arguments[0], roots));
  }
  return propertyName(node.expression) === "constructor"
    && !ordinaryConstructorMethod(node.expression, roots);
}

function processAuthorityCapability(node: ts.Expression, roots: DynamicCodeRoots): boolean {
  node = unwrapExpression(node);
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  const name = propertyName(node);
  return processObjectTarget(node.expression, roots)
    && (name === undefined || name === "getBuiltinModule" || name === "dlopen");
}

function runtimeBuiltinLoaderExtraction(node: ts.CallExpression, roots: DynamicCodeRoots): boolean {
  const reflected = methodCallArguments(node, "Reflect", "get", roots.reflectGets, roots)
    ?? methodCallArguments(node, "Object", "getOwnPropertyDescriptor", roots.descriptorGets, roots)
    ?? methodCallArguments(node, "Reflect", "getOwnPropertyDescriptor", roots.descriptorGets, roots);
  if (reflected) {
    if (!reflected[0]) return true;
    if (!processObjectTarget(reflected[0], roots)) return false;
    const name = staticStringExpression(reflected[1]);
    return name === undefined || name === "getBuiltinModule" || name === "dlopen";
  }
  const descriptorMap = methodCallArguments(
    node,
    "Object",
    "getOwnPropertyDescriptors",
    roots.descriptorMaps,
    roots,
  );
  return descriptorMap !== undefined
    && Boolean((!descriptorMap[0] || processObjectTarget(descriptorMap[0], roots))
      && node.parent
      && (ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent))
      && (propertyName(node.parent) === undefined
        || propertyName(node.parent) === "getBuiltinModule"
        || propertyName(node.parent) === "dlopen"));
}

function evaluatorIdentifierEscapes(node: ts.Identifier, roots: DynamicCodeRoots): boolean {
  if (!ambientOrAliasTarget(node, roots.evaluators, dynamicEvaluatorNames, roots.bindings)) return false;
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node))
    || (ts.isVariableDeclaration(parent) && parent.name === node)
    || ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
      || ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) && parent.name === node)
    || (ts.isParameter(parent) && parent.name === node)
    || ((ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)
      || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent)
      || ts.isMethodSignature(parent)) && parent.name === node)
    || ts.isImportSpecifier(parent)
    || ts.isExportSpecifier(parent)) return false;
  for (let ancestor: ts.Node | undefined = parent; ancestor && !ts.isStatement(ancestor); ancestor = ancestor.parent) {
    if (ts.isTypeNode(ancestor)
      && !(ts.isExpressionWithTypeArguments(ancestor)
        && ts.isHeritageClause(ancestor.parent)
        && ancestor.parent.token === ts.SyntaxKind.ExtendsKeyword)) return false;
    if ((ts.isCallExpression(ancestor) || ts.isNewExpression(ancestor))
      && isDynamicCodeCall(ancestor, roots)) return false;
  }
  return !(ts.isVariableDeclaration(parent) && parent.initializer === node)
    && !(ts.isBinaryExpression(parent)
      && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && parent.right === node);
}

function ambientModuleAuthorityUse(node: ts.Identifier, roots: ModuleLoaderRoots): boolean {
  if (!unshadowedAmbientIdentifier(node, "module", roots.bindings)) return false;
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent))
    && parent.expression === node
    && propertyName(parent) === "exports") return false;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.propertyName === node)) return false;
  for (let ancestor: ts.Node | undefined = parent; ancestor && !ts.isStatement(ancestor); ancestor = ancestor.parent) {
    if (ts.isTypeNode(ancestor)) return false;
    if ((ts.isPropertyAccessExpression(ancestor) || ts.isElementAccessExpression(ancestor))
      && moduleLoaderCapability(ancestor, roots)) return false;
    if (ts.isCallExpression(ancestor)
      && (moduleLoaderCapability(ancestor, roots)
        || moduleLoaderCapability(ancestor.expression, roots))) return false;
    if (ts.isVariableDeclaration(ancestor) && ts.isObjectBindingPattern(ancestor.name)
      && ancestor.name.elements.some((element) => bindingExposesModuleLoader(element, roots))) return false;
  }
  return true;
}

function commonJsWrapperArgumentsUse(
  node: ts.Identifier,
  bindings: LexicalBindings,
  commonJsSource: boolean,
): boolean {
  if (!commonJsSource || !unshadowedAmbientIdentifier(node, "arguments", bindings)) return false;
  const parent = node.parent;
  if ((ts.isPropertyAccessExpression(parent) && parent.name === node)
    || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent) || ts.isMethodSignature(parent)
      || ts.isPropertySignature(parent)) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.propertyName === node)) return false;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return false;
    if (ts.isSourceFile(current)) return true;
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return false;
  }
  return false;
}

function extractImportReferences(
  repositoryRoot: string,
  absolutePath: string,
  content: string,
  moduleType: WorkspacePackage["moduleType"],
): ImportReference[] {
  const source = ts.createSourceFile(absolutePath, content, ts.ScriptTarget.Latest, true);
  const lexicalBindings = runtimeLexicalBindings(source);
  const evaluatorRoots = dynamicCodeRoots(source, lexicalBindings);
  const loaderRoots = moduleLoaderRoots(source, lexicalBindings);
  const commonJsSource = sourceResolutionMode(absolutePath, moduleType) === "require";
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
    // Ambient process is a loader capability: reject unsupported transfers at
    // the origin instead of trying to enumerate every downstream wrapper.
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && ambientProcessAuthorityEscapes(node, evaluatorRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && globalObjectAuthorityEscapes(node, evaluatorRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isBindingElement(node) && globalProcessBindingEscapes(node, evaluatorRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isImportDeclaration(node)) {
      const typeOnly = importDeclarationIsTypeOnly(node, source);
      record(node, node.moduleSpecifier, "import-declaration", true, undefined, {
        resolutionMode: resolutionModeAttribute(node.attributes)
          ?? sourceResolutionMode(absolutePath, moduleType),
        typeOnly,
      });
      if (importExposesModuleLoader(node, source)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      }
    } else if (ts.isExportDeclaration(node)) {
      record(node, node.moduleSpecifier, "export-declaration", true, undefined, {
        resolutionMode: resolutionModeAttribute(node.attributes)
          ?? sourceResolutionMode(absolutePath, moduleType),
        typeOnly: exportDeclarationIsTypeOnly(node, source),
      });
      if (exportExposesModuleLoader(node, source)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      }
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      record(node, node.moduleReference.expression, "import-equals");
      if (runtimeAuthorityModuleSpecifier(node.moduleReference.expression)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      }
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
      } else if (processAuthorityCapability(node.expression, evaluatorRoots)
        || runtimeBuiltinLoaderExtraction(node, evaluatorRoots)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (runtimeAuthorityModuleSpecifier(node.arguments[0])) {
          record(node, undefined, "module-loader", true, unsupportedModuleLoader);
        } else {
          record(node, node.arguments[0], "dynamic-import", false);
        }
      } else if ((ts.isPropertyAccessExpression(node.expression)
        || ts.isElementAccessExpression(node.expression))
        && propertyName(node.expression) === "require"
        && isModuleLoaderObject(node.expression.expression, loaderRoots)
        && !unshadowedAmbientIdentifier(
          unwrapExpression(node.expression.expression),
          "module",
          lexicalBindings,
        )) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      } else if ((unshadowedAmbientIdentifier(unwrapExpression(node.expression), "require", lexicalBindings))
        || ((ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
          && propertyName(node.expression) === "require"
          && isModuleLoaderObject(node.expression.expression, loaderRoots))) {
        if (runtimeAuthorityModuleSpecifier(node.arguments[0])) {
          record(node, undefined, "module-loader", true, unsupportedModuleLoader);
        } else {
          record(node, node.arguments[0], "require-call", false);
        }
      } else if (moduleLoaderCapability(node, loaderRoots)
        || moduleLoaderCapability(node.expression, loaderRoots)) {
        record(node, undefined, "module-loader", true, unsupportedModuleLoader);
      }
    } else if (ts.isNewExpression(node) && isDynamicCodeCall(node, evaluatorRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && processAuthorityCapability(node, evaluatorRoots) && !isDirectCallTarget(node)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && propertyName(node) === "require"
      && isModuleLoaderObject(node.expression, loaderRoots)
      && !isDirectCallTarget(node)) {
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
    } else if (ts.isBindingElement(node)
      && ts.isObjectBindingPattern(node.parent)
      && ts.isVariableDeclaration(node.parent.parent)
      && Boolean(node.parent.parent.initializer
        && processObjectTarget(node.parent.parent.initializer, evaluatorRoots))
      && (() => {
        const name = bindingPropertyName(node.propertyName)
          ?? (ts.isIdentifier(node.name) ? node.name.text : undefined);
        return name === undefined || name === "getBuiltinModule" || name === "dlopen";
      })()) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isBindingElement(node)
      && (bindingPropertyName(node.propertyName) === "constructor"
        || (node.propertyName !== undefined
          && ts.isComputedPropertyName(node.propertyName)
          && staticStringExpression(node.propertyName.expression) === undefined))
      && ts.isObjectBindingPattern(node.parent)
      && ts.isVariableDeclaration(node.parent.parent)
      && Boolean(node.parent.parent.initializer
        && !ts.isObjectLiteralExpression(unwrapExpression(node.parent.parent.initializer)))) {
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
    } else if (ts.isBinaryExpression(node)
      && (objectAssignmentBinding(
        node,
        (expression) => globalObjectTarget(expression, evaluatorRoots),
        new Set(["process"]),
      ) || objectAssignmentBinding(
        node,
        (expression) => processObjectTarget(expression, evaluatorRoots),
        new Set(["getBuiltinModule", "dlopen"]),
      ) || objectAssignmentBinding(
        node,
        (expression) => unshadowedAmbientIdentifier(unwrapExpression(expression), "Reflect", lexicalBindings),
        new Set(["get"]),
      ) || objectAssignmentBinding(
        node,
        (expression) => unshadowedAmbientIdentifier(unwrapExpression(expression), "Object", lexicalBindings),
        new Set(["getOwnPropertyDescriptor", "getOwnPropertyDescriptors"]),
      ))) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && dynamicCodeTarget(node, evaluatorRoots)
      && !isDirectCallTarget(node)
      && !(ts.isVariableDeclaration(node.parent) && node.parent.initializer === node)
      && !(ts.isBinaryExpression(node.parent) && node.parent.right === node)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isIdentifier(node) && evaluatorIdentifierEscapes(node, evaluatorRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isIdentifier(node)
      && commonJsWrapperArgumentsUse(node, lexicalBindings, commonJsSource)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isIdentifier(node) && ambientModuleAuthorityUse(node, loaderRoots)) {
      record(node, undefined, "module-loader", true, unsupportedModuleLoader);
    } else if (ts.isIdentifier(node)
      && unshadowedAmbientIdentifier(node, "require", lexicalBindings)) {
      const directRequire = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
      const propertyNameIdentifier = node.parent
        && ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
          || ((ts.isPropertyAssignment(node.parent) || ts.isMethodDeclaration(node.parent)
            || ts.isPropertyDeclaration(node.parent) || ts.isMethodSignature(node.parent)
            || ts.isPropertySignature(node.parent)) && node.parent.name === node));
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

function relativeModuleSpecifier(specifier: string): boolean {
  return specifier === "."
    || specifier === ".."
    || specifier.startsWith("./")
    || specifier.startsWith("../");
}

async function localSourceViolationRule(
  repositoryRoot: string,
  sourcePackage: WorkspacePackage,
  reference: ImportReference,
): Promise<DependencyRule | undefined> {
  const normalized = normalizedSpecifier(reference.specifier);
  const repositoryRootSpecifier = /^(?:adapters|apps|packages)\//u.test(normalized);
  const absoluteSpecifier = isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized) || normalized.startsWith("//");
  const relativeSpecifier = reference.filesystemReference || relativeModuleSpecifier(normalized);
  if (!repositoryRootSpecifier && !absoluteSpecifier && !relativeSpecifier) return undefined;
  if (repositoryRootSpecifier || absoluteSpecifier) return DEPENDENCY_RULES.crossPackageSourcePath;

  const absoluteTarget = resolve(dirname(resolve(repositoryRoot, reference.sourceFile)), normalized);
  if (!isPathInside(sourcePackage.directory, absoluteTarget)) return DEPENDENCY_RULES.crossPackageSourcePath;
  const segments = relative(sourcePackage.directory, absoluteTarget).split(sep).filter(Boolean);
  if (segments.some((segment) => unscannedPackageDirectories.has(segment))) {
    return DEPENDENCY_RULES.unscannedSourcePath;
  }
  if (extname(absoluteTarget) === "" || !isAuditableExportTarget(absoluteTarget)) {
    return DEPENDENCY_RULES.unscannedSourcePath;
  }
  try {
    const physicalTarget = await physicalPathWithoutLinks(
      repositoryRoot,
      absoluteTarget,
      `${reference.sourceFile} local source target`,
    );
    const metadata = await lstat(physicalTarget);
    if (!metadata.isFile() || !isPathInside(sourcePackage.physicalDirectory, physicalTarget)) {
      return DEPENDENCY_RULES.unscannedSourcePath;
    }
  } catch {
    return DEPENDENCY_RULES.unscannedSourcePath;
  }
  return undefined;
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
  if (!target.startsWith("./") || target.includes("%") || target.includes("\\")) return undefined;
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

function validBinCommand(command: string): boolean {
  if (!/^[A-Za-z\d][A-Za-z\d._-]{0,213}$/u.test(command) || command.endsWith(".")) return false;
  const portableBase = command.split(".", 1)[0]!.toLowerCase();
  return !/^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/u.test(portableBase);
}

function portableBinPathSegment(segment: string): boolean {
  if (segment === "" || segment === "." || segment === ".." || segment.endsWith(".")) return false;
  if (segment.toLowerCase() === "bower_components" || segment.toLowerCase() === "node_modules") return false;
  const portableBase = segment.split(".", 1)[0]!.toLowerCase();
  return !/^(?:aux|con|nul|prn|com[1-9]|lpt[1-9])$/u.test(portableBase);
}

function normalizedBinTarget(target: string): string | undefined {
  if (!/^\.\/[A-Za-z\d_./-]+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u.test(target)) return undefined;
  const segments = target.slice(2).split("/");
  if (!segments.every(portableBinPathSegment)) return undefined;
  return target;
}

function binSpecifier(bin: ManifestBin): string {
  return bin.shape === "entry" ? `${bin.command} -> ${bin.target}` : bin.target;
}

async function packageBinAudit(
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
): Promise<PackageBinAudit> {
  const files = new Set<string>();
  const violations: DependencyViolation[] = [];
  for (const bin of workspacePackage.bins) {
    const normalizedTarget = bin.shape === "entry" && validBinCommand(bin.command)
      ? normalizedBinTarget(bin.target)
      : undefined;
    let valid = normalizedTarget !== undefined;
    let physicalTarget: string | undefined;
    if (normalizedTarget) {
      const lexicalTarget = resolve(workspacePackage.directory, normalizedTarget);
      try {
        physicalTarget = await physicalPathWithoutLinks(
          repositoryRoot,
          lexicalTarget,
          `${workspacePackage.repositoryManifestPath} bin target`,
        );
        const metadata = await lstat(physicalTarget);
        valid = metadata.isFile()
          && packageForPhysicalPath(packages, physicalTarget)?.name === workspacePackage.name
          && isPathInside(workspacePackage.physicalDirectory, physicalTarget);
        if (valid) {
          const firstLine = (await readFile(physicalTarget, "utf8")).split(/\r?\n/u, 1)[0];
          valid = firstLine === "#!/usr/bin/env node";
        }
      } catch {
        valid = false;
      }
    }
    if (valid && physicalTarget) {
      files.add(physicalTarget);
    } else {
      violations.push({
        sourceFile: workspacePackage.repositoryManifestPath,
        line: bin.line,
        column: bin.column,
        specifier: binSpecifier(bin),
        kind: "manifest-bin",
        rule: DEPENDENCY_RULES.packageBinEntrypoint,
      });
    }
  }
  return { files, violations };
}

function packageBinCollisionViolations(packages: readonly WorkspacePackage[]): DependencyViolation[] {
  const commands = new Map<string, { workspacePackage: WorkspacePackage; bin: ManifestBin }[]>();
  for (const workspacePackage of packages) {
    for (const bin of workspacePackage.bins) {
      if (bin.shape !== "entry" || !validBinCommand(bin.command)) continue;
      const key = bin.command.toLowerCase();
      const entries = commands.get(key) ?? [];
      entries.push({ workspacePackage, bin });
      commands.set(key, entries);
    }
  }
  return [...commands.values()].filter((entries) => entries.length > 1).flatMap((entries) =>
    entries.map(({ workspacePackage, bin }) => ({
      sourceFile: workspacePackage.repositoryManifestPath,
      line: bin.line,
      column: bin.column,
      specifier: binSpecifier(bin),
      kind: "manifest-bin" as const,
      rule: DEPENDENCY_RULES.packageBinEntrypoint,
    })));
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
  if (reference.specifier.includes("\\")
    || (reference.kind === "require-call" && /[?#]/u.test(reference.specifier))) {
    return DEPENDENCY_RULES.ambiguousModuleSpecifier;
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(reference.specifier) && !reference.specifier.startsWith("node:")) {
    return DEPENDENCY_RULES.urlModuleSpecifier;
  }
  if (reference.specifier.includes("%")) return DEPENDENCY_RULES.encodedModuleSpecifier;
  if (reference.specifier.startsWith("#")) return DEPENDENCY_RULES.packageImportAlias;
  const localRule = await localSourceViolationRule(repositoryRoot, sourcePackage, reference);
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

async function ownedManifestScriptTarget(
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
  relativeTarget: string,
  allowBuildOutput = false,
): Promise<boolean> {
  const target = resolve(workspacePackage.directory, relativeTarget);
  if (!isPathInside(workspacePackage.directory, target)) return false;
  const segments = relative(workspacePackage.directory, target).split(sep).filter(Boolean);
  if (segments.some((segment) => segment === "bower_components" || segment === "node_modules"
    || (!allowBuildOutput && segment === "dist"))) return false;
  try {
    const physical = await physicalPathWithoutLinks(
      repositoryRoot,
      target,
      `${workspacePackage.repositoryManifestPath} script target`,
    );
    const metadata = await lstat(physical);
    return metadata.isFile() && packageForPhysicalPath(packages, physical)?.name === workspacePackage.name;
  } catch {
    return false;
  }
}

async function safeManifestScript(
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
  script: ManifestScript,
): Promise<boolean> {
  const nodeEntrypoint = /^node (\.\/[A-Za-z\d_./-]+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx))$/u.exec(script.command);
  if (nodeEntrypoint) {
    return ownedManifestScriptTarget(repositoryRoot, workspacePackage, packages, nodeEntrypoint[1]!, true);
  }
  const typecheckConfig = /^tsc -p ((?:\.\/)?(?:jsconfig|tsconfig)(?:\.[A-Za-z\d_-]+)*\.json)$/u.exec(script.command);
  return Boolean(typecheckConfig
    && await ownedManifestScriptTarget(repositoryRoot, workspacePackage, packages, typecheckConfig[1]!));
}

async function manifestViolations(
  repositoryRoot: string,
  workspacePackage: WorkspacePackage,
  packages: readonly WorkspacePackage[],
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
  allowedGraph: AllowedDependencyGraph,
): Promise<DependencyViolation[]> {
  const violations: DependencyViolation[] = workspacePackage.packageImports.map((entry) => ({
    sourceFile: workspacePackage.repositoryManifestPath,
    line: entry.line,
    column: entry.column,
    specifier: entry.name,
    kind: "package-import-alias",
    rule: DEPENDENCY_RULES.packageImportAlias,
  }));
  for (const script of workspacePackage.scripts) {
    if (!await safeManifestScript(repositoryRoot, workspacePackage, packages, script)) {
      violations.push({
        sourceFile: workspacePackage.repositoryManifestPath,
        line: script.line,
        column: script.column,
        specifier: script.name,
        kind: "manifest-script",
        rule: DEPENDENCY_RULES.moduleHookScript,
      });
    }
  }
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

function violationKey(entry: DependencyViolation): string {
  return JSON.stringify([
    entry.sourceFile,
    entry.line,
    entry.column,
    entry.specifier,
    entry.kind,
    entry.rule,
  ]);
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
  const architectureExcludedDirectories = [
    resolve(repositoryRoot, "apps/gateway/src/public/console"),
    resolve(repositoryRoot, "apps/gateway/public/console"),
  ];
  const exportAudits = new Map(await Promise.all(packages.map(async (workspacePackage) => [
    workspacePackage.name,
    await packageExportAudit(repositoryRoot, workspacePackage, packages),
  ] as const)));
  const binAudits = new Map(await Promise.all(packages.map(async (workspacePackage) => [
    workspacePackage.name,
    await packageBinAudit(repositoryRoot, workspacePackage, packages),
  ] as const)));
  const packageFiles = await Promise.all(packages.map(async (workspacePackage) => ({
    workspacePackage,
    inventory: await sourceInventory(
      repositoryRoot,
      workspacePackage.directory,
      new Set([
        ...[...packageDirectories].filter((directory) => directory !== workspacePackage.directory
          && isPathInside(workspacePackage.directory, directory)),
        ...architectureExcludedDirectories.filter((directory) => isPathInside(workspacePackage.directory, directory)),
      ]),
      new Set([
        ...(exportAudits.get(workspacePackage.name)?.files ?? []),
        ...(binAudits.get(workspacePackage.name)?.files ?? []),
        ...workspacePackage.scriptSourceFiles,
      ]),
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
  const packageManifestViolations = (await Promise.all(packages.map((workspacePackage) => manifestViolations(
    repositoryRoot,
    workspacePackage,
    packages,
    packagesByName,
    allowedGraph,
  )))).flat();
  const packageNodeModulesViolations = (await Promise.all(packages.map((workspacePackage) =>
    nodeModulesLinkViolations(repositoryRoot, workspacePackage, packages)))).flat();
  const resolverNodeModulesViolations = await resolverVisibleNodeModulesViolations(
    repositoryRoot,
    references,
    packages,
  );
  const sortedCandidates = [
    ...graphIntegrityViolations(packages, allowedGraph),
    ...packageBinCollisionViolations(packages),
    ...packageManifestViolations,
    ...packageNodeModulesViolations,
    ...resolverNodeModulesViolations,
    ...await typescriptPathViolations(repositoryRoot, packages),
    ...[...exportAudits.values()].flatMap(({ violations }) => violations),
    ...[...binAudits.values()].flatMap(({ violations }) => violations),
    ...packageFiles.flatMap(({ inventory }) => inventory.violations),
    ...sourceViolations,
  ].sort((left, right) => left.sourceFile.localeCompare(right.sourceFile)
    || left.line - right.line
    || left.column - right.column
    || left.specifier.localeCompare(right.specifier)
    || left.rule.localeCompare(right.rule));
  const candidates = [...new Map(sortedCandidates.map((candidate) => [
    violationKey(candidate),
    candidate,
  ])).values()];

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
    : violation.kind === "manifest-bin" || violation.kind === "manifest-script" || violation.kind === "module-loader"
      || violation.kind === "typescript-path-alias"
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

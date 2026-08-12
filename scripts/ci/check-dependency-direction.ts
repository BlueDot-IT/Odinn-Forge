import { readFile, readdir } from "node:fs/promises";
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
} as const satisfies Record<string, readonly string[]>;

export const DEPENDENCY_RULES = {
  adapterToAdapter: "adapters cannot depend on another adapter",
  crossPackageSourcePath: "cross-package imports must use an exported workspace package specifier",
  packageToApp: "packages and adapters cannot depend on apps",
  privateWorkspaceSubpath: "workspace imports must use package.json exports",
  undeclaredWorkspaceDependency: "workspace source imports must be declared in package.json",
  unknownWorkspaceTarget: "@odinn and workspace protocol dependencies must resolve to a workspace package",
  unregisteredWorkspacePackage: "workspace packages must be registered in the allowed dependency graph",
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
  | "require-call"
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

interface ManifestDependency {
  name: string;
  version: string;
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
}

interface WorkspaceImportTarget {
  target: WorkspacePackage;
  packageSubpath?: string;
  crossesSourceBoundary: boolean;
}

const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const nonLiteralSpecifier = "<non-literal module specifier>";
const graph: Readonly<Record<string, readonly string[]>> = WORKSPACE_DEPENDENCY_GRAPH;

export const LEGACY_DEPENDENCY_BASELINE: readonly LegacyDependencyBaselineEntry[] = [];

function repositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function isPathInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true }))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules") {
        files.push(...await sourceFiles(absolutePath));
      }
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
      files.push(absolutePath);
    }
  }
  return files;
}

async function packageManifestFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "dist" && entry.name !== "node_modules") {
        files.push(...await packageManifestFiles(absolutePath));
      }
    } else if (entry.isFile() && entry.name === "package.json") {
      files.push(absolutePath);
    }
  }
  return files;
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
  return dependencies.sort((left, right) => left.name.localeCompare(right.name));
}

function workspacePackageKind(repositoryManifestPath: string): WorkspacePackageKind {
  if (repositoryManifestPath.startsWith("adapters/")) return "adapter";
  if (repositoryManifestPath.startsWith("apps/")) return "app";
  return "package";
}

async function workspacePackages(repositoryRoot: string): Promise<WorkspacePackage[]> {
  const manifestPaths = (await Promise.all(["adapters", "apps", "packages"].map((directory) =>
    packageManifestFiles(resolve(repositoryRoot, directory))))).flat();
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
  ): void => {
    const specifier = stringSpecifier(specifierNode) ?? (requireLiteral ? undefined : nonLiteralSpecifier);
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
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        record(node, node.arguments[0], "require-call", false);
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

function exportedSubpath(exportsValue: unknown, subpath: string): boolean {
  if (typeof exportsValue === "string" || Array.isArray(exportsValue)) return subpath === ".";
  if (!exportsValue || typeof exportsValue !== "object") return false;
  const entries = Object.entries(exportsValue as Record<string, unknown>);
  if (!entries.some(([key]) => key.startsWith("."))) return subpath === ".";
  return entries.some(([key, value]) => {
    if (value === null) return false;
    if (key === subpath) return true;
    const wildcard = key.indexOf("*");
    return wildcard >= 0
      && subpath.startsWith(key.slice(0, wildcard))
      && subpath.endsWith(key.slice(wildcard + 1));
  });
}

function graphRule(source: WorkspacePackage, target: WorkspacePackage): DependencyRule | undefined {
  if (source.name === target.name) return undefined;
  if (source.kind !== "app" && target.kind === "app") return DEPENDENCY_RULES.packageToApp;
  if (source.kind === "adapter" && target.kind === "adapter") return DEPENDENCY_RULES.adapterToAdapter;
  return graph[source.name]?.includes(target.name) ? undefined : DEPENDENCY_RULES.workspaceGraph;
}

function unknownWorkspaceTarget(specifier: string): boolean {
  return normalizedSpecifier(specifier).startsWith("@odinn/");
}

function sourceViolationRule(
  repositoryRoot: string,
  sourcePackage: WorkspacePackage,
  reference: ImportReference,
  packages: readonly WorkspacePackage[],
): DependencyRule | undefined {
  if (reference.specifier === nonLiteralSpecifier) return DEPENDENCY_RULES.workspaceDynamicImports;
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
  if (target.packageSubpath && !exportedSubpath(target.target.exports, target.packageSubpath)) {
    return DEPENDENCY_RULES.privateWorkspaceSubpath;
  }
  const directionRule = graphRule(sourcePackage, target.target);
  if (directionRule) return directionRule;
  if (sourcePackage.name !== target.target.name && !sourcePackage.dependencyNames.has(target.target.name)) {
    return DEPENDENCY_RULES.undeclaredWorkspaceDependency;
  }
  return undefined;
}

function manifestViolations(
  workspacePackage: WorkspacePackage,
  packagesByName: ReadonlyMap<string, WorkspacePackage>,
): DependencyViolation[] {
  const violations: DependencyViolation[] = [];
  if (!(workspacePackage.name in graph)) {
    violations.push({
      sourceFile: workspacePackage.repositoryManifestPath,
      line: 1,
      column: 1,
      specifier: workspacePackage.name,
      kind: "workspace-package",
      rule: DEPENDENCY_RULES.unregisteredWorkspacePackage,
    });
  }
  for (const dependency of workspacePackage.dependencies) {
    const target = packagesByName.get(dependency.name);
    let rule: DependencyRule | undefined;
    if (target) {
      rule = graphRule(workspacePackage, target);
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

function baselineKey(entry: Pick<LegacyDependencyBaselineEntry, "sourceFile" | "specifier" | "kind" | "rule">): string {
  return JSON.stringify([entry.sourceFile, entry.specifier, entry.kind, entry.rule]);
}

export async function checkDependencyDirection(
  repositoryRoot: string,
  baseline: readonly LegacyDependencyBaselineEntry[] = LEGACY_DEPENDENCY_BASELINE,
): Promise<DependencyDirectionResult> {
  const packages = await workspacePackages(repositoryRoot);
  const packagesByName = new Map(packages.map((workspacePackage) => [workspacePackage.name, workspacePackage]));
  const packageFiles = await Promise.all(packages.map(async (workspacePackage) => ({
    workspacePackage,
    files: await sourceFiles(workspacePackage.directory),
  })));
  const references = (await Promise.all(packageFiles.flatMap(({ workspacePackage, files }) =>
    files.map(async (absolutePath) => ({
      workspacePackage,
      references: extractImportReferences(repositoryRoot, absolutePath, await readFile(absolutePath, "utf8")),
    }))))).flat();
  const candidates = [
    ...packages.flatMap((workspacePackage) => manifestViolations(workspacePackage, packagesByName)),
    ...references.flatMap(({ workspacePackage, references: fileReferences }) =>
      fileReferences.flatMap((reference): DependencyViolation[] => {
        const rule = sourceViolationRule(repositoryRoot, workspacePackage, reference, packages);
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
  const subject = violation.kind === "manifest-dependency" || violation.kind === "workspace-package"
    ? "dependency"
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

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const DEPENDENCY_RULES = {
  kernelChannels: "packages/kernel cannot import @odinn/channel-*",
  kernelAdapters: "packages/kernel cannot import adapters/*",
  kernelDynamicImports: "packages/kernel cannot use non-literal dynamic imports",
  applicationChannels: "packages/application cannot import @odinn/channel-*",
  applicationAdapters: "packages/application cannot import adapters/*",
  applicationApps: "packages/application cannot import apps/*",
  applicationDynamicImports: "packages/application cannot use non-literal dynamic imports",
} as const;

export type DependencyRule = typeof DEPENDENCY_RULES[keyof typeof DEPENDENCY_RULES];

export type ImportKind =
  | "dynamic-import"
  | "export-declaration"
  | "import-declaration"
  | "import-equals"
  | "import-type"
  | "require-call";

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
  violations: readonly DependencyViolation[];
  baselineErrors: readonly string[];
  acceptedLegacyOccurrences: number;
}

type ImportReference = Omit<DependencyViolation, "rule">;

interface RepositoryDependencyTargets {
  adapters: readonly string[];
  apps: readonly string[];
}

const sourceExtensions = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const nonLiteralSpecifier = "<non-literal module specifier>";

/**
 * Temporary migration baseline. It is deliberately occurrence- and syntax-kind-aware:
 * it accepts exactly the two Discord references that predate this checker, not every
 * reference in this file. PR 2 (the Discord extraction) must delete both the imports
 * and these entries. A third occurrence or an occurrence in another file still fails.
 */
export const LEGACY_DEPENDENCY_BASELINE: readonly LegacyDependencyBaselineEntry[] = [
  {
    sourceFile: "packages/kernel/src/discord.ts",
    specifier: "@odinn/channel-discord",
    kind: "import-declaration",
    rule: DEPENDENCY_RULES.kernelChannels,
    expectedOccurrences: 1,
    removal: "Remove with the kernel Discord extraction in architecture cleanup PR 2.",
  },
  {
    sourceFile: "packages/kernel/src/discord.ts",
    specifier: "@odinn/channel-discord",
    kind: "dynamic-import",
    rule: DEPENDENCY_RULES.kernelChannels,
    expectedOccurrences: 1,
    removal: "Remove with the kernel Discord extraction in architecture cleanup PR 2.",
  },
];

function repositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
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

async function workspacePackageNames(
  repositoryRoot: string,
  topLevelDirectory: "adapters" | "apps",
): Promise<string[]> {
  const manifests = await packageManifestFiles(resolve(repositoryRoot, topLevelDirectory));
  const names = await Promise.all(manifests.map(async (manifestPath) => {
    const manifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest || typeof manifest !== "object") return undefined;
    const name = (manifest as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
  }));
  return names.filter((name): name is string => name !== undefined).sort();
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

function targetsRepositoryDirectory(
  repositoryRoot: string,
  sourceFile: string,
  specifier: string,
  topLevelDirectory: "adapters" | "apps",
  workspacePackageNames: readonly string[],
): boolean {
  const normalizedSpecifier = specifier.replaceAll("\\", "/").split(/[?#]/u, 1)[0] ?? "";
  if (workspacePackageNames.some((packageName) =>
    normalizedSpecifier === packageName || normalizedSpecifier.startsWith(`${packageName}/`))) {
    return true;
  }
  let targetPath: string;
  if (normalizedSpecifier.startsWith(".")) {
    const absoluteSource = resolve(repositoryRoot, sourceFile);
    targetPath = repositoryPath(
      repositoryRoot,
      resolve(dirname(absoluteSource), normalizedSpecifier),
    );
  } else {
    targetPath = normalizedSpecifier.replace(/^\/+/, "");
  }
  return targetPath === topLevelDirectory || targetPath.startsWith(`${topLevelDirectory}/`);
}

function violatedRule(
  repositoryRoot: string,
  reference: ImportReference,
  targets: RepositoryDependencyTargets,
): DependencyRule | undefined {
  const inKernel = reference.sourceFile.startsWith("packages/kernel/");
  const inApplication = reference.sourceFile.startsWith("packages/application/");
  const nonLiteralDynamicImport = reference.specifier === nonLiteralSpecifier;
  const importsChannel = reference.specifier.startsWith("@odinn/channel-");
  const importsAdapter = targetsRepositoryDirectory(
    repositoryRoot,
    reference.sourceFile,
    reference.specifier,
    "adapters",
    targets.adapters,
  );

  if (inKernel && nonLiteralDynamicImport) return DEPENDENCY_RULES.kernelDynamicImports;
  if (inApplication && nonLiteralDynamicImport) {
    return DEPENDENCY_RULES.applicationDynamicImports;
  }
  if (inKernel && importsChannel) return DEPENDENCY_RULES.kernelChannels;
  if (inKernel && importsAdapter) return DEPENDENCY_RULES.kernelAdapters;
  if (inApplication && importsChannel) return DEPENDENCY_RULES.applicationChannels;
  if (inApplication && importsAdapter) return DEPENDENCY_RULES.applicationAdapters;
  if (inApplication && targetsRepositoryDirectory(
    repositoryRoot,
    reference.sourceFile,
    reference.specifier,
    "apps",
    targets.apps,
  )) return DEPENDENCY_RULES.applicationApps;
  return undefined;
}

function baselineKey(entry: Pick<LegacyDependencyBaselineEntry, "sourceFile" | "specifier" | "kind" | "rule">): string {
  return JSON.stringify([entry.sourceFile, entry.specifier, entry.kind, entry.rule]);
}

export async function checkDependencyDirection(
  repositoryRoot: string,
  baseline: readonly LegacyDependencyBaselineEntry[] = LEGACY_DEPENDENCY_BASELINE,
): Promise<DependencyDirectionResult> {
  const roots = ["packages/kernel", "packages/application"];
  const [filesByRoot, adapterPackages, appPackages] = await Promise.all([
    Promise.all(roots.map((directory) => sourceFiles(resolve(repositoryRoot, directory)))),
    workspacePackageNames(repositoryRoot, "adapters"),
    workspacePackageNames(repositoryRoot, "apps"),
  ]);
  const files = filesByRoot.flat();
  const targets: RepositoryDependencyTargets = {
    adapters: adapterPackages,
    apps: appPackages,
  };
  const references = (await Promise.all(files.map(async (absolutePath) => extractImportReferences(
    repositoryRoot,
    absolutePath,
    await readFile(absolutePath, "utf8"),
  )))).flat();
  const candidates = references.flatMap((reference): DependencyViolation[] => {
    const rule = violatedRule(repositoryRoot, reference, targets);
    return rule ? [{ ...reference, rule }] : [];
  }).sort((left, right) => left.sourceFile.localeCompare(right.sourceFile)
    || left.line - right.line
    || left.column - right.column
    || left.specifier.localeCompare(right.specifier));

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
    scannedFileCount: files.length,
    violations: candidates.filter((candidate) => !accepted.has(candidate)),
    baselineErrors,
    acceptedLegacyOccurrences: accepted.size,
  };
}

export function formatDependencyViolation(violation: DependencyViolation): string {
  return `${violation.sourceFile}:${violation.line}:${violation.column}: forbidden import ${JSON.stringify(violation.specifier)} [rule: ${violation.rule}]`;
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
    `dependency direction check passed (${result.scannedFileCount} source files, ${result.acceptedLegacyOccurrences} temporary legacy occurrences)`,
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) await main();

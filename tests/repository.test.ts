import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const read = (path: any) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("package metadata names Odinn Forge and pins the toolchain", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.name, "odinn");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.bin.odinn, "./apps/cli/src/cli.ts");
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(pkg.engines.node, ">=24.0.0");
  const changelog = await read("CHANGELOG.md");
  assert.ok(changelog.includes(`## [${pkg.version}](`), "changelog must describe the package version");
});

test("local package operations have conservative resource limits", async () => {
  const npmrc = await read(".npmrc");
  assert.match(npmrc, /^child-concurrency=1$/m);
  assert.match(npmrc, /^workspace-concurrency=1$/m);
  assert.match(npmrc, /^node-options=--max-old-space-size=1536$/m);

  const runner = await read("scripts/ci/run.ts");
  assert.match(runner, /ODINN_WORKSPACE_CONCURRENCY/);
  assert.match(runner, /ODINN_NODE_MAX_OLD_SPACE_MB/);
  assert.match(runner, /--workspace-concurrency=\$\{workspaceConcurrency\}/);
});

test("required CI/CD workflows exist", async () => {
  for (const workflow of ["ci.yml", "security.yml", "release.yml", "nightly.yml"]) {
    const content = await read(`.github/workflows/${workflow}`);
    assert.match(content, /^name:/m);
    assert.match(content, /^permissions:/m);
  }
});

test("operator-created tags hand releases to the protected workflow", async () => {
  const release = await read(".github/workflows/release.yml");
  const preflight = await read("scripts/release/preflight.ts");

  assert.match(release, /^\s{2}push:\s*\n\s{4}tags:\s*\n\s{6}- "v\*"/m);
  assert.match(release, /^\s{2}workflow_dispatch:/m);
  assert.doesNotMatch(release, /^\s{2}workflow_call:/m);
  assert.match(release, /\*-\*\) prerelease=\(--prerelease\)/);
  assert.match(preflight, /releaseTag !== expected/);
  assert.match(preflight, /tagCommit\.stdout\.trim\(\) !== headCommit\.stdout\.trim\(\)/);
});

test("dispatched release pull requests receive dependency and title checks", async () => {
  const security = await read(".github/workflows/security.yml");
  const title = await read(".github/workflows/pr-title.yml");
  assert.match(security, /inputs\.base_sha != '' && inputs\.head_sha != ''/);
  assert.match(security, /github\.event\.pull_request\.base\.sha \|\| inputs\.base_sha/);
  assert.match(
    security,
    /github\.event_name != 'workflow_dispatch' \|\| github\.ref_name == github\.event\.repository\.default_branch/,
  );
  assert.match(title, /github\.event\.pull_request\.title \|\| inputs\.pr_title/);
});

test("security coverage completes before Scorecard evaluates it", async () => {
  const security = await read(".github/workflows/security.yml");
  assert.match(
    security,
    /^  group: security-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'pull_request' && github\.ref \|\| github\.run_id \}\}$/m,
  );
  assert.match(
    security,
    /^  cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m,
  );
  const scorecardStart = security.indexOf("\n  scorecard:\n");
  assert.notEqual(scorecardStart, -1, "security workflow must define the Scorecard job");
  const scorecardHeader = "  scorecard:\n";
  const scorecardTail = security.slice(scorecardStart + 1);
  const nextJobOffset = scorecardTail.slice(scorecardHeader.length).search(/^  [A-Za-z0-9_-]+:\n/m);
  const scorecard = nextJobOffset === -1
    ? scorecardTail
    : scorecardTail.slice(0, scorecardHeader.length + nextJobOffset);
  assert.match(scorecard, /^    needs: codeql$/m);
  assert.match(
    scorecard,
    /^    if: \$\{\{ !cancelled\(\) && github\.event\.repository\.private == false && github\.event_name != 'pull_request' && \(github\.event_name != 'workflow_dispatch' \|\| github\.ref_name == github\.event\.repository\.default_branch\) \}\}$/m,
  );
});

test("security scanning is license-independent and optional maintenance is explicitly enabled", async () => {
  const security = await read(".github/workflows/security.yml");
  assert.match(
    security,
    /codeql:[\s\S]*?permissions:\s*\n\s+actions: read\s*\n\s+contents: read/u,
  );
  assert.match(security, /output: \$\{\{ runner\.temp \}\}\/codeql-results/u);
  assert.match(security, /upload: false/u);
  assert.match(security, /name: codeql-results-\$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(security, /security-events: write/u);
  assert.doesNotMatch(security, /github\/codeql-action\/upload-sarif/u);
  assert.doesNotMatch(security, /gitleaks\/gitleaks-action/u);
  assert.match(
    security,
    /ghcr\.io\/gitleaks\/gitleaks@sha256:[a-f0-9]{64}/u,
  );
  assert.match(security, /detect --source \. --redact --no-banner --verbose/u);

  const maintainer = await read(".github/workflows/odinn-maintainer.yml");
  assert.match(
    maintainer,
    /needs\.discover\.outputs\.count != '0' && vars\.ODINN_MAINTAINER_ENABLED == 'true'/u,
  );
  assert.match(
    maintainer,
    /vars\.ODINN_MAINTAINER_ENABLED == 'true' && needs\.plan\.result == 'success'/u,
  );
});

test("user documentation and reporting surfaces ship in the release tree", async () => {
  for (const path of [
    "docs/user-guide.md",
    "docs/release-validation.md",
    "docs/v1-compatibility.md",
    "docs/provider-support.md",
    "docs/surface-matrix.md",
    ".github/ISSUE_TEMPLATE/bug-report.yml",
    ".github/ISSUE_TEMPLATE/feature-request.yml",
    ".github/ISSUE_TEMPLATE/config.yml"
  ]) {
    assert.ok((await read(path)).trim().length > 0, `${path} must not be empty`);
  }
  const userGuide = await read("docs/user-guide.md");
  assert.doesNotMatch(userGuide, /v\d+\.\d+\.\d+-beta\.\d+/);
  assert.match(userGuide, /registration and discovery do not execute or activate/u);
  assert.doesNotMatch(userGuide, /attachments sent to their configured API/u);
  const releaseValidation = await read("docs/release-validation.md");
  assert.match(releaseValidation, /clean Linux, macOS, and Windows environment/u);
  assert.match(releaseValidation, /archive checksums,[\s\S]*SBOM,[\s\S]*provenance/u);
  const matrix = await read("docs/surface-matrix.md");
  for (const label of [
    "Stable v1 interface",
    "Internal implementation detail",
    "Experimental interface",
    "Provider-dependent behavior",
    "Platform-dependent behavior",
    "Unsupported behavior"
  ]) assert.match(matrix, new RegExp(label, "i"));
  const compatibility = await read("docs/v1-compatibility.md");
  for (const subject of [
    "CLI commands and exit codes",
    "Configuration fields",
    "Persistent state schemas",
    "Gateway routes",
    "Audit event formats",
    "Provider adapter contracts",
    "Extension manifests and packages",
    "Advanced services and experimental modules"
  ]) assert.match(compatibility, new RegExp(subject, "i"));
  assert.match(matrix, /forked workers are crash containment, not a security sandbox/i);
  assert.match(matrix, /remote hosting is application-level tenant isolation, not hostile-user OS isolation/i);
  assert.match(matrix, /external effects and nondeterministic provider behavior are outside full replay\/rollback guarantees/i);
});

test("release packaging removes stale assets before creating a version", async () => {
  const packaging = await read("scripts/release/package.ts");
  assert.match(packaging, /rm\(output, \{ recursive: true, force: true \}\)/);
  assert.ok(packaging.indexOf("rm(output") < packaging.indexOf("mkdir(output"));
  assert.doesNotMatch(packaging, /git archive/);
  assert.match(packaging, /distribution: "compiled"/);
  assert.match(packaging, /for \(const directory of \["cli", "gateway", "workers", "install"\]/);
  assert.match(packaging, /join\(packageRoot, "node_modules", "playwright-core"\)/);

  const build = await read("scripts/build-production.ts");
  for (const entrypoint of [
    "apps/cli/src/cli.ts",
    "apps/gateway/src/server.ts",
    "packages/kernel/src/task-worker.ts",
    "packages/kernel/src/browser-worker.ts"
  ]) assert.match(build, new RegExp(entrypoint.replaceAll("/", "\\/")));
  assert.match(build, /sourcemap: "external"/);

  const installSmoke = await read("scripts/release/install-smoke.ts");
  assert.doesNotMatch(installSmoke, /pnpm|corepack|apps\/cli\/src\/cli\.ts/);
  assert.match(installSmoke, /odinn-gateway/);
  assert.match(installSmoke, /"--version"/);
  assert.match(installSmoke, /\/diagnostics/);
});

test("third-party workflow actions are pinned to immutable commit SHAs", async () => {
  const workflowRoot = new URL("../.github/workflows/", import.meta.url);
  for (const file of await readdir(workflowRoot)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const content = await readFile(new URL(file, workflowRoot), "utf8");
    for (const match of content.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?/gm)) {
      const reference = match[1];
      if (reference.startsWith("./")) continue;
      if (reference.startsWith("docker://")) assert.match(reference, /@sha256:[a-f0-9]{64}$/, `${file} contains a movable container reference: ${reference}`);
      else assert.match(reference, /@[a-f0-9]{40}$/, `${file} contains a movable action reference: ${reference}`);
      assert.ok(match[2], `${file} must retain a readable version comment for ${reference}`);
    }
  }
});

test("workflow Node entrypoints exist after source migrations", async () => {
  const workflowRoot = new URL("../.github/workflows/", import.meta.url);
  for (const file of await readdir(workflowRoot)) {
    if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
    const content = await readFile(new URL(file, workflowRoot), "utf8");
    for (const match of content.matchAll(/\bnode\s+(scripts\/[A-Za-z0-9_./-]+\.[cm]?[jt]s)\b/g)) {
      await assert.doesNotReject(
        readFile(new URL(`../${match[1]}`, import.meta.url)),
        `${file} references missing Node entrypoint ${match[1]}`
      );
    }
  }
});

test("obsolete technical identifiers are absent from canonical metadata", async () => {
  for (const file of ["package.json", "pnpm-workspace.yaml", "README.md"]) {
    const content = await read(file);
    assert.doesNotMatch(content, /@othin\//i);
    assert.doesNotMatch(content, /OTHIN_[A-Z0-9_]+/);
    assert.doesNotMatch(content, /\.othin(?:[/\\]|$)/i);
  }
});

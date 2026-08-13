import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertReleaseCommit, expectedReleaseCommit } from "../scripts/release/commit.ts";

const read = (path: any) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

async function sourceFilesUnder(path: string): Promise<string[]> {
  const entries = await readdir(new URL(`../${path}/`, import.meta.url), { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = `${path}/${entry.name}`;
    return entry.isDirectory() ? sourceFilesUnder(child) : [child];
  }));
  return nested.flat().filter((file) => file.endsWith(".ts"));
}

test("package metadata names Odinn Forge and pins the toolchain", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.name, "odinn");
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(pkg.bin.odinn, "./apps/cli/src/cli.ts");
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.equal(pkg.engines.node, ">=24.0.0");
  const changelog = await read("CHANGELOG.md");
  assert.ok(
    changelog.includes(`## [${pkg.version}](`) || changelog.includes(pkg.version),
    "changelog must describe the package version",
  );
});

test("routine dependency groups exclude runtime and Node typing migrations", async () => {
  const dependabot = await read(".github/dependabot.yml");
  assert.match(dependabot, /npm-minor-and-patch:[\s\S]*exclude-patterns: \["@types\/node", "playwright-core"\]/u);
  assert.match(
    dependabot,
    /github-actions:[\s\S]*exclude-patterns:[\s\S]*BlueDot-IT\/odinn-maintainer\/\.github\/workflows\/codex-security-remediation\.yml/u
  );
  assert.match(dependabot, /dependency-name: "@types\/node"[\s\S]*version-update:semver-major/u);
  assert.match(dependabot, /dependency-name: typescript[\s\S]*version-update:semver-major/u);
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

test("comparative benchmarking remains outside the product repository", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.deepEqual(
    Object.keys(pkg.scripts).filter((name) => name.startsWith("benchmark:")),
    [],
  );

  const ciScripts = await readdir(new URL("../scripts/ci/", import.meta.url));
  assert.deepEqual(
    ciScripts.filter((name) => name.includes("benchmark")),
    [],
  );

  const removedBenchmarkControls =
    /benchmark:|dist\/benchmark|benchmark-report|ODINN_(?:ASSURANCE_|WORKSPACE_|AUDIT_)?BENCHMARK|BENCHMARK_(?:SIZES|SAMPLES|CHUNK_SIZE)/u;
  for (const workflow of ["ci.yml", "merge-queue.yml", "nightly.yml", "release.yml"]) {
    const content = await read(`.github/workflows/${workflow}`);
    assert.doesNotMatch(content, removedBenchmarkControls);
    assert.match(content, /pnpm test:invariants/u);
  }
  const forgejo = await read(".forgejo/workflows/ci.yml");
  assert.doesNotMatch(forgejo, removedBenchmarkControls);
  assert.match(forgejo, /pnpm test:invariants/u);
  assert.match(await read(".github/workflows/merge-queue.yml"), /pnpm smoke:inference:compiled/u);
  assert.match(await read(".github/workflows/nightly.yml"), /pnpm smoke:inference:compiled/u);
  assert.match(forgejo, /pnpm smoke:inference:compiled/u);

  const documentation = await read("docs/README.md");
  assert.match(documentation, /BlueDot-IT\/agent-benchmarks/u);
  assert.doesNotMatch(documentation, /\(benchmarks\.md\)/u);
});

test("required CI/CD workflows exist", async () => {
  for (const workflow of ["ci.yml", "security.yml", "release.yml", "nightly.yml"]) {
    const content = await read(`.github/workflows/${workflow}`);
    assert.match(content, /^name:/m);
    assert.match(content, /^permissions:/m);
  }
});

test("CI enforces the complete production workspace dependency graph", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.scripts["check:architecture"], "node scripts/ci/check-dependency-direction.ts");
  assert.match(pkg.scripts.check, /pnpm check:architecture/u);
  assert.match(await read(".github/workflows/ci.yml"), /pnpm check:architecture/u);
  assert.match(await read(".forgejo/workflows/ci.yml"), /pnpm check:architecture/u);
  assert.match(
    await read("docs/architecture/package-dependency-graph.md"),
    /package-by-package allowlist/u,
  );
});

test("kernel manifests and sources remain free of channel adapters", async () => {
  const kernel = JSON.parse(await read("packages/kernel/package.json"));
  const application = JSON.parse(await read("packages/application/package.json"));
  const runtime = JSON.parse(await read("packages/runtime/package.json"));
  const dependencyNames = Object.keys({
    ...kernel.dependencies,
    ...kernel.devDependencies,
    ...kernel.optionalDependencies,
    ...kernel.peerDependencies,
  });

  assert.deepEqual(dependencyNames.filter((name) => name.startsWith("@odinn/channel-")), []);
  assert.deepEqual(
    Object.keys({
      ...application.dependencies,
      ...application.devDependencies,
      ...application.optionalDependencies,
      ...application.peerDependencies,
    }).filter((name) => name.startsWith("@odinn/channel-")),
    []
  );
  assert.equal(kernel.dependencies["@odinn/channels"], "workspace:*");
  assert.equal(runtime.dependencies["@odinn/channel-discord"], "workspace:*");

  for (const file of await sourceFilesUnder("packages/kernel/src")) {
    assert.doesNotMatch(await read(file), /discord/iu, `${file} must remain transport-neutral`);
  }
});

test("draft GitHub releases hand npm publication to the protected workflow", async () => {
  const release = await read(".github/workflows/release.yml");
  const preflight = await read("scripts/release/preflight.ts");

  assert.doesNotMatch(release, /^\s{2}release:/m);
  assert.match(release, /^\s{2}workflow_dispatch:/m);
  assert.match(release, /RELEASE_TAG: \$\{\{ inputs\.tag \}\}/);
  assert.match(release, /^  release-policy:\s*[\s\S]*?^    permissions:\s*\n\s{6}contents: read/m);
  assert.match(release, /\.tag_name == \$tag and \.draft == true and \.prerelease == \$expectedPrerelease/);
  assert.match(release, /persist-credentials: false/);
  assert.doesNotMatch(release.match(/^  release-policy:[\s\S]*?(?=^  [a-z])/m)?.[0] ?? "", /^\s+needs:/m);
  assert.match(release, /^  verify:\s*[\s\S]*?^    needs: release-policy/m);
  assert.match(
    release,
    /^  source-package:\s*[\s\S]*?^    needs:\s*\n\s{6}- release-policy\s*\n\s{6}- verify/m
  );
  assert.match(
    release,
    /^  stage-release-assets:\s*[\s\S]*?^    needs:\s*\n\s{6}- release-policy\s*\n\s{6}- source-package/m
  );
  assert.match(
    release,
    /^  validate-downloaded-release:\s*[\s\S]*?^    needs:\s*\n\s{6}- release-policy\s*\n\s{6}- stage-release-assets/m
  );
  assert.match(release, /matrix:\s*\n\s+os:\s*\n\s+- ubuntu-latest\s*\n\s+- macos-latest\s*\n\s+- windows-latest/u);
  assert.match(release, /node scripts\/release\/install-smoke\.ts downloaded-release-assets/u);
  assert.doesNotMatch(release.match(/^  source-package:[\s\S]*?(?=^  [a-z])/m)?.[0] ?? "", /id-token: write/);
  assert.match(
    release,
    /^  publish-release:\s*[\s\S]*?^    needs:\s*\n\s{6}- release-policy\s*\n\s{6}- source-package\s*\n[\s\S]*?^    environment: release\s*\n[\s\S]*?^      id-token: write/m
  );
  assert.match(release, /mapfile -t package_manifests < <\(find dist\/npm-package -type f -name package\.json -print\)/);
  assert.match(release, /test "\$\{#package_manifests\[@\]\}" -eq 1/);
  assert.match(release, /npm publish "\$package_dir" --tag next --access public --provenance/);
  assert.match(release, /proving the registry tarball matches the candidate/);
  assert.match(release, /curl --fail --location --silent --show-error "\$registry_tarball"/);
  assert.match(release, /cmp "\$\{candidate_tarballs\[0\]\}" "\$compare_dir\/registry\.tgz"/);
  assert.match(release, /gh release upload "\$TAG" release-assets\/\*/);
  assert.match(release, /expected_assets=/);
  assert.match(release, /existing_assets=/);
  assert.match(release, /diff -u <\(printf '%s\\n' "\$expected_assets"\)/);
  assert.match(release, /cmp release-assets\/SHA256SUMS\.txt downloaded-release-assets\/SHA256SUMS\.txt/);
  assert.doesNotMatch(release, /--clobber/);
  assert.match(release, /release_commit: \$\{\{ steps\.release\.outputs\.commit \}\}/);
  assert.match(release, /ref: \$\{\{ needs\.release-policy\.outputs\.release_commit \}\}/);
  const publishJob = release.match(/^  publish-release:[\s\S]*$/m)?.[0] ?? "";
  assert.ok(
    publishJob.indexOf("Revalidate draft release and exact tag commit") < publishJob.indexOf("npm publish"),
    "exact tag/release revalidation must precede npm publication"
  );
  assert.match(publishJob, /test "\$\(git rev-list -n 1 "refs\/tags\/\$TAG"\)" = "\$EXPECTED_COMMIT"/);
  assert.doesNotMatch(release, /^\s{2}workflow_call:/m);
  assert.match(preflight, /releaseTag !== expected/);
  assert.match(preflight, /tagCommit\.stdout\.trim\(\) !== headCommit\.stdout\.trim\(\)/);
});

test("repository setup fails closed and verifies the effective release reviewer policy", async () => {
  const configure = await read("scripts/repository/configure-github.ts");

  assert.match(configure, /main branch protection verification failed/);
  assert.match(configure, /default branch ruleset verification failed/);
  assert.match(configure, /enforcement: "active"/);
  assert.match(configure, /reviewers: \[\{ type: "User", id: ownerUserId \}\]/);
  assert.match(configure, /const releaseEnvironment = JSON\.parse\(gh\("\/environments\/release"\)\)/);
  assert.match(configure, /rule\?\.type === "required_reviewers"/);
  assert.match(configure, /Number\(entry\?\.reviewer\?\.id\) === ownerUserId/);
  assert.match(configure, /\{ name: "main", type: "branch" \}/);
  assert.match(configure, /\{ name: "v\*", type: "tag" \}/);
  assert.match(configure, /release environment policy verification failed/);
  assert.doesNotMatch(configure, /Release environment reviewer policy could not be applied/);
  assert.doesNotMatch(configure, /ALLOW_UNSAFE|REVIEWERLESS|without reviewers/i);
});

test("repository setup executes fail-closed release environment verification", async () => {
  const bin = await mkdtemp(join(tmpdir(), "odinn-fake-gh-"));
  const fakeGh = join(bin, "gh.js");
  await writeFile(fakeGh, `const args = process.argv.slice(2);
const endpoint = args[1] || "";
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
if (endpoint.endsWith("/environments/release") && method === "PUT" && process.env.FAKE_RELEASE_PUT_FAIL === "1") {
  process.stderr.write("reviewer policy rejected");
  process.exit(1);
}
if (endpoint.endsWith("/branches/main/protection") && method === "GET") {
  process.stdout.write(process.env.FAKE_BRANCH_PROTECTION || "{}");
} else if (endpoint.endsWith("/rulesets") && method === "GET") {
  process.stdout.write('[{"id":19858700,"name":"default","target":"branch"}]');
} else if (endpoint.endsWith("/rulesets/19858700") && method === "GET") {
  process.stdout.write(process.env.FAKE_RULESET || "{}");
} else if (endpoint.endsWith("/environments/release/deployment-branch-policies") && method === "GET") {
  process.stdout.write(process.env.FAKE_DEPLOYMENT_POLICIES || "{}");
} else if (endpoint.endsWith("/environments/release") && method === "GET") {
  process.stdout.write(process.env.FAKE_RELEASE_ENVIRONMENT || "{}");
} else {
  process.stdout.write("{}");
  }
`);
  const gh = join(bin, "gh");
  await writeFile(gh, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeGh)});\n`, { mode: 0o755 });
  await chmod(gh, 0o755);
  await writeFile(join(bin, "gh.cmd"), `@node "${fakeGh}" %*\r\n`);
  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const effective = (overrides: Record<string, unknown> = {}) => ({
    protection_rules: [{
      type: "required_reviewers",
      reviewers: [{ type: "User", reviewer: { id: 8_335_428 } }]
    }],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true
    },
    ...overrides
  });
  const branchProtection = {
    required_status_checks: {
      strict: true,
      contexts: [
        "Quality and unit tests",
        "Platform test (ubuntu-latest)",
        "Platform test (macos-latest)",
        "Platform test (windows-latest)",
        "Integration and inference protocol",
        "Package smoke (ubuntu-latest)",
        "Package smoke (macos-latest)",
        "Package smoke (windows-latest)",
        "Verify package (ubuntu-latest)",
        "Verify package (macos-latest)",
        "Verify package (windows-latest)",
        "CodeQL",
        "Dependency review",
        "Dependency and lockfile audit",
        "Secret scan",
        "actionlint",
        "Conventional title"
      ]
    },
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true
    },
    required_linear_history: { enabled: true },
    required_conversation_resolution: { enabled: true },
    enforce_admins: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };
  const ruleset = {
    id: 19_858_700,
    name: "default",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "required_linear_history" }
    ]
  };
  const run = (
    environment: Record<string, unknown>,
    extraEnv: Record<string, string> = {}
  ) => spawnSync(
    process.execPath,
    ["scripts/repository/configure-github.ts", "BlueDot-IT/Odinn-Forge", "8335428"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
        FAKE_BRANCH_PROTECTION: JSON.stringify(branchProtection),
        FAKE_RULESET: JSON.stringify(ruleset),
        FAKE_RELEASE_ENVIRONMENT: JSON.stringify(environment),
        FAKE_DEPLOYMENT_POLICIES: JSON.stringify({
          branch_policies: [
            { id: 1, name: "main", type: "branch" },
            { id: 2, name: "v*", type: "tag" }
          ]
        }),
        ...extraEnv
      }
    }
  );

  assert.notEqual(run(effective(), { FAKE_RELEASE_PUT_FAIL: "1" }).status, 0);
  assert.notEqual(run(effective(), { FAKE_BRANCH_PROTECTION: "{}" }).status, 0);
  assert.notEqual(run(effective(), {
    FAKE_BRANCH_PROTECTION: JSON.stringify({
      ...branchProtection,
      allow_force_pushes: undefined
    })
  }).status, 0);
  assert.notEqual(run(effective(), {
    FAKE_BRANCH_PROTECTION: JSON.stringify({
      ...branchProtection,
      enforce_admins: { enabled: false }
    })
  }).status, 0);
  assert.notEqual(run(effective(), {
    FAKE_RULESET: JSON.stringify({ ...ruleset, enforcement: "disabled" })
  }).status, 0);
  assert.notEqual(run(effective(), {
    FAKE_RULESET: JSON.stringify({
      ...ruleset,
      bypass_actors: [{ actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "always" }]
    })
  }).status, 0);
  assert.notEqual(run(effective({ protection_rules: [] })).status, 0);
  assert.notEqual(run(effective({
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
  })).status, 0);
  assert.notEqual(run(effective(), {
    FAKE_DEPLOYMENT_POLICIES: JSON.stringify({
      branch_policies: [{ id: 1, name: "main", type: "branch" }]
    })
  }).status, 0);
  const succeeded = run(effective());
  assert.equal(succeeded.status, 0, succeeded.stderr || succeeded.stdout);
  assert.match(succeeded.stdout, /Repository policy configured/);
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
  const scorecardMatch = /\r?\n  scorecard:\r?\n/u.exec(security);
  const scorecardStart = scorecardMatch?.index ?? -1;
  assert.notEqual(scorecardStart, -1, "security workflow must define the Scorecard job");
  const scorecardHeader = scorecardMatch?.[0].slice(1) ?? "";
  const scorecardTail = security.slice(scorecardStart + (scorecardMatch?.[0].startsWith("\r\n") ? 2 : 1));
  const nextJobOffset = scorecardTail.slice(scorecardHeader.length).search(/^  [A-Za-z0-9_-]+:\r?$/m);
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
  assert.match(security, /upload: \$\{\{ github\.event_name != 'pull_request' \}\}/u);
  assert.match(security, /name: codeql-results-\$\{\{ github\.sha \}\}/u);
  assert.match(security, /security-events: write/u);
  assert.doesNotMatch(security, /github\/codeql-action\/upload-sarif/u);
  assert.doesNotMatch(security, /gitleaks\/gitleaks-action/u);
  assert.match(
    security,
    /ghcr\.io\/gitleaks\/gitleaks@sha256:[a-f0-9]{64}/u,
  );
  assert.match(security, /detect --source \. --redact --no-banner --verbose/u);

  const maintainer = await read(".github/workflows/odinn-maintainer.yml");
  const maintainerTarget = await read(".github/workflows/odinn-maintainer-target.yml");
  assert.match(
    maintainer,
    /needs\.discover\.outputs\.count != '0' && vars\.ODINN_MAINTAINER_ENABLED == 'true'/u,
  );
  assert.match(
    maintainerTarget,
    /if: needs\.plan\.result == 'success'/u,
  );
  assert.doesNotMatch(maintainerTarget, /continue-on-error:\s*true/u);
});

test("maintainer reconciliation serializes the exact target across every triggering run", async () => {
  const dispatcher = await read(".github/workflows/odinn-maintainer.yml");
  const target = await read(".github/workflows/odinn-maintainer-target.yml");
  const ciDocs = await read("docs/ci-cd.md");

  assert.doesNotMatch(dispatcher, /^concurrency:/m);
  assert.match(dispatcher, /uses: \.\/\.github\/workflows\/odinn-maintainer-target\.yml/u);
  assert.match(dispatcher, /target_kind: \$\{\{ matrix\.target\.kind \}\}/u);
  assert.match(dispatcher, /target_number: \$\{\{ matrix\.target\.number \}\}/u);
  assert.match(dispatcher, /max-parallel: 5/u);

  assert.match(target, /^\s{2}workflow_call:$/m);
  assert.match(
    target,
    /group: odinn-maintainer-\$\{\{ github\.repository \}\}-\$\{\{ inputs\.target_kind \}\}-\$\{\{ inputs\.target_number \}\}/u,
  );
  assert.match(target, /cancel-in-progress: false/u);
  assert.doesNotMatch(target, /group:[^\n]*(?:github\.run_id|github\.event)/u);
  assert.match(target, /^  plan:$/m);
  assert.match(
    target,
    /plan:[\s\S]*?concurrency:\s*\n\s+group: odinn-maintainer-oauth-\$\{\{ github\.repository \}\}/u,
  );
  assert.match(target, /^  apply:\n    name:[\s\S]*?    needs: plan$/m);
  assert.match(ciDocs, /bursts coalesce to the newest pending\s+event/u);
  assert.match(ciDocs, /re-fetches the complete live target state/u);
});

test("daily Codex remediation is isolated, pinned, and draft-only", async () => {
  const dispatcher = await read(".github/workflows/odinn-maintainer.yml");
  const ciDocs = await read("docs/ci-cd.md");
  const remediationSha = "0c5f7b0dea200979ea96107b6856ed3dc5e7bcc0";

  assert.deepEqual(
    [...dispatcher.matchAll(/^\s+- cron: "([^"]+)"$/gmu)].map((match) => match[1]),
    ["17 */6 * * *", "41 5 * * *"],
  );
  assert.match(
    dispatcher,
    /discover:[\s\S]*?if: github\.event_name != 'schedule' \|\| github\.event\.schedule == '17 \*\/6 \* \* \*'/u,
  );
  assert.match(
    dispatcher,
    /remediate-security:[\s\S]*?if: github\.event_name == 'schedule' && github\.event\.schedule == '41 5 \* \* \*'/u,
  );
  assert.match(
    dispatcher,
    new RegExp(
      `uses: BlueDot-IT/odinn-maintainer/\\.github/workflows/codex-security-remediation\\.yml@${remediationSha}`,
      "u",
    ),
  );
  assert.match(
    dispatcher,
    /remediate-security:[\s\S]*?permissions:\s*\n\s+actions: write\s*\n\s+contents: write\s*\n\s+pull-requests: write/u,
  );
  assert.match(dispatcher, /target_ref: main/u);
  assert.match(dispatcher, /oauth_json: \$\{\{ secrets\.ODINN_OPENAI_OAUTH_JSON \}\}/u);
  assert.match(ciDocs, /creates only a\s+draft pull request and never merges it/u);
  assert.match(ciDocs, /scan and patch steps receive OAuth without a repository write credential/u);
});

test("maintainer actions pin exact reviewed commits", async () => {
  const dispatcher = await read(".github/workflows/odinn-maintainer.yml");
  const target = await read(".github/workflows/odinn-maintainer-target.yml");
  const releaseSha = "f9b37ebf6e225572790b454f37af13e0ea767568";
  const targetSha = "2473070555445ba62025f4684ecf35c91ec182b9";
  const stablePins = [...target.matchAll(/BlueDot-IT\/odinn-maintainer\/\.github\/actions\/[^@\s]+@([a-f0-9]{40}) # v0\.5\.0/gu)];

  assert.equal(stablePins.length, 2);
  assert.deepEqual(stablePins.map((match) => match[1]), [releaseSha, releaseSha]);
  assert.match(
    dispatcher,
    new RegExp(`uses: BlueDot-IT/odinn-maintainer/\\.github/actions/targets@${targetSha}`),
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
  assert.match(packaging, /assertReleaseCommit\(commit\)/);
  assert.match(packaging, /from "\.\/commit\.ts"/);
  assert.match(packaging, /rm\(output, \{ recursive: true, force: true \}\)/);
  assert.ok(packaging.indexOf("rm(output") < packaging.indexOf("mkdir(output"));
  assert.doesNotMatch(packaging, /git archive/);
  assert.match(packaging, /distribution: "compiled"/);
  assert.match(packaging, /for \(const directory of \["cli", "gateway", "workers", "install"\]/);
  assert.match(packaging, /join\(packageRoot, "node_modules", "playwright-core"\)/);
  assert.match(packaging, /DISTRIBUTION_PACKAGE_NAME = "@bluedot-it\/odinn"/);
  assert.match(packaging, /name: DISTRIBUTION_PACKAGE_NAME/);
  assert.match(packaging, /private: false/);
  const verification = await read("scripts/release/verify.ts");
  assert.match(verification, /archivedPackage\.name !== "@bluedot-it\/odinn"/);
  assert.match(verification, /entry\.isSymbolicLink\(\)/);
  assert.match(verification, /metadata\.nlink !== 1/);
  assert.match(packaging, /access: "public"/);
  assert.match(packaging, /odinn: "bin\/odinn\.js"/);
  assert.match(packaging, /#!\/usr\/bin\/env node/);

  const build = await read("scripts/build-production.ts");
  for (const entrypoint of [
    "apps/cli/src/cli.ts",
    "apps/gateway/src/server.ts",
    "packages/runtime/src/task-worker.ts",
    "packages/runtime/src/browser-worker.ts"
  ]) assert.match(build, new RegExp(entrypoint.replaceAll("/", "\\/")));
  assert.match(build, /createRequire as __odinnCreateRequire/);
  assert.match(build, /sourcemap: "external"/);

  const installSmoke = await read("scripts/release/install-smoke.ts");
  assert.doesNotMatch(installSmoke, /pnpm|corepack|apps\/cli\/src\/cli\.ts/);
  assert.match(installSmoke, /odinn-gateway/);
  assert.match(installSmoke, /"--version"/);
  assert.match(installSmoke, /\/diagnostics/);
});

test("release soak uses a valid provider credential name and direct Node execution", async () => {
  const soak = await read("scripts/release/soak.ts");
  assert.match(soak, /providerCredentialEnv = "ODINN_SOAK_API_KEY"/u);
  assert.doesNotMatch(soak, /ODINN_SOAK_KEY/u);
  assert.match(soak, /shell: false/u);
});

test("release packaging trusts the checked-out tag declaration over ambient GitHub SHA", () => {
  const tagCommit = "a".repeat(40);
  const ambientBranchCommit = "b".repeat(40);

  assert.equal(
    expectedReleaseCommit({ ODINN_RELEASE_COMMIT: tagCommit, GITHUB_SHA: ambientBranchCommit }),
    tagCommit,
  );
  assert.doesNotThrow(() => assertReleaseCommit(tagCommit, {
    ODINN_RELEASE_COMMIT: tagCommit,
    GITHUB_SHA: ambientBranchCommit,
  }));
  assert.throws(
    () => assertReleaseCommit(tagCommit, { GITHUB_SHA: ambientBranchCommit }),
    /release package commit mismatch/u,
  );
  assert.throws(
    () => expectedReleaseCommit({ ODINN_RELEASE_COMMIT: "not-a-sha" }),
    /full Git SHA/u,
  );
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

test("active repository links target the BlueDot organization", async () => {
  const canonicalRepository = "BlueDot-IT/Odinn-Forge";
  const retiredRepository = "jason-allen-oneal/Odinn";
  for (const file of [
    "README.md",
    "SECURITY.md",
    "docs/user-guide.md",
    "docs/repository-policy.md",
    ".github/ISSUE_TEMPLATE/config.yml",
    "apps/cli/src/lifecycle.ts",
    "scripts/repository/configure-github.ts",
  ]) {
    const content = await read(file);
    assert.match(content, new RegExp(canonicalRepository.replace("/", "\\/")));
    assert.doesNotMatch(content, new RegExp(retiredRepository.replace("/", "\\/")));
  }
});

import { spawnSync } from "node:child_process";

const repository = process.argv[2] ?? "BlueDot-IT/Odinn-Forge";
const ownerUserId = Number(process.argv[3] ?? "8335428");

function gh(endpoint: any, method: any = "GET", body: any = undefined) {
  const args = ["api", `repos/${repository}${endpoint}`, "--method", method];
  if (body !== undefined) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body === undefined ? undefined : JSON.stringify(body),
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`gh api ${endpoint} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

const requiredChecks = [
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
  "Conventional title",
  "Documentation impact"
];

function isEnabled(value: any) {
  return value === true || value?.enabled === true;
}

function isDisabled(value: any) {
  return value === false || value?.enabled === false;
}

console.log(`Configuring ${repository}`);

gh("/actions/permissions/workflow", "PUT", {
  default_workflow_permissions: "read",
  can_approve_pull_request_reviews: false
});

gh("/vulnerability-alerts", "PUT");
try {
  gh("/private-vulnerability-reporting", "PUT");
} catch (error: any) {
  console.warn(`Private vulnerability reporting could not be enabled: ${error.message}`);
}
try {
  gh("/automated-security-fixes", "PUT");
} catch (error: any) {
  console.warn(`Dependabot security updates could not be enabled: ${error.message}`);
}

gh("/branches/main/protection", "PUT", {
  required_status_checks: {
    strict: true,
    contexts: requiredChecks
  },
  enforce_admins: true,
  required_pull_request_reviews: {
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 1,
    require_last_push_approval: true
  },
  restrictions: null,
  required_linear_history: true,
  allow_force_pushes: false,
  allow_deletions: false,
  block_creations: false,
  required_conversation_resolution: true,
  lock_branch: false,
  allow_fork_syncing: true
});

const protection = JSON.parse(gh("/branches/main/protection"));
const effectiveChecks = Array.isArray(protection.required_status_checks?.contexts)
  ? protection.required_status_checks.contexts
  : [];
const missingChecks = requiredChecks.filter((check) => !effectiveChecks.includes(check));
if (
  protection.required_status_checks?.strict !== true
  || missingChecks.length > 0
  || protection.required_pull_request_reviews?.required_approving_review_count !== 1
  || protection.required_pull_request_reviews?.dismiss_stale_reviews !== true
  || protection.required_pull_request_reviews?.require_code_owner_reviews !== true
  || protection.required_pull_request_reviews?.require_last_push_approval !== true
  || !isEnabled(protection.required_linear_history)
  || !isEnabled(protection.required_conversation_resolution)
  || !isEnabled(protection.enforce_admins)
  || !isDisabled(protection.allow_force_pushes)
  || !isDisabled(protection.allow_deletions)
) {
  throw new Error(
    `main branch protection verification failed${missingChecks.length > 0
      ? `: missing required checks ${missingChecks.join(", ")}`
      : ""}`
  );
}

const rulesets = JSON.parse(gh("/rulesets"));
const defaultRuleset = Array.isArray(rulesets)
  ? rulesets.find((ruleset: any) => ruleset?.name === "default" && ruleset?.target === "branch")
  : undefined;
if (!defaultRuleset?.id) {
  throw new Error("default branch ruleset verification failed: the expected ruleset does not exist");
}
gh(`/rulesets/${defaultRuleset.id}`, "PUT", {
  name: "default",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: {
    ref_name: {
      include: ["~DEFAULT_BRANCH"],
      exclude: []
    }
  },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    { type: "required_linear_history" }
  ]
});

const effectiveRuleset = JSON.parse(gh(`/rulesets/${defaultRuleset.id}`));
const effectiveRuleTypes = new Set(
  Array.isArray(effectiveRuleset.rules)
    ? effectiveRuleset.rules.map((rule: any) => rule?.type)
    : []
);
if (
  effectiveRuleset.enforcement !== "active"
  || !Array.isArray(effectiveRuleset.bypass_actors)
  || effectiveRuleset.bypass_actors.length !== 0
  || !effectiveRuleset.conditions?.ref_name?.include?.includes("~DEFAULT_BRANCH")
  || !effectiveRuleTypes.has("deletion")
  || !effectiveRuleTypes.has("non_fast_forward")
  || !effectiveRuleTypes.has("required_linear_history")
) {
  throw new Error(
    "default branch ruleset verification failed: active deletion, non-fast-forward, and linear-history controls must be effective"
  );
}

gh("/environments/release", "PUT", {
  wait_timer: 0,
  reviewers: [{ type: "User", id: ownerUserId }],
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true
  }
});

const requiredDeploymentPolicies = [
  { name: "main", type: "branch" },
  { name: "v*", type: "tag" }
];
const existingDeploymentPolicies = JSON.parse(
  gh("/environments/release/deployment-branch-policies")
);
for (const expected of requiredDeploymentPolicies) {
  const exists = existingDeploymentPolicies.branch_policies?.some(
    (policy: any) => policy?.name === expected.name && policy?.type === expected.type
  );
  if (!exists) {
    gh("/environments/release/deployment-branch-policies", "POST", expected);
  }
}

const releaseEnvironment = JSON.parse(gh("/environments/release"));
const reviewerRule = Array.isArray(releaseEnvironment.protection_rules)
  ? releaseEnvironment.protection_rules.find((rule: any) => rule?.type === "required_reviewers")
  : undefined;
const effectiveReviewers = Array.isArray(reviewerRule?.reviewers) ? reviewerRule.reviewers : [];
const ownerIsRequired = effectiveReviewers.some(
  (entry: any) => entry?.type === "User" && Number(entry?.reviewer?.id) === ownerUserId
);
const branchPolicy = releaseEnvironment.deployment_branch_policy;
const deploymentPolicies = JSON.parse(
  gh("/environments/release/deployment-branch-policies")
);
const effectiveDeploymentPolicies = Array.isArray(deploymentPolicies.branch_policies)
  ? deploymentPolicies.branch_policies
  : [];
const hasExactDeploymentPolicies =
  effectiveDeploymentPolicies.length === requiredDeploymentPolicies.length
  && requiredDeploymentPolicies.every((expected) =>
    effectiveDeploymentPolicies.some(
      (policy: any) => policy?.name === expected.name && policy?.type === expected.type
    )
  );
if (
  !ownerIsRequired
  || branchPolicy?.protected_branches !== false
  || branchPolicy?.custom_branch_policies !== true
  || !hasExactDeploymentPolicies
) {
  throw new Error(
    "release environment policy verification failed: the required owner reviewer and exact main/v* deployment policies must be effective"
  );
}

console.log("Repository policy configured.");
console.log(`Required checks: ${requiredChecks.join(", ")}`);

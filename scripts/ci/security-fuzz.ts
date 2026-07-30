import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import fc from "fast-check";
import { validateSkillPackage } from "../../packages/kernel/src/index.ts";
import { createDefaultPolicy, evaluateTaskPolicy } from "../../packages/policy/src/index.ts";
import { normalizeAuditEvent, normalizeTaskRequest, ProtocolError } from "../../packages/protocol/src/index.ts";
import { redact } from "../../packages/store-sqlite/src/index.ts";

const MAX_RUNS = 100_000;
const MAX_SECONDS = 300;
const DEFAULT_RUNS = process.env.CI ? 20_000 : 4_000;
const DEFAULT_SECONDS = process.env.CI ? 240 : 60;
const artifactDirectory = join(process.cwd(), "artifacts", "fuzz");

function boundedInteger(name: string, fallback: number, maximum: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function optionalInteger(name: string) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
    throw new Error(`${name} must be a signed 32-bit integer`);
  }
  return value;
}

function skillManifest(overrides: Record<string, unknown> = {}) {
  return {
    sdkVersion: "0.1",
    id: "fuzz-skill",
    version: "1.0.0",
    name: "Fuzz Skill",
    description: "Exercises package validation at a generated trust boundary.",
    instructions: "Reject malformed identifiers without resolving paths outside managed storage.",
    requestedTools: [],
    requestedCapabilities: [],
    requestedSecrets: [],
    network: { default: "deny", allow: [] },
    tests: [],
    ...overrides
  };
}

const identifierCharacters = [..."abcdefghijklmnopqrstuvwxyz0123456789._-"];
const identifier = fc.array(fc.constantFrom(...identifierCharacters), {
  minLength: 1,
  maxLength: 48
}).map((characters) => characters.join(""));
const jsonRecord = fc.dictionary(fc.string({ maxLength: 32 }), fc.jsonValue(), { maxKeys: 20 });
const malformedTopLevel = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.string({ maxLength: 256 }),
  fc.array(fc.jsonValue(), { maxLength: 20 })
);
const traversalFragment = fc.constantFrom("../", "..\\", "/", "\\", "%2f..%2f", "%5c..%5c");
const traversalIdentifier = fc.tuple(identifier, traversalFragment, identifier)
  .map(([prefix, fragment, suffix]) => `${prefix}${fragment}${suffix}`);
const tokenCharacters = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"];
const opaqueToken = fc.array(fc.constantFrom(...tokenCharacters), {
  minLength: 20,
  maxLength: 96
}).map((characters) => characters.join(""));

const scenarios = [
  {
    name: "protocol-required-fields",
    property: fc.property(malformedTopLevel, (input) => {
      assert.throws(() => normalizeTaskRequest(input), ProtocolError);
      assert.throws(() => normalizeAuditEvent(input), ProtocolError);
    })
  },
  {
    name: "credential-redaction",
    property: fc.property(
      fc.constantFrom("apiKey", "access_token", "authorization", "cookie", "password", "privateKey"),
      opaqueToken,
      jsonRecord,
      (key, token, generated) => {
        const serialized = JSON.stringify(redact({
          generated,
          nested: { [key]: `synthetic-${token}` },
          assigned: `API_KEY=synthetic-${token}`
        }));
        assert.equal(serialized.includes(token), false);
        assert.match(serialized, /\[redacted\]/u);
      }
    )
  },
  {
    name: "policy-denial-monotonicity",
    property: fc.property(identifier, identifier, jsonRecord, (tool, capability, generatedInput) => {
      const decision = evaluateTaskPolicy({
        policy: createDefaultPolicy({
          deniedTools: [tool],
          allowedCapabilities: [capability],
          maxInputBytes: 1_000_000
        }),
        request: {
          tool,
          input: {
            ...generatedInput,
            deniedTools: [],
            allowedCapabilities: [capability]
          }
        },
        tool: { capability }
      });
      assert.equal(decision.allowed, false);
      if (decision.allowed) assert.fail("generated input broadened an explicit policy denial");
      assert.equal(decision.details.code, "TOOL_DENIED");
    })
  },
  {
    name: "skill-path-validation",
    property: fc.property(traversalIdentifier, (value) => {
      assert.throws(() => validateSkillPackage(skillManifest({ id: value })), /skill id must be/u);
    })
  }
] as const;

const requestedScenario = process.env.ODINN_FUZZ_SCENARIO?.trim();
const selectedScenarios = requestedScenario
  ? scenarios.filter(({ name }) => name === requestedScenario)
  : [...scenarios];
if (selectedScenarios.length === 0) {
  throw new Error(`unknown ODINN_FUZZ_SCENARIO: ${requestedScenario}`);
}

const totalRuns = boundedInteger("ODINN_FUZZ_RUNS", DEFAULT_RUNS, MAX_RUNS);
const maxSeconds = boundedInteger("ODINN_FUZZ_MAX_SECONDS", DEFAULT_SECONDS, MAX_SECONDS);
if (totalRuns < selectedScenarios.length) {
  throw new Error(`ODINN_FUZZ_RUNS must cover all ${selectedScenarios.length} selected scenarios`);
}
const configuredSeed = optionalInteger("ODINN_FUZZ_SEED");
const replayPath = process.env.ODINN_FUZZ_PATH?.trim() || undefined;
if (replayPath && configuredSeed === undefined) {
  throw new Error("ODINN_FUZZ_PATH requires ODINN_FUZZ_SEED");
}
if (replayPath && selectedScenarios.length !== 1) {
  throw new Error("ODINN_FUZZ_PATH requires one ODINN_FUZZ_SCENARIO");
}

await mkdir(artifactDirectory, { recursive: true });
const startedAt = new Date().toISOString();
const started = performance.now();
const deadline = started + maxSeconds * 1_000;
const results = [];
let failed = false;
for (const [index, scenario] of selectedScenarios.entries()) {
  const seed = configuredSeed === undefined
    ? ((Date.now() + index * 0x9e3779b1) | 0)
    : ((configuredSeed + index) | 0);
  // Each scenario has a different generated argument tuple. The runner only
  // consumes the common RunDetails contract, so erase that tuple at this
  // boundary instead of forcing the scenario definitions into one union.
  const property = scenario.property as fc.IProperty<unknown[]>;
  const scenarioRuns = Math.floor(totalRuns / selectedScenarios.length)
    + (index < totalRuns % selectedScenarios.length ? 1 : 0);
  const remainingScenarios = selectedScenarios.length - index;
  const remainingMilliseconds = Math.max(1, Math.floor(deadline - performance.now()));
  const details = fc.check(property, {
    seed,
    path: replayPath,
    numRuns: scenarioRuns,
    interruptAfterTimeLimit: Math.max(1, Math.floor(remainingMilliseconds / remainingScenarios)),
    endOnFailure: false,
    verbose: fc.VerbosityLevel.Verbose
  });
  const result = {
    scenario: scenario.name,
    failed: details.failed,
    interrupted: details.interrupted,
    seed: details.seed,
    path: details.counterexamplePath,
    runs: details.numRuns,
    skips: details.numSkips,
    shrinks: details.numShrinks,
    error: details.errorInstance instanceof Error
      ? { name: details.errorInstance.name, message: details.errorInstance.message }
      : details.errorInstance === null ? null : String(details.errorInstance)
  };
  results.push(result);
  if (details.failed || details.interrupted) {
    failed = true;
  }
  if (details.failed) {
    await writeFile(
      join(artifactDirectory, "replay.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        scenario: scenario.name,
        seed: details.seed,
        path: details.counterexamplePath,
        command: `ODINN_FUZZ_SCENARIO=${scenario.name} ODINN_FUZZ_SEED=${details.seed} ODINN_FUZZ_PATH=${details.counterexamplePath ?? ""} pnpm fuzz:replay`
      }, null, 2)}\n`,
      "utf8"
    );
    break;
  }
}

const report = {
  schemaVersion: 1,
  startedAt,
  completedAt: new Date().toISOString(),
  durationMs: Number((performance.now() - started).toFixed(3)),
  revision: process.env.GITHUB_SHA || process.env.ODINN_FUZZ_REVISION || "local-unrecorded",
  environment: {
    platform: platform(),
    release: release(),
    architecture: arch(),
    node: process.version,
    ci: process.env.CI === "true"
  },
  bounds: {
    requestedRuns: totalRuns,
    maximumSeconds: maxSeconds,
    maximumRuns: MAX_RUNS
  },
  results
};
await writeFile(join(artifactDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;

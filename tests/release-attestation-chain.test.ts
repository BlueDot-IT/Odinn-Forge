import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  attestationVerificationArgs,
  verifyAttestedReleaseAssets
} from "../scripts/release/verify-attested-assets.ts";

const repository = "BlueDot-IT/Odinn-Forge";
const sourceSha = "a".repeat(40);

async function releaseFixture(): Promise<{ root: string; expected: string; candidate: string }> {
  const root = await mkdtemp(join(tmpdir(), "odinn-attested-release-"));
  const expected = join(root, "actions-artifact");
  const candidate = join(root, "draft-assets");
  const { mkdir } = await import("node:fs/promises");
  await Promise.all([mkdir(expected), mkdir(candidate)]);
  for (const [name, bytes] of [["SHA256SUMS.txt", "checksums\n"], ["odinn-v1.2.3.tar.gz", "archive bytes\n"]]) {
    await Promise.all([writeFile(join(expected, name), bytes), writeFile(join(candidate, name), bytes)]);
  }
  return { root, expected, candidate };
}

async function signedResult(directory: string, runId: string, mutate?: (value: any) => void): Promise<string> {
  const names = ["SHA256SUMS.txt", "odinn-v1.2.3.tar.gz"];
  const subject = await Promise.all(names.map(async (name) => ({
    name,
    digest: { sha256: createHash("sha256").update(await readFile(join(directory, name))).digest("hex") }
  })));
  const workflowUrl = `https://github.com/${repository}/.github/workflows/release.yml@refs/heads/main`;
  const invocation = `https://github.com/${repository}/actions/runs/${runId}/attempts/2`;
  const value = [{
    verificationResult: {
      signature: {
        certificate: {
          subjectAlternativeName: workflowUrl,
          githubWorkflowRepository: repository,
          githubWorkflowSHA: sourceSha,
          githubWorkflowRef: "refs/heads/main",
          githubWorkflowTrigger: "workflow_dispatch",
          buildSignerURI: workflowUrl,
          buildSignerDigest: sourceSha,
          sourceRepositoryURI: `https://github.com/${repository}`,
          sourceRepositoryDigest: sourceSha,
          sourceRepositoryRef: "refs/heads/main",
          buildTrigger: "workflow_dispatch",
          runnerEnvironment: "github-hosted",
          runInvocationURI: invocation
        }
      },
      statement: {
        predicateType: "https://slsa.dev/provenance/v1",
        subject,
        predicate: {
          buildDefinition: {
            externalParameters: {
              workflow: {
                path: ".github/workflows/release.yml",
                ref: "refs/heads/main",
                repository: `https://github.com/${repository}`
              }
            },
            internalParameters: {
              github: { event_name: "workflow_dispatch", runner_environment: "github-hosted" }
            },
            resolvedDependencies: [{
              uri: `git+https://github.com/${repository}@refs/heads/main`,
              digest: { gitCommit: sourceSha }
            }]
          },
          runDetails: { builder: { id: workflowUrl }, metadata: { invocationId: invocation } }
        }
      }
    }
  }];
  mutate?.(value);
  return JSON.stringify(value);
}

test("initial publication compares immutable bytes and verifies every asset with exact gh identity flags", async () => {
  const fixture = await releaseFixture();
  try {
    const calls: Array<{ name: string; args: string[] }> = [];
    await verifyAttestedReleaseAssets({
      expectedDirectory: fixture.expected,
      candidateDirectory: fixture.candidate,
      repository,
      sourceSha,
      runId: "42",
      verify: (path, args) => {
        calls.push({ name: basename(path), args });
        return JSON.stringify(JSON.parse("[]"));
      }
    }).then(
      () => assert.fail("empty attestation output must fail closed"),
      (error) => assert.match(String(error), /invalid result set/u)
    );
    calls.length = 0;
    const output = await signedResult(fixture.candidate, "42");
    await verifyAttestedReleaseAssets({
      expectedDirectory: fixture.expected,
      candidateDirectory: fixture.candidate,
      repository,
      sourceSha,
      runId: "42",
      verify: (path, args) => {
        calls.push({ name: basename(path), args });
        return output;
      }
    });
    assert.deepEqual(calls.map((entry) => entry.name).sort(), ["SHA256SUMS.txt", "odinn-v1.2.3.tar.gz"]);
    for (const call of calls) assert.deepEqual(call.args, attestationVerificationArgs(repository, sourceSha));
    assert.deepEqual(attestationVerificationArgs(repository, sourceSha), [
      "attestation", "verify", "--repo", repository,
      "--signer-workflow", `${repository}/.github/workflows/release.yml`,
      "--signer-digest", sourceSha,
      "--source-digest", sourceSha,
      "--source-ref", "refs/heads/main",
      "--deny-self-hosted-runners", "--format", "json"
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("resume accepts only the explicitly bound staging run and exact signed inventory", async () => {
  const fixture = await releaseFixture();
  try {
    const valid = await signedResult(fixture.candidate, "9001");
    await verifyAttestedReleaseAssets({
      expectedDirectory: fixture.expected,
      candidateDirectory: fixture.candidate,
      repository,
      sourceSha,
      runId: "9001",
      verify: () => valid
    });
    await assert.rejects(
      verifyAttestedReleaseAssets({
        expectedDirectory: fixture.expected,
        candidateDirectory: fixture.candidate,
        repository,
        sourceSha,
        runId: "9002",
        verify: () => valid
      }),
      /exact workflow run and inventory/u
    );
    const extraSubject = await signedResult(fixture.candidate, "9001", (value) => {
      value[0].verificationResult.statement.subject.push({ name: "extra.txt", digest: { sha256: "b".repeat(64) } });
    });
    await assert.rejects(
      verifyAttestedReleaseAssets({
        expectedDirectory: fixture.expected,
        candidateDirectory: fixture.candidate,
        repository,
        sourceSha,
        runId: "9001",
        verify: () => extraSubject
      }),
      /exact workflow run and inventory/u
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("publication refuses draft mutation before trusting any attestation", async () => {
  const fixture = await releaseFixture();
  try {
    await writeFile(join(fixture.candidate, "odinn-v1.2.3.tar.gz"), "mutated archive\n");
    let calls = 0;
    await assert.rejects(
      verifyAttestedReleaseAssets({
        expectedDirectory: fixture.expected,
        candidateDirectory: fixture.candidate,
        repository,
        sourceSha,
        runId: "42",
        verify: () => {
          calls += 1;
          return "[]";
        }
      }),
      /asset identity mismatch/u
    );
    assert.equal(calls, 0);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

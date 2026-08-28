#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type InventoryEntry = { name: string; bytes: number; sha256: string };
type AttestationVerifier = (path: string, args: string[]) => string;

const MAX_RELEASE_ASSETS = 64;
const SOURCE_REF = "refs/heads/main";

export function attestationVerificationArgs(repository: string, sourceSha: string): string[] {
  return [
    "attestation",
    "verify",
    "--repo",
    repository,
    "--signer-workflow",
    `${repository}/.github/workflows/release.yml`,
    "--signer-digest",
    sourceSha,
    "--source-digest",
    sourceSha,
    "--source-ref",
    SOURCE_REF,
    "--deny-self-hosted-runners",
    "--format",
    "json"
  ];
}

export async function verifyAttestedReleaseAssets({
  expectedDirectory,
  candidateDirectory,
  repository,
  sourceSha,
  runId,
  verify = verifyWithGitHubCli
}: {
  expectedDirectory: string;
  candidateDirectory: string;
  repository: string;
  sourceSha: string;
  runId: string;
  verify?: AttestationVerifier;
}): Promise<void> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("release attestation repository identity is invalid");
  }
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw new Error("release attestation source digest must be an exact commit");
  }
  if (!/^[1-9][0-9]*$/u.test(runId)) {
    throw new Error("release attestation workflow run ID is invalid");
  }

  const expectedRoot = resolve(expectedDirectory);
  const candidateRoot = resolve(candidateDirectory);
  if (await realpath(expectedRoot) === await realpath(candidateRoot)) {
    throw new Error("release publication comparison requires independent artifact directories");
  }
  const expected = await inventory(expectedRoot, "immutable Actions artifact");
  const candidate = await inventory(candidateRoot, "downloaded draft release");
  if (expected.length !== candidate.length) {
    throw new Error("draft release inventory does not match the immutable Actions artifact");
  }
  for (let index = 0; index < expected.length; index += 1) {
    const trusted = expected[index]!;
    const downloaded = candidate[index]!;
    if (trusted.name !== downloaded.name || trusted.bytes !== downloaded.bytes || trusted.sha256 !== downloaded.sha256) {
      throw new Error(`draft release asset identity mismatch: ${downloaded.name}`);
    }
    await compareFilesBytewise(join(expectedRoot, trusted.name), join(candidateRoot, downloaded.name), trusted.bytes);
  }

  const verificationArgs = attestationVerificationArgs(repository, sourceSha);
  for (const entry of candidate) {
    const output = verify(join(candidateRoot, entry.name), verificationArgs);
    const results = parseVerificationResults(output, entry.name);
    if (!results.some((result) => attestationMatches(result, candidate, repository, sourceSha, runId))) {
      throw new Error(`no release attestation matched the exact workflow run and inventory: ${entry.name}`);
    }
  }
}

async function inventory(directory: string, label: string): Promise<InventoryEntry[]> {
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error(`${label} is not a physical directory`);
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length === 0 || entries.length > MAX_RELEASE_ASSETS) {
    throw new Error(`${label} has an invalid asset count`);
  }
  const result: InventoryEntry[] = [];
  for (const entry of entries) {
    if (basename(entry.name) !== entry.name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(entry.name)) {
      throw new Error(`${label} contains an unsafe asset name`);
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} contains a non-regular asset: ${entry.name}`);
    }
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error(`${label} contains a linked asset: ${entry.name}`);
    }
    result.push({ name: entry.name, bytes: metadata.size, sha256: await sha256(path) });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function compareFilesBytewise(expected: string, candidate: string, bytes: number): Promise<void> {
  const trusted = await open(expected, "r");
  const downloaded = await open(candidate, "r");
  try {
    const trustedBuffer = Buffer.allocUnsafe(1024 * 1024);
    const downloadedBuffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < bytes) {
      const length = Math.min(trustedBuffer.length, bytes - offset);
      const [trustedRead, downloadedRead] = await Promise.all([
        trusted.read(trustedBuffer, 0, length, offset),
        downloaded.read(downloadedBuffer, 0, length, offset)
      ]);
      if (trustedRead.bytesRead !== length
        || downloadedRead.bytesRead !== length
        || !trustedBuffer.subarray(0, length).equals(downloadedBuffer.subarray(0, length))) {
        throw new Error(`draft release asset bytes differ from the immutable Actions artifact: ${basename(candidate)}`);
      }
      offset += length;
    }
  } finally {
    await Promise.all([trusted.close(), downloaded.close()]);
  }
}

function verifyWithGitHubCli(path: string, args: string[]): string {
  const result = spawnSync("gh", [args[0]!, args[1]!, path, ...args.slice(2)], {
    encoding: "utf8",
    shell: false,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`GitHub attestation verification failed for ${basename(path)}: ${String(result.stderr).trim()}`);
  }
  return result.stdout;
}

function parseVerificationResults(output: string, name: string): any[] {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`GitHub attestation verification returned invalid JSON for ${name}`);
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new Error(`GitHub attestation verification returned an invalid result set for ${name}`);
  }
  return value;
}

function attestationMatches(
  result: any,
  inventoryEntries: InventoryEntry[],
  repository: string,
  sourceSha: string,
  runId: string
): boolean {
  const certificate = result?.verificationResult?.signature?.certificate;
  const statement = result?.verificationResult?.statement;
  const workflow = `${repository}/.github/workflows/release.yml`;
  const workflowUrl = `https://github.com/${workflow}@${SOURCE_REF}`;
  const invocation = `https://github.com/${repository}/actions/runs/${runId}/attempts/`;
  if (certificate?.subjectAlternativeName !== workflowUrl
    || certificate?.githubWorkflowRepository !== repository
    || certificate?.githubWorkflowSHA !== sourceSha
    || certificate?.githubWorkflowRef !== SOURCE_REF
    || certificate?.githubWorkflowTrigger !== "workflow_dispatch"
    || certificate?.buildSignerURI !== workflowUrl
    || certificate?.buildSignerDigest !== sourceSha
    || certificate?.sourceRepositoryURI !== `https://github.com/${repository}`
    || certificate?.sourceRepositoryDigest !== sourceSha
    || certificate?.sourceRepositoryRef !== SOURCE_REF
    || certificate?.buildTrigger !== "workflow_dispatch"
    || certificate?.runnerEnvironment !== "github-hosted"
    || certificate?.runInvocationURI?.startsWith(invocation) !== true
    || !/^[1-9][0-9]*$/u.test(String(certificate.runInvocationURI.slice(invocation.length)))) {
    return false;
  }
  const predicate = statement?.predicate;
  if (statement?.predicateType !== "https://slsa.dev/provenance/v1"
    || predicate?.buildDefinition?.externalParameters?.workflow?.path !== ".github/workflows/release.yml"
    || predicate?.buildDefinition?.externalParameters?.workflow?.ref !== SOURCE_REF
    || predicate?.buildDefinition?.externalParameters?.workflow?.repository !== `https://github.com/${repository}`
    || predicate?.buildDefinition?.internalParameters?.github?.event_name !== "workflow_dispatch"
    || predicate?.buildDefinition?.internalParameters?.github?.runner_environment !== "github-hosted"
    || predicate?.runDetails?.builder?.id !== workflowUrl
    || predicate?.runDetails?.metadata?.invocationId !== certificate.runInvocationURI) {
    return false;
  }
  const dependencies = predicate?.buildDefinition?.resolvedDependencies;
  if (!Array.isArray(dependencies) || !dependencies.some((entry: any) =>
    entry?.uri === `git+https://github.com/${repository}@${SOURCE_REF}` && entry?.digest?.gitCommit === sourceSha)) {
    return false;
  }
  const subjects = statement?.subject;
  if (!Array.isArray(subjects) || subjects.length !== inventoryEntries.length) return false;
  const normalized = subjects.map((entry: any) => ({
    name: entry?.name,
    sha256: entry?.digest?.sha256,
    digestKeys: Object.keys(entry?.digest ?? {}).sort()
  })).sort((left: any, right: any) => String(left.name).localeCompare(String(right.name)));
  return normalized.every((subject: any, index: number) => {
    const expected = inventoryEntries[index]!;
    return subject.name === expected.name
      && subject.sha256 === expected.sha256
      && subject.digestKeys.length === 1
      && subject.digestKeys[0] === "sha256";
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  const [expectedDirectory, candidateDirectory, repository, sourceSha, runId] = process.argv.slice(2);
  if (!expectedDirectory || !candidateDirectory || !repository || !sourceSha || !runId || process.argv.length !== 7) {
    throw new Error("usage: verify-attested-assets.ts EXPECTED_DIRECTORY CANDIDATE_DIRECTORY REPOSITORY SOURCE_SHA WORKFLOW_RUN_ID");
  }
  await verifyAttestedReleaseAssets({ expectedDirectory, candidateDirectory, repository, sourceSha, runId });
  console.log(`verified ${candidateDirectory} against the immutable Actions artifact and exact release workflow identity`);
}

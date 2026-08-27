import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile, mkdir, mkdtemp, readdir, stat, lstat, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { cwd as currentWorkingDirectory } from "node:process";
import { Unzip, UnzipInflate, zipSync } from "fflate";
import { createRunLedger, redact } from "./run-ledger.ts";
import { ProofVerifier, proofEvidenceView } from "./proof.ts";
import { evaluatePolicyInvariants, normalizePolicyInvariants } from "@odinn/policy";
import { projectDurableToolInput } from "@odinn/protocol";
import { ODINN_ERROR_CODES, OdinnRuntimeError } from "./runtime-errors.ts";
import { capabilityTokensPlugin, capsulesPlugin, counterfactualPlugin, loadRuntimePlugins } from "./plugins/index.ts";
import { sanitizedChildEnvironment } from "./environment.ts";

declare const __ODINN_COMPILED__: boolean | undefined;

type AnyRecord = Record<string, any>;
type FeatureFlags = Record<string, boolean>;
const failureMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export { ODINN_ERROR_CODES, OdinnRuntimeError };

function now() { return new Date().toISOString(); }
function json(value: unknown) { return JSON.stringify(value); }
function containsRedaction(value: unknown): boolean {
  if (typeof value === "string") return value.includes("[redacted");
  if (Array.isArray(value)) return value.some(containsRedaction);
  if (value && typeof value === "object") return Object.values(value).some(containsRedaction);
  return false;
}
function hash(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
const CAPSULE_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const CAPSULE_MAX_ENTRIES = 512;
const CAPSULE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const CAPSULE_MAX_EXPANDED_BYTES = 128 * 1024 * 1024;
const CAPSULE_DECOMPRESSION_TIMEOUT_MS = 10_000;
const CAPSULE_COMPRESSED_CHUNK_BYTES = 16 * 1024;
function capsuleArchiveBytes(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > CAPSULE_MAX_ARCHIVE_BYTES) {
      throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule archive exceeds the ${CAPSULE_MAX_ARCHIVE_BYTES}-byte compressed-size limit`);
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (error instanceof OdinnRuntimeError) throw error;
    throw new OdinnRuntimeError("CAPSULE_INVALID", "invalid capsule archive");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function capsuleArchiveEntries(path: string): Map<string, Buffer> {
  const compressed = capsuleArchiveBytes(path);
  const archive = new Map<string, Buffer>();
  let entries = 0;
  let expandedBytes = 0;
  const startedAt = Date.now();
  try {
    const unzipper = new Unzip((file) => {
      entries += 1;
      if (entries > CAPSULE_MAX_ENTRIES) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule archive exceeds the ${CAPSULE_MAX_ENTRIES}-entry limit`);
      const name = file.name.replaceAll("\\", "/");
      if (archive.has(name)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule contains a duplicate path", { name });
      const chunks: Buffer[] = [];
      let entryBytes = 0;
      file.ondata = (error, data, final) => {
        if (error) throw error;
        if (Date.now() - startedAt > CAPSULE_DECOMPRESSION_TIMEOUT_MS) {
          throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule decompression exceeded the ${CAPSULE_DECOMPRESSION_TIMEOUT_MS}ms execution limit`);
        }
        entryBytes += data.byteLength;
        expandedBytes += data.byteLength;
        if (entryBytes > CAPSULE_MAX_ENTRY_BYTES) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule entry exceeds the ${CAPSULE_MAX_ENTRY_BYTES}-byte expanded-size limit`);
        if (expandedBytes > CAPSULE_MAX_EXPANDED_BYTES) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule archive exceeds the ${CAPSULE_MAX_EXPANDED_BYTES}-byte expanded-size limit`);
        if (data.byteLength) chunks.push(Buffer.from(data));
        if (final) archive.set(name, Buffer.concat(chunks, entryBytes));
      };
      file.start();
    });
    unzipper.register(UnzipInflate);
    // Feed a bounded amount of compressed input at a time. fflate's streaming
    // inflater emits after each push; handing it the entire archive would let
    // forged size metadata drive an arbitrarily large allocation before our
    // ondata limits can reject the entry.
    if (compressed.byteLength === 0) unzipper.push(compressed, true);
    for (let offset = 0; offset < compressed.byteLength; offset += CAPSULE_COMPRESSED_CHUNK_BYTES) {
      const end = Math.min(offset + CAPSULE_COMPRESSED_CHUNK_BYTES, compressed.byteLength);
      unzipper.push(compressed.subarray(offset, end), end === compressed.byteLength);
    }
  } catch (error) {
    if (error instanceof OdinnRuntimeError) throw error;
    throw new OdinnRuntimeError("CAPSULE_INVALID", "invalid capsule archive");
  }
  return archive;
}
function capsuleEntryText(entries: Map<string, Buffer>, name: string): string {
  const entry = entries.get(name);
  if (!entry) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule is missing ${name}`);
  return entry.toString("utf8");
}
function parse(value: string | undefined | null, fallback: any = {}): any { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } }
function redactArtifactBytes(bytes: Buffer, context: { toolName?: string; input?: boolean }) {
  try {
    return Buffer.from(json(redact(JSON.parse(bytes.toString("utf8")), context)));
  } catch {
    return bytes;
  }
}
function replaceCapsuleDigests(value: any, digests: Map<string, string>): any {
  if (typeof value === "string") return digests.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceCapsuleDigests(item, digests));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceCapsuleDigests(item, digests)]));
  }
  return value;
}
function odinnVersion() {
  const configured = process.env.ODINN_VERSION?.trim();
  if (configured) return configured;
  try {
    const compiled = typeof __ODINN_COMPILED__ !== "undefined";
    const manifest = JSON.parse(readFileSync(new URL(compiled ? "../../package.json" : "../../../package.json", import.meta.url), "utf8"));
    if (typeof manifest.version === "string" && manifest.version.trim()) return manifest.version.trim();
  } catch {}
  return "unknown";
}
function requireExperimental(flags: FeatureFlags, name: string, ledger?: any) {
  if (flags?.[name] === true) return;
  ledger ??= (flags as AnyRecord).__ledger;
  if (ledger) {
    const runId = `system:experimental:${name}`;
    ledger.ensureRun({ runId, objective: `record disabled experimental feature ${name}` });
    ledger.appendEvent({ runId, type: "experimental-feature-rejected", payload: { feature: name, reason: "disabled" } });
  }
  throw new OdinnRuntimeError("POLICY_VIOLATION", `experimental.${name} is disabled`, { feature: name });
}
function safePath(root: string, candidate: string) {
  const base = resolve(root);
  const target = resolve(base, candidate);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new OdinnRuntimeError("POLICY_VIOLATION", "path escapes allowed root", { path: candidate });
  return target;
}
function safeExistingPath(root: string, candidate: string) {
  const base = resolve(root);
  const target = safePath(base, candidate);
  let cursor = target;
  while (cursor !== base) {
    try {
      lstatSync(cursor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      cursor = dirname(cursor);
    }
  }
  try {
    if (lstatSync(target).isSymbolicLink()) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "symlinks are not snapshot-safe", { path: candidate });
  } catch (error) {
    if (error instanceof OdinnRuntimeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const real = resolve(realpathSync(cursor));
  const physicalBase = resolve(realpathSync(base));
  if (real !== physicalBase && !real.startsWith(`${physicalBase}${sep}`)) throw new OdinnRuntimeError("POLICY_VIOLATION", "symlink escapes allowed root", { path: candidate });
  return target;
}

function isWithin(root: string, target: string) {
  const base = resolve(root);
  const resolvedTarget = resolve(target);
  return resolvedTarget === base || resolvedTarget.startsWith(`${base}${sep}`);
}

function assertCapsuleExportPath(root: string, target: string) {
  const base = resolve(root);
  const destination = resolve(target);
  if (!isWithin(base, destination)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output escapes its allowed root");
  const physicalBase = resolve(realpathSync(base));
  const segments = relative(base, destination).split(sep).filter(Boolean);
  let cursor = base;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) break;
    if (lstatSync(cursor).isSymbolicLink()) {
      throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output cannot traverse a symbolic link", { path: target });
    }
    const physical = resolve(realpathSync(cursor));
    if (!isWithin(physicalBase, physical)) {
      throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output escapes its allowed root", { path: target });
    }
  }
  return destination;
}

function physicalCapsuleExportPath(root: string, target: string) {
  const destination = assertCapsuleExportPath(root, target);
  const physicalBase = resolve(realpathSync(root));
  // Node does not expose a portable openat(2). Restrict output to a direct
  // child of an already-established allowed root so a workspace-controlled
  // intermediate directory cannot be replaced between validation and open.
  if (dirname(destination) !== resolve(root)) {
    throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output must be directly inside an allowed root", { path: target });
  }
  return { destination, physicalBase, physicalDestination: join(physicalBase, basename(destination)) };
}

function isPlainRecord(value: unknown): value is AnyRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLoopbackUrl(value: string) {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

// Minimal JSON/YAML-shaped loader: JSON is canonical; simple YAML is accepted for
// contracts and policies so the CLI remains dependency-free and rejects ambiguous input.
export function parseStructuredDocument(source: string, label = "document"): AnyRecord {
  try { return JSON.parse(source); } catch {}
  const lines = String(source).split(/\r?\n/).map((line) => { const comment = line.indexOf(" #"); return comment === -1 ? line : line.slice(0, comment); }).filter((line) => line.trim());
  const root: AnyRecord = {};
  let currentList: any[] | undefined;
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ")) {
      if (!currentList) throw new OdinnRuntimeError("CAPSULE_INVALID", `${label} YAML list has no parent`);
      const item = trimmed.slice(2).trimStart();
      if (item.includes(": ")) { const [key, ...rest] = item.split(": "); currentList.push({ [key.trim()]: scalar(rest.join(": ").trim()) }); }
      else currentList.push(scalar(item));
      continue;
    }
    const colon = line.indexOf(":");
    const key = colon === -1 ? "" : line.slice(0, colon).trim();
    const raw = colon === -1 ? "" : line.slice(colon + 1).trim();
    if (!key || [...key].some((character) => !/[A-Za-z0-9_.-]/.test(character))) throw new OdinnRuntimeError("CAPSULE_INVALID", `${label} must be JSON or simple YAML`);
    if (!raw) { root[key] = []; currentList = root[key]; }
    else { root[key] = scalar(raw); currentList = undefined; }
  }
  return root;
}
function scalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value.startsWith("[") || value.startsWith("{")) { try { return JSON.parse(value); } catch {} }
  return value;
}

export function validateContract(contract: unknown): AnyRecord {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract must be an object");
  const value = contract as AnyRecord;
  if (value.version !== 1) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract version must be 1");
  if (typeof value.goal !== "string" || !value.goal.trim()) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract goal is required");
  if (!Array.isArray(value.acceptance) || value.acceptance.length === 0) throw new OdinnRuntimeError("CAPSULE_INVALID", "contract acceptance must contain assertions");
  const ids = new Set<string>();
  for (const assertion of value.acceptance) {
    if (!assertion || typeof assertion.id !== "string" || ids.has(assertion.id)) throw new OdinnRuntimeError("CAPSULE_INVALID", "assertion ids must be unique");
    ids.add(assertion.id);
    if (!["command", "file", "http", "git"].includes(assertion.type)) throw new OdinnRuntimeError("CAPSULE_INVALID", `unsupported assertion type: ${assertion.type}`);
    if (assertion.type === "command" && (typeof assertion.command !== "string" || !Array.isArray(assertion.args ?? []))) throw new OdinnRuntimeError("CAPSULE_INVALID", `command assertion ${assertion.id} requires command and args`);
    if (assertion.type === "file" && typeof assertion.path !== "string") throw new OdinnRuntimeError("CAPSULE_INVALID", `file assertion ${assertion.id} requires path`);
    if (assertion.type === "http") {
      if (typeof assertion.url !== "string") throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} requires url`);
      let parsedUrl;
      try { parsedUrl = new URL(assertion.url); } catch { throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} requires a valid URL`); }
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.hash) throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} URL is not safe`);
      if (assertion.method !== undefined && !['GET', 'HEAD'].includes(String(assertion.method).toUpperCase())) throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} method must be GET or HEAD`);
      if (!Number.isInteger(assertion.expect?.status) || assertion.expect.status < 100 || assertion.expect.status > 599) throw new OdinnRuntimeError("CAPSULE_INVALID", `http assertion ${assertion.id} requires an HTTP status expectation`);
    }
  }
  return value;
}

export function validatePolicy(policy: unknown): AnyRecord {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy must be an object");
  const value = policy as AnyRecord;
  if (value.version !== 1) throw new OdinnRuntimeError("POLICY_VIOLATION", "policy version must be 1");
  try {
    return { ...value, invariants: normalizePolicyInvariants(value.invariants ?? []) };
  } catch (error) {
    throw new OdinnRuntimeError("POLICY_VIOLATION", failureMessage(error));
  }
}

interface ProcessResult { code: number; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }
function runProcess(command: string, args: string[], { cwd, timeoutMs = 120_000 }: { cwd?: string; timeoutMs?: number } = {}): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, { cwd, env: sanitizedChildEnvironment(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 1_000_000) child.kill("SIGTERM"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 1_000_000) child.kill("SIGTERM"); });
    child.on("error", (error) => { clearTimeout(timer); rejectProcess(error); });
    child.on("close", (code, signal) => { clearTimeout(timer); resolveProcess({ code: code ?? 1, signal, stdout: stdout.slice(0, 1_000_000), stderr: stderr.slice(0, 1_000_000), timedOut }); });
  });
}

export class ProofEngine {
  [key: string]: any;
  constructor({ ledger, featureFlags = {}, allowExternalHttp = false, allowedCommands = [], maxOutputBytes, maxFileBytes, commandEnvironment, includeRawEvidence = false }: AnyRecord = {}) {
    this.ledger = ledger;
    this.featureFlags = featureFlags;
    this.allowExternalHttp = allowExternalHttp === true;
    this.includeRawEvidence = includeRawEvidence === true;
    this.verifierOptions = { allowedCommands, maxOutputBytes, maxFileBytes, commandEnvironment, includeRawEvidence: this.includeRawEvidence };
  }
  async run(runId: string, contract: AnyRecord, { workspaceRoot = currentWorkingDirectory(), signal }: AnyRecord = {}) {
    if (contract?.schemaVersion === 1) {
      const verifierOptions = Object.fromEntries(Object.entries(this.verifierOptions).filter(([, value]) => value !== undefined));
      return new ProofVerifier({
        runLedger: this.ledger,
        ...verifierOptions,
        allowedRoot: workspaceRoot,
        allowExternalHttp: this.allowExternalHttp
      }).verify({ ...contract, runId }, { signal });
    }
    validateContract(contract);
    const id = contract.id ?? `contract_${randomUUID()}`;
    const createdAt = now();
    this.ledger.database.transaction((db: any) => db.prepare("INSERT OR REPLACE INTO verification_contracts(id, run_id, version, contract_json, created_at) VALUES (?, ?, ?, ?, ?)").run(id, runId, contract.version, json(redact(contract)), createdAt));
    const results = [];
    for (const assertion of contract.acceptance) {
      const startedAt = now(); let result;
      try { result = await this.evaluate(assertion, workspaceRoot); }
      catch (error) { result = { status: "error", message: failureMessage(error), evidence: [] }; }
      const completedAt = now();
      const artifactIds: string[] = [];
      if (this.includeRawEvidence && (result.stdout || result.stderr || result.body || result.evidence)) artifactIds.push(this.ledger.artifacts.putJson(redact(result)).digest);
      const safeResult = proofEvidenceView(result, this.includeRawEvidence);
      const row = { assertionId: assertion.id, status: result.status, startedAt, completedAt, evidenceArtifactIds: artifactIds, message: result.message ?? "", result: safeResult };
      this.ledger.database.transaction((db: any) => db.prepare(`INSERT OR REPLACE INTO assertion_results(id, contract_id, run_id, assertion_id, status, started_at, completed_at, evidence_artifact_ids_json, message, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, runId, assertion.id, row.status, startedAt, completedAt, json(artifactIds), row.message, json(safeResult)));
      this.ledger.appendEvent({ runId, type: "verification", payload: row });
      results.push(row);
    }
    const required = results.filter((item) => item.status !== "skipped");
    const failed = required.some((item) => ["failed", "error"].includes(item.status));
    const passed = required.length > 0 && required.every((item) => item.status === "passed");
    const status = failed ? "failed" : passed ? "verified" : "partially-verified";
    const modelObservationIds = (this.ledger.database.db.prepare("SELECT id FROM model_observations WHERE run_id = ? ORDER BY created_at").all(runId) as AnyRecord[]).map((row: AnyRecord) => row.id);
    this.ledger.database.transaction((db: any) => {
      db.prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?").run(status, now(), runId);
      db.prepare("UPDATE model_observations SET verified = ?, partially_verified = ? WHERE run_id = ?")
        .run(status === "verified" ? 1 : 0, status === "partially-verified" ? 1 : 0, runId);
    });
    this.ledger.appendEvent({ runId, type: "verification-completed", payload: { contractId: id, status, results: results.map(({ assertionId, status: resultStatus }) => ({ assertionId, status: resultStatus })) } });
    if (modelObservationIds.length) this.ledger.appendEvent({ runId, type: "model-observation-verification", payload: { contractId: id, status, verified: status === "verified", observationIds: modelObservationIds } });
    return { runId, contractId: id, status, results };
  }
  async evaluate(assertion: AnyRecord, workspaceRoot: string): Promise<AnyRecord> {
    if (assertion.type === "command") {
      throw new OdinnRuntimeError("POLICY_VIOLATION", "legacy Proof command assertions are disabled; use ProofVerifier with an operator-controlled exact command allowlist");
    }
    if (assertion.type === "file") {
      const path = safeExistingPath(workspaceRoot, assertion.path); const exists = existsSync(path); const expectExists = assertion.expect?.exists !== false;
      const content = exists && lstatSync(path).isFile() ? readFileSync(path, "utf8") : "";
      const passed = expectExists ? exists && (!assertion.expect?.contains || content.includes(assertion.expect.contains)) : !exists;
      return { status: passed ? "passed" : "failed", message: passed ? "file assertion passed" : "file assertion failed", exists, digest: exists ? hash(content) : undefined };
    }
    if (assertion.type === "http") {
      if (!this.allowExternalHttp && !isLoopbackUrl(assertion.url)) throw new OdinnRuntimeError("POLICY_VIOLATION", "external HTTP verification is disabled by default");
      const response = await fetch(assertion.url, { method: assertion.method ?? "GET", redirect: "manual" });
      const body = await response.text(); const expectedStatus = assertion.expect?.status ?? 200;
      const passed = response.status === expectedStatus && (!assertion.expect?.bodyContains || body.includes(assertion.expect.bodyContains));
      return { status: passed ? "passed" : "failed", message: passed ? "http assertion passed" : `status=${response.status}`, statusCode: response.status, body: body.slice(0, 100_000) };
    }
    if (assertion.type === "git") {
      const result = await runProcess("git", ["status", "--porcelain"], { cwd: workspaceRoot });
      const expectedClean = assertion.expect?.clean === true; const clean = result.stdout.trim() === "";
      return { status: clean === expectedClean ? "passed" : "failed", message: clean === expectedClean ? "git assertion passed" : "git working tree mismatch", stdout: result.stdout };
    }
    throw new OdinnRuntimeError("CAPSULE_INVALID", `unsupported assertion: ${assertion.type}`);
  }
  show(runId: string) { return this.ledger.database.db.prepare("SELECT * FROM assertion_results WHERE run_id = ? ORDER BY completed_at").all(runId).map((row: AnyRecord) => ({ ...row, evidenceArtifactIds: parse(row.evidence_artifact_ids_json, []), result: parse(row.result_json) })); }
}

export class Sentinel {
  [key: string]: any;
  constructor({ ledger, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.featureFlags = featureFlags; }
  evaluate({ runId, stepId, toolName, input, durableInput = projectDurableToolInput(toolName, input), policy, workspaceRoot = currentWorkingDirectory() }: AnyRecord) {
    const normalizedPolicy = validatePolicy(policy);
    const policyId = policy.id ?? `policy_${runId}_${hash(json(redact(policy))).slice(0, 16)}`;
    const evaluations = evaluatePolicyInvariants({
      policy: normalizedPolicy as any,
      request: { tool: toolName, input },
      workspaceRoot
    }).map((result) => {
      return { id: randomUUID(), runId, stepId, policyId, ...result, input: redact({ toolName, input: durableInput }), createdAt: now() };
    });
    this.ledger.database.transaction((db: AnyRecord) => {
      db.prepare("INSERT OR IGNORE INTO policies(id, run_id, policy_json, created_at) VALUES (?, ?, ?, ?)").run(policyId, runId, json(redact(policy)), now());
      const insertEvaluation = db.prepare("INSERT INTO policy_evaluations(id, run_id, step_id, policy_id, invariant_id, decision, enforcement, reason, input_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const evaluation of evaluations) {
        insertEvaluation.run(evaluation.id, runId, stepId ?? null, evaluation.policyId, evaluation.invariantId, evaluation.decision, evaluation.enforcement, evaluation.reason, json(evaluation.input), evaluation.createdAt);
        this.ledger.appendEventUnsafe(db, { runId, type: "policy-check", payload: evaluation, timestamp: evaluation.createdAt });
      }
    });
    const blocked = evaluations.find((item) => ["block", "terminate", "rollback", "pause"].includes(item.decision));
    if (blocked) throw new OdinnRuntimeError("POLICY_VIOLATION", blocked.reason, { evaluation: blocked });
    return { allowed: true, evaluations };
  }
}

export class CapabilityBroker {
  [key: string]: any;
  constructor({ ledger, stateDir, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; this.keyPath = join(this.stateDir, "capability-signing.key"); mkdirSync(this.stateDir, { recursive: true }); this.key = this.loadKey(); }
  loadKey() { if (existsSync(this.keyPath)) return readFileSync(this.keyPath); const key = randomBytes(32); writeFileSync(this.keyPath, key, { mode: 0o600, flag: "wx" }); chmodSync(this.keyPath, 0o600); return key; }
  issue({ runId, stepId, toolName, scopes = [], resourceConstraints = {}, expiresInMs = 60_000, maxUses = 1, approvalId }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "capabilities", this.ledger);
    if (typeof runId !== "string" || !runId || typeof stepId !== "string" || !stepId || typeof toolName !== "string" || !toolName) throw new OdinnRuntimeError("CAPABILITY_DENIED", "runId, stepId, and toolName are required");
    if (!Array.isArray(scopes) || scopes.some((scope) => typeof scope !== "string" || !scope)) throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability scopes must be non-empty strings");
    if (!Number.isInteger(expiresInMs) || expiresInMs < 1 || expiresInMs > 3_600_000) throw new OdinnRuntimeError("CAPABILITY_DENIED", "expiresInMs must be an integer from 1 through 3600000");
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100) throw new OdinnRuntimeError("CAPABILITY_DENIED", "maxUses must be an integer from 1 through 100");
    const claims = { id: `cap_${randomUUID()}`, runId, stepId, toolName, scopes, resourceConstraints, issuedAt: now(), expiresAt: new Date(Date.now() + expiresInMs).toISOString(), maxUses, approvalId, nonce: randomBytes(16).toString("hex") };
    const encoded = Buffer.from(json(claims)).toString("base64url"); const signature = createHmac("sha256", this.key).update(encoded).digest("base64url");
    this.ledger.database.db.prepare("INSERT INTO capabilities(id, run_id, step_id, tool_name, scopes_json, constraints_json, issued_at, expires_at, max_uses, nonce, approval_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')").run(claims.id, runId, stepId, toolName, json(scopes), json(resourceConstraints), claims.issuedAt, claims.expiresAt, maxUses, claims.nonce, approvalId ?? null);
    this.ledger.appendEvent({ runId, type: "capability-issued", payload: { ...claims, token: undefined } });
    return { token: `${encoded}.${signature}`, claims };
  }
  validate(token: string, { runId, toolName, resource = {} }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "capabilities", this.ledger);
    const [encoded, signature] = String(token ?? "").split("."); const expected = createHmac("sha256", this.key).update(encoded ?? "").digest("base64url");
    if (!encoded || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new OdinnRuntimeError("CAPABILITY_DENIED", "invalid capability signature");
    const claims = parse(Buffer.from(encoded, "base64url").toString("utf8"), null); if (!claims) throw new OdinnRuntimeError("CAPABILITY_DENIED", "invalid capability claims");
    const row = this.ledger.database.db.prepare("SELECT * FROM capabilities WHERE id = ?").get(claims.id);
    if (!row || row.run_id !== runId || row.tool_name !== toolName) throw new OdinnRuntimeError("CAPABILITY_SCOPE_MISMATCH", "capability is not valid for this run or tool");
    if (Date.now() >= Date.parse(row.expires_at)) throw new OdinnRuntimeError("CAPABILITY_EXPIRED", "capability expired");
    if (row.uses >= row.max_uses) throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability use limit exceeded");
    if (row.status !== "active") throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability is not active");
    const constraints = parse(row.constraints_json, {}); for (const [key, expectedValue] of Object.entries(constraints)) if (Array.isArray(expectedValue) ? !expectedValue.includes(resource[key]) : resource[key] !== expectedValue) throw new OdinnRuntimeError("CAPABILITY_SCOPE_MISMATCH", `resource constraint mismatch: ${key}`);
    return claims;
  }
  consume(token: string, { runId, toolName, resource = {} }: AnyRecord = {}) {
    const claims = this.validate(token, { runId, toolName, resource });
    this.ledger.database.transaction((db: any) => {
      const usedAt = now();
      const update = db.prepare("UPDATE capabilities SET uses = uses + 1, status = CASE WHEN uses + 1 >= max_uses THEN 'consumed' ELSE status END WHERE id = ? AND status = 'active' AND uses < max_uses AND expires_at > ?").run(claims.id, usedAt);
      if (Number(update.changes ?? 0) !== 1) {
        const current = db.prepare("SELECT expires_at FROM capabilities WHERE id = ?").get(claims.id);
        if (current && Date.parse(current.expires_at) <= Date.parse(usedAt)) throw new OdinnRuntimeError("CAPABILITY_EXPIRED", "capability expired");
        throw new OdinnRuntimeError("CAPABILITY_DENIED", "capability was already consumed or revoked");
      }
      db.prepare("INSERT INTO capability_uses(id, capability_id, run_id, tool_name, resource_json, used_at, ok) VALUES (?, ?, ?, ?, ?, ?, 1)").run(randomUUID(), claims.id, runId, toolName, json(redact(resource)), usedAt);
    });
    this.ledger.appendEvent({ runId, type: "capability-consumed", payload: { capabilityId: claims.id, toolName, resource: redact(resource) } });
    return claims;
  }
  revoke(id: string) { this.ledger.database.db.prepare("UPDATE capabilities SET status = 'revoked', revoked_at = ? WHERE id = ?").run(now(), id); return this.ledger.database.db.prepare("SELECT id, run_id, tool_name, status, revoked_at FROM capabilities WHERE id = ?").get(id); }
  list(runId: string) { return this.ledger.database.db.prepare("SELECT id, run_id, step_id, tool_name, scopes_json, constraints_json, issued_at, expires_at, max_uses, uses, status, revoked_at FROM capabilities WHERE run_id = ? ORDER BY issued_at").all(runId).map((row: AnyRecord) => ({ ...row, scopes: parse(row.scopes_json, []), resourceConstraints: parse(row.constraints_json, {}) })); }
}

function walkFiles(root: string, current = root, output: string[] = []): string[] { if (!existsSync(current)) return output; const st = lstatSync(current); if (st.isSymbolicLink()) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "symlinks are not snapshot-safe", { path: current }); if (st.isFile()) { output.push(current); return output; } for (const entry of readdirSync(current)) walkFiles(root, join(current, entry), output); return output; }
function rejectSymbolicPath(root: string, target: string) {
  const base = resolve(root);
  let cursor = resolve(target);
  while (cursor !== base && isWithin(base, cursor)) {
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "symlinks are not snapshot-safe", { path: relative(base, cursor) });
    } catch (error) {
      if (error instanceof OdinnRuntimeError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    cursor = dirname(cursor);
  }
}

export class SnapshotManager {
  [key: string]: any;
  constructor({ ledger, featureFlags = {}, maxFiles = 10_000, maxBytes = 256 * 1024 * 1024 }: AnyRecord = {}) {
    this.ledger = ledger;
    this.featureFlags = featureFlags;
    this.maxFiles = maxFiles;
    this.maxBytes = maxBytes;
  }
  create({ runId, stepId, paths = [], label, workspaceRoot = currentWorkingDirectory() }: AnyRecord = {}) {
    if (!this.ledger.getRun(runId)) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot run not found", { runId });
    if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== "string" || !path.trim())) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot paths must contain at least one non-empty path");
    const requestedPaths = [...new Set(paths)];
    if (requestedPaths.length !== paths.length) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot paths must be unique");
    const root = resolve(workspaceRoot);
    const normalizedPaths = requestedPaths.map((path) => relative(root, safePath(root, path)));
    if (normalizedPaths.some((path, index) => normalizedPaths.some((other, otherIndex) => index !== otherIndex && isWithin(resolve(root, other), resolve(root, path))))) {
      throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot paths must not overlap");
    }
    const snapshotId = `snap_${randomUUID()}`;
    const entriesByPath = new Map<string, AnyRecord>();
    const roots: AnyRecord[] = [];
    let totalBytes = 0;
    for (const relativePath of requestedPaths) {
      const target = safeExistingPath(root, relativePath);
      if (isWithin(target, this.ledger.stateDir) || isWithin(this.ledger.stateDir, target)) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot paths cannot include the Odinn state directory", { path: relativePath });
      rejectSymbolicPath(root, target);
      roots.push({
        path: relative(root, target),
        existed: existsSync(target),
        type: existsSync(target) && lstatSync(target).isDirectory() ? "directory" : existsSync(target) ? "file" : "missing",
        mode: existsSync(target) ? lstatSync(target).mode : null
      });
      for (const path of walkFiles(root, target)) {
        const rel = relative(root, path);
        if (entriesByPath.has(rel)) continue;
        const bytes = readFileSync(path);
        totalBytes += bytes.byteLength;
        if (entriesByPath.size + 1 > this.maxFiles) throw new OdinnRuntimeError("BUDGET_EXCEEDED", "snapshot exceeds the file limit", { maxFiles: this.maxFiles });
        if (totalBytes > this.maxBytes) throw new OdinnRuntimeError("BUDGET_EXCEEDED", "snapshot exceeds the byte limit", { maxBytes: this.maxBytes });
        const artifact = this.ledger.artifacts.put(bytes);
        entriesByPath.set(rel, { path: rel, existed: true, mode: lstatSync(path).mode, digest: hash(bytes), artifactDigest: artifact.digest });
      }
      if (!existsSync(target)) entriesByPath.set(relativePath, { path: relativePath, existed: false });
    }
    const entries = [...entriesByPath.values()];
    const createdAt = now(); this.ledger.database.transaction((db: any) => { db.prepare("INSERT INTO snapshots(id, run_id, step_id, label, workspace_root, manifest_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(snapshotId, runId, stepId ?? null, label ?? null, resolve(workspaceRoot), json({ roots, totalBytes, entries: entries.map((entry) => ({ path: entry.path, existed: entry.existed, digest: entry.digest, artifactDigest: entry.artifactDigest })) }), createdAt); for (const entry of entries) db.prepare("INSERT INTO snapshot_entries(id, snapshot_id, path, existed, mode, digest, artifact_digest) VALUES (?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), snapshotId, entry.path, entry.existed ? 1 : 0, entry.mode ?? null, entry.digest ?? null, entry.artifactDigest ?? null); }); this.ledger.appendEvent({ runId, type: "snapshot", payload: { snapshotId, label, entries: entries.length, totalBytes } }); return { snapshotId, entries, roots, totalBytes };
  }
  plan(snapshotId: string): AnyRecord { const snapshot = this.ledger.database.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(snapshotId) as AnyRecord | undefined; if (!snapshot) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot not found"); const manifest = parse(snapshot.manifest_json, {}); return { snapshotId, workspaceRoot: snapshot.workspace_root, roots: Array.isArray(manifest.roots) ? manifest.roots : [], entries: this.ledger.database.db.prepare("SELECT * FROM snapshot_entries WHERE snapshot_id = ? ORDER BY path").all(snapshotId) }; }
  restore(snapshotId: string, { apply = false, runId }: AnyRecord = {}) {
    const plan = this.plan(snapshotId);
    const prepared = plan.entries.map((entry: AnyRecord) => {
      const target = safeExistingPath(plan.workspaceRoot, entry.path);
      rejectSymbolicPath(plan.workspaceRoot, target);
      if (!entry.existed) return { entry, target };
      if (typeof entry.artifact_digest !== "string" || !/^[a-f0-9]{64}$/.test(entry.artifact_digest)) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot entry has an invalid artifact digest", { path: entry.path });
      const artifactPath = join(this.ledger.artifacts.root, "sha256", entry.artifact_digest.slice(0, 2), entry.artifact_digest);
      if (!isWithin(this.ledger.artifacts.root, artifactPath) || !existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot artifact is missing", { path: entry.path, digest: entry.artifact_digest });
      const bytes = readFileSync(artifactPath);
      const actualDigest = hash(bytes);
      if (actualDigest !== entry.artifact_digest || (entry.digest && actualDigest !== entry.digest)) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot artifact failed integrity verification", { path: entry.path, expected: entry.artifact_digest, actual: actualDigest });
      return { entry, target, bytes };
    });
    const actions: AnyRecord[] = [];
    const snapshotRow = this.ledger.database.db.prepare("SELECT run_id FROM snapshots WHERE id = ?").get(snapshotId) as AnyRecord;
    let recoverySnapshotId;
    if (!apply) {
      for (const item of prepared) actions.push({ path: item.entry.path, action: item.entry.existed ? "restore" : "remove" });
    } else {
      const recoveryPaths = plan.roots.length ? plan.roots.map((root: AnyRecord) => root.path) : plan.entries.map((entry: AnyRecord) => entry.path);
      const recovery = this.create({
        runId: runId ?? snapshotRow.run_id,
        stepId: `recovery:${snapshotId}`,
        paths: recoveryPaths,
        label: `Automatic recovery point before restoring ${snapshotId}`,
        workspaceRoot: plan.workspaceRoot
      });
      recoverySnapshotId = recovery.snapshotId;

      const present = (path: string) => {
        try { lstatSync(path); return true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
      };
      const staged: Array<{ target: string; stage?: string; backup: string; existed: boolean }> = [];
      try {
        for (const root of plan.roots) {
          const target = safeExistingPath(plan.workspaceRoot, root.path);
          rejectSymbolicPath(plan.workspaceRoot, target);
          const existed = present(target);
          const backup = `${target}.odinn-restore-backup-${process.pid}-${randomUUID()}`;
          const item: { target: string; stage?: string; backup: string; existed: boolean } = { target, backup, existed };
          if (root.existed) {
            const stage = `${target}.odinn-restore-stage-${process.pid}-${randomUUID()}`;
            item.stage = stage;
            if (root.type === "directory") {
              mkdirSync(stage, { recursive: false, mode: root.mode ?? 0o700 });
              for (const preparedItem of prepared) {
                const entry = preparedItem.entry;
                const rootPrefix = root.path ? `${root.path}${sep}` : "";
                if (!entry.existed || (entry.path !== root.path && !entry.path.startsWith(rootPrefix))) continue;
                const stagedPath = entry.path === root.path ? stage : join(stage, relative(root.path, entry.path));
                mkdirSync(dirname(stagedPath), { recursive: true });
                writeFileSync(stagedPath, preparedItem.bytes, { mode: entry.mode ?? 0o600 });
              }
            } else if (root.type === "file") {
              const preparedItem = prepared.find((candidate: AnyRecord) => candidate.entry.path === root.path && candidate.entry.existed);
              if (!preparedItem) throw new OdinnRuntimeError("SNAPSHOT_FAILED", "snapshot file root is missing its artifact", { path: root.path });
              writeFileSync(stage, preparedItem.bytes, { mode: preparedItem.entry.mode ?? 0o600 });
            } else {
              item.stage = undefined;
            }
          }
          staged.push(item);
        }

        for (const item of staged) {
          if (item.existed) renameSync(item.target, item.backup);
          if (item.stage) renameSync(item.stage, item.target);
        }
      } catch (cause) {
        for (const item of [...staged].reverse()) {
          try {
            if (present(item.target)) rmSync(item.target, { recursive: true, force: true });
            if (present(item.backup)) renameSync(item.backup, item.target);
            if (item.stage && present(item.stage)) rmSync(item.stage, { recursive: true, force: true });
          } catch {}
        }
        throw cause;
      }

      for (const item of staged) {
        try { if (present(item.backup)) rmSync(item.backup, { recursive: true, force: true }); } catch {}
      }

      for (const item of prepared) actions.push({ path: item.entry.path, action: item.entry.existed ? "restored" : "removed" });
    }
    this.ledger.appendEvent({ runId: runId ?? snapshotRow.run_id, type: "rollback", payload: { snapshotId, applied: apply, recoverySnapshotId, actions } });
    return { snapshotId, applied: apply, recoverySnapshotId, actions };
  }
}

export class DarwinRouter {
  [key: string]: any;
  constructor({ ledger, featureFlags = {}, weights = {} }: AnyRecord = {}) {
    this.ledger = ledger;
    this.featureFlags = featureFlags;
    this.weights = {
      verified: 0.35,
      partiallyVerified: 0.1,
      reliability: 0.15,
      speed: 0.1,
      cost: 0.1,
      compliance: 0.1,
      rollbackFree: 0.1,
      ...weights
    };
  }
  observe(observation: AnyRecord) {
    for (const field of ["runId", "providerId", "modelId"]) {
      if (typeof observation?.[field] !== "string" || !observation[field].trim()) {
        throw new OdinnRuntimeError("MODEL_ROUTING_UNAVAILABLE", `${field} is required for a model observation`);
      }
    }
    if (!this.ledger.hasRun(observation.runId)) {
      throw new OdinnRuntimeError("MODEL_ROUTING_UNAVAILABLE", "observation run not found", { runId: observation.runId });
    }
    const metric = (name: string, fallback = 0) => {
      const value = Number(observation[name] ?? fallback);
      if (!Number.isFinite(value) || value < 0) throw new OdinnRuntimeError("MODEL_ROUTING_UNAVAILABLE", `${name} must be a non-negative number`);
      return value;
    };
    const item = {
      id: observation.id ?? randomUUID(),
      runId: observation.runId,
      providerId: observation.providerId,
      modelId: observation.modelId,
      taskClass: observation.taskClass ?? "general",
      verified: Boolean(observation.verified),
      partiallyVerified: Boolean(observation.partiallyVerified),
      costUsd: observation.costUsd === undefined || observation.costUsd === null ? null : metric("costUsd"),
      durationMs: metric("durationMs"),
      toolCalls: metric("toolCalls"),
      toolErrors: metric("toolErrors"),
      retries: metric("retries"),
      policyViolations: metric("policyViolations"),
      rolledBack: Boolean(observation.rolledBack),
      createdAt: now()
    };
    this.ledger.database.db.prepare("INSERT INTO model_observations(id, run_id, provider_id, model_id, task_class, verified, partially_verified, cost_usd, duration_ms, tool_calls, tool_errors, retries, policy_violations, rolled_back, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(item.id, item.runId, item.providerId, item.modelId, item.taskClass, item.verified ? 1 : 0, item.partiallyVerified ? 1 : 0, item.costUsd, item.durationMs, item.toolCalls, item.toolErrors, item.retries, item.policyViolations, item.rolledBack ? 1 : 0, item.createdAt);
    try {
      this.ledger.appendEvent({
        runId: item.runId,
        type: "model-observation",
        payload: {
          observationId: item.id,
          providerId: item.providerId,
          modelId: item.modelId,
          taskClass: item.taskClass,
          verified: item.verified,
          partiallyVerified: item.partiallyVerified,
          costUsd: item.costUsd,
          durationMs: item.durationMs,
          toolCalls: item.toolCalls,
          toolErrors: item.toolErrors,
          retries: item.retries,
          policyViolations: item.policyViolations,
          rolledBack: item.rolledBack
        }
      });
    } catch (error) {
      this.ledger.database.db.prepare("DELETE FROM model_observations WHERE id = ?").run(item.id);
      throw error;
    }
    return item;
  }
  stats(taskClass = "general") {
    const rows = this.ledger.database.db.prepare("SELECT provider_id, model_id, AVG(verified) verified, AVG(partially_verified) partially_verified, AVG(tool_errors = 0) reliability, AVG(duration_ms) duration, AVG(cost_usd) cost, AVG(policy_violations = 0) compliance, AVG(rolled_back = 0) rollback_free, COUNT(*) observations FROM model_observations WHERE task_class = ? GROUP BY provider_id, model_id").all(taskClass) as AnyRecord[];
    const maxDuration = Math.max(...rows.map((row: AnyRecord) => Number(row.duration)), 1);
    const knownCosts = rows.map((row: AnyRecord) => row.cost).filter((value) => value !== null).map(Number);
    const maxCost = Math.max(...knownCosts, 0.000001);
    return rows.map((row: AnyRecord) => ({
      ...row,
      score: Number(row.verified) * this.weights.verified
        + Number(row.partially_verified) * this.weights.partiallyVerified
        + Number(row.reliability) * this.weights.reliability
        + (1 - Number(row.duration) / maxDuration) * this.weights.speed
        + (row.cost === null ? 0 : 1 - Number(row.cost) / maxCost) * this.weights.cost
        + Number(row.compliance) * this.weights.compliance
        + Number(row.rollback_free) * this.weights.rollbackFree,
      uncertaintyPenalty: 1 / Math.sqrt(Math.max(Number(row.observations), 1))
    }));
  }
  recordDecision({ runId, taskClass = "general", model, source, reason, candidates = [] }: AnyRecord) {
    if (!runId) return;
    if (!this.ledger.hasRun(runId)) throw new OdinnRuntimeError("MODEL_ROUTING_UNAVAILABLE", "routing decision run not found", { runId });
    this.recordDecisionForExistingRun({ runId, taskClass, model, source, reason, candidates });
  }
  private recordDecisionForExistingRun({ runId, taskClass = "general", model, source, reason, candidates = [] }: AnyRecord) {
    this.ledger.appendEvent({
      runId,
      type: "model-routing-decision",
      payload: {
        taskClass,
        model,
        source,
        reason,
        candidates: candidates.map((candidate: AnyRecord) => ({
          providerId: candidate.provider_id,
          modelId: candidate.model_id,
          observations: Number(candidate.observations),
          score: Number(candidate.score),
          uncertaintyPenalty: Number(candidate.uncertaintyPenalty),
          adjustedScore: Number(candidate.adjustedScore)
        }))
      }
    });
  }
  choose(taskClass = "general", { pinnedModel, availableModels = [], runId }: AnyRecord = {}) {
    const decisionRunId = runId ?? `routing-${randomUUID()}`;
    if (!this.ledger.hasRun(decisionRunId)) this.ledger.ensureRun({ runId: decisionRunId, objective: `choose a model for ${taskClass}` });
    if (pinnedModel) {
      const result = { model: pinnedModel, reason: "user-pinned model", source: "pinned", taskClass, runId: decisionRunId };
      this.recordDecisionForExistingRun({ runId: decisionRunId, taskClass, model: result.model, source: result.source, reason: result.reason });
      return result;
    }
    const available = new Set(Array.isArray(availableModels) ? availableModels : []);
    const stats: AnyRecord[] = this.stats(taskClass)
      .filter((row: AnyRecord) => !available.size || available.has(`${row.provider_id}:${row.model_id}`))
      .map((row: AnyRecord) => ({ ...row, adjustedScore: row.score - row.uncertaintyPenalty }));
    stats.sort((a: AnyRecord, b: AnyRecord) => b.adjustedScore - a.adjustedScore);
    if (!stats[0]) {
      this.recordDecisionForExistingRun({ runId: decisionRunId, taskClass, model: null, source: "unavailable", reason: "no applicable observations for task class" });
      throw new OdinnRuntimeError("MODEL_ROUTING_UNAVAILABLE", "no observations for task class", { taskClass, runId: decisionRunId });
    }
    const result = {
      model: `${stats[0].provider_id}:${stats[0].model_id}`,
      taskClass,
      runId: decisionRunId,
      score: stats[0].adjustedScore,
      source: "darwin",
      explanation: `selected from ${stats[0].observations} observed runs; verified=${Number(stats[0].verified).toFixed(2)}, reliability=${Number(stats[0].reliability).toFixed(2)}`,
      candidates: stats
    };
    this.recordDecisionForExistingRun({ runId: decisionRunId, taskClass, model: result.model, source: result.source, reason: result.explanation, candidates: stats });
    return result;
  }
}

export class CapsuleManager {
  [key: string]: any;
  constructor({ ledger, stateDir, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; this.root = join(this.stateDir, "capsules"); mkdirSync(this.root, { recursive: true }); }
  async export(runId: string, { output, contract, policy, replayMode = "verification-only" }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "capsules", this.ledger);
    if (!output) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output is required");
    const run = this.ledger.getRun(runId); if (!run) throw new OdinnRuntimeError("CAPSULE_INVALID", "run not found", { runId });
    const destination = resolve(output);
    const allowedRoots = [this.root, this.ledger.workspaceRoot].map((root) => resolve(root));
    const allowedRoot = allowedRoots.find((root) => isWithin(root, destination));
    if (!allowedRoot) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output must remain inside the workspace or .odinn/capsules directory", { output });
    assertCapsuleExportPath(allowedRoot, destination);
    const staging = join(this.root, `.staging-${randomUUID()}`); mkdirSync(join(staging, "artifacts"), { recursive: true }); mkdirSync(join(staging, "snapshots"), { recursive: true }); mkdirSync(join(staging, "verification"), { recursive: true });
    try {
      const storedContract = this.ledger.database.db.prepare("SELECT contract_json FROM verification_contracts WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(runId);
      const storedPolicy = this.ledger.database.db.prepare("SELECT policy_json FROM policies WHERE run_id = ? ORDER BY created_at DESC LIMIT 1").get(runId);
      const effectiveContract = contract ?? parse(storedContract?.contract_json, null);
      const effectivePolicy = policy ?? parse(storedPolicy?.policy_json, null);
      const manifest = { formatVersion: 1, odinnVersion: odinnVersion(), runId, createdAt: now(), sourcePlatform: `${process.platform}-${process.arch}`, model: { provider: run.providerId, modelId: run.modelId }, replayMode, redactions: ["api keys", "tokens", "cookies", "authorization headers", "tool-declared sensitive input"], requiredSecrets: [], checksumsFile: "checksums.sha256" };
      writeFileSync(join(staging, "manifest.json"), `${json(manifest)}\n`);
      writeFileSync(join(staging, "environment.json"), `${json({ platform: process.platform, arch: process.arch, node: process.version })}\n`);
      writeFileSync(join(staging, "README.txt"), "This Odinn Forge capsule is content-addressed, redacted, and safe to inspect before replay.\n");
      if (effectiveContract) writeFileSync(join(staging, "contract.json"), `${json(redact(effectiveContract))}\n`);
      if (effectivePolicy) writeFileSync(join(staging, "policy.json"), `${json(redact(effectivePolicy))}\n`);
      const referenced = this.referencedArtifactRows(runId);
      const artifactContexts = this.artifactRedactionContexts(runId);
      const capsuleDigests = new Map<string, string>();
      for (const artifact of referenced) {
        const source = resolve(this.ledger.artifacts.root, artifact.path);
        if (!source.startsWith(`${resolve(this.ledger.artifacts.root)}${sep}`) || !existsSync(source)) continue;
        const context = artifactContexts.get(artifact.digest) ?? {};
        const bytes = redactArtifactBytes(readFileSync(source), context);
        const safeDigest = hash(bytes);
        capsuleDigests.set(artifact.digest, safeDigest);
        writeFileSync(join(staging, "artifacts", safeDigest), bytes);
      }
      const capsuleRun = replaceCapsuleDigests(redact(run), capsuleDigests);
      writeFileSync(join(staging, "run.json"), `${json(capsuleRun)}\n`);
      writeFileSync(join(staging, "events.jsonl"), `${(capsuleRun.events ?? []).map((event: AnyRecord) => json(event)).join("\n")}\n`);
      const verification = this.ledger.database.db.prepare("SELECT * FROM assertion_results WHERE run_id = ? ORDER BY completed_at").all(runId).map((row: AnyRecord) => replaceCapsuleDigests(redact({ ...row, evidenceArtifactIds: parse(row.evidence_artifact_ids_json, []), result: parse(row.result_json) }), capsuleDigests));
      writeFileSync(join(staging, "verification", "results.json"), `${json(verification)}\n`);
      const snapshots = this.ledger.database.db.prepare("SELECT * FROM snapshots WHERE run_id = ? ORDER BY created_at").all(runId).map((row: AnyRecord) => replaceCapsuleDigests(redact({ ...row, manifest: parse(row.manifest_json, {}) }), capsuleDigests));
      writeFileSync(join(staging, "snapshots", "index.json"), `${json(snapshots)}\n`);
      const files: string[] = []; for (const entryName of readdirSync(staging, { recursive: true })) { const name = String(entryName); if (name === "checksums.sha256") continue; const file = join(staging, name); if (lstatSync(file).isFile()) files.push(name.replaceAll("\\", "/")); }
      writeFileSync(join(staging, "checksums.sha256"), `${files.sort().map((name) => `${hash(readFileSync(join(staging, name)))}  ${name}`).join("\n")}\n`);
      const archiveEntries: Record<string, Uint8Array> = {};
      let expandedBytes = 0;
      for (const entryName of readdirSync(staging, { recursive: true })) {
        const name = String(entryName).replaceAll("\\", "/");
        const file = join(staging, String(entryName));
        if (!lstatSync(file).isFile()) continue;
        if (Object.keys(archiveEntries).length >= CAPSULE_MAX_ENTRIES) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule archive exceeds the ${CAPSULE_MAX_ENTRIES}-entry limit`);
        const bytes = readFileSync(file);
        if (bytes.byteLength > CAPSULE_MAX_ENTRY_BYTES) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule entry exceeds the ${CAPSULE_MAX_ENTRY_BYTES}-byte expanded-size limit`, { name });
        expandedBytes += bytes.byteLength;
        if (expandedBytes > CAPSULE_MAX_EXPANDED_BYTES) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule archive exceeds the ${CAPSULE_MAX_EXPANDED_BYTES}-byte expanded-size limit`);
        archiveEntries[name] = bytes;
      }
      const compressed = Buffer.from(zipSync(archiveEntries, { level: 9 }));
      if (compressed.byteLength > CAPSULE_MAX_ARCHIVE_BYTES) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule archive exceeds the ${CAPSULE_MAX_ARCHIVE_BYTES}-byte compressed-size limit`);
      const { physicalBase, physicalDestination } = physicalCapsuleExportPath(allowedRoot, destination);
      let descriptor: number | undefined;
      let created = false;
      let createdIdentity: { dev: number; ino: number } | undefined;
      try {
        descriptor = openSync(physicalDestination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        created = true;
        writeFileSync(descriptor, compressed);
        fsyncSync(descriptor);
        createdIdentity = fstatSync(descriptor);
        const currentIdentity = lstatSync(physicalDestination);
        const written = resolve(realpathSync(physicalDestination));
        const lexical = resolve(realpathSync(destination));
        if (!isWithin(physicalBase, written) || lexical !== written || !currentIdentity.isFile() || currentIdentity.dev !== createdIdentity.dev || currentIdentity.ino !== createdIdentity.ino) {
          throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule output parent changed during export", { output });
        }
        closeSync(descriptor);
        descriptor = undefined;
      } catch (error) {
        if (descriptor !== undefined) {
          try { closeSync(descriptor); } catch {}
        }
        if (created) {
          try {
            const currentIdentity = lstatSync(physicalDestination);
            if (!createdIdentity || currentIdentity.dev === createdIdentity.dev && currentIdentity.ino === createdIdentity.ino) rmSync(physicalDestination, { force: true });
          } catch {}
        }
        throw error;
      }
      const digest = hash(compressed); this.ledger.database.db.prepare("INSERT OR REPLACE INTO capsules(id, run_id, path, manifest_json, digest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`capsule_${randomUUID()}`, runId, destination, json(manifest), digest, now()); this.ledger.appendEvent({ runId, type: "artifact-created", payload: { kind: "capsule", path: destination, digest } }); return { path: destination, digest, manifest };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  referencedArtifactRows(runId: string) {
    const digests = new Set();
    const run = this.ledger.getRun(runId);
    for (const event of run?.events ?? []) for (const key of ["inputDigest", "outputDigest", "contractDigest"]) if (typeof event.payload?.[key] === "string") digests.add(event.payload[key]);
    for (const row of this.ledger.database.db.prepare("SELECT evidence_artifact_ids_json FROM assertion_results WHERE run_id = ?").all(runId)) for (const digest of parse(row.evidence_artifact_ids_json, [])) if (typeof digest === "string") digests.add(digest);
    for (const row of this.ledger.database.db.prepare("SELECT se.artifact_digest FROM snapshot_entries se JOIN snapshots s ON s.id = se.snapshot_id WHERE s.run_id = ? AND se.artifact_digest IS NOT NULL").all(runId)) digests.add(row.artifact_digest);
    return [...digests].map((digest) => this.ledger.database.db.prepare("SELECT digest, path FROM artifacts WHERE digest = ?").get(digest)).filter(Boolean);
  }
  artifactRedactionContexts(runId: string) {
    const contexts = new Map<string, { toolName?: string; input?: boolean }>();
    const steps = this.ledger.database.db.prepare("SELECT input_digest, output_digest, metadata_json FROM run_steps WHERE run_id = ?").all(runId);
    const addContext = (digest: unknown, context: { toolName?: string; input?: boolean }) => {
      if (typeof digest !== "string") return;
      const prior = contexts.get(digest);
      contexts.set(digest, {
        toolName: context.toolName ?? prior?.toolName,
        input: context.input === true || prior?.input === true
      });
    };
    for (const step of steps) {
      const metadata = parse(step.metadata_json, {});
      const toolName = typeof metadata.toolName === "string" ? metadata.toolName : undefined;
      addContext(step.input_digest, { toolName, input: true });
      addContext(step.output_digest, { toolName });
    }
    return contexts;
  }
  async verify(path: string) {
    requireExperimental(this.featureFlags, "capsules", this.ledger);
    const archive = resolve(path);
    if (!existsSync(archive)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule not found");
    const recorded = this.ledger.database.db.prepare("SELECT digest FROM capsules WHERE path = ? ORDER BY created_at DESC LIMIT 1").get(archive);
    if (recorded && recorded.digest !== hash(capsuleArchiveBytes(archive))) throw new OdinnRuntimeError("CAPSULE_TAMPERED", "capsule archive digest changed", { path: archive });
    const entries = capsuleArchiveEntries(archive);
    const normalizedNames = [...entries.keys()];
    const seenNames = new Set<string>();
    for (const name of normalizedNames) {
      const segments = name.split("/").filter(Boolean);
      if (!name || name.endsWith("/") || name.startsWith("/") || name.includes("\0") || /^[A-Za-z]:/.test(name) || segments.some((segment) => segment === "." || segment === "..") || seenNames.has(name)) throw new OdinnRuntimeError("CAPSULE_INVALID", "capsule contains an unsafe or duplicate path", { name });
      seenNames.add(name);
    }
    const required = ["manifest.json", "run.json", "events.jsonl", "environment.json", "checksums.sha256"];
    for (const name of required) if (!seenNames.has(name)) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule is missing ${name}`);
    const manifest = parse(capsuleEntryText(entries, "manifest.json"), null);
    if (!manifest || manifest.formatVersion !== 1) throw new OdinnRuntimeError("CAPSULE_INVALID", "unsupported capsule version");
    const checksumLines = capsuleEntryText(entries, "checksums.sha256").split(/\r?\n/).filter(Boolean);
    const checksummed = new Set<string>();
    const failures: string[] = [];
    for (const line of checksumLines) {
      const match = line.match(/^([a-f0-9]{64})  (.+)$/);
      const name = match?.[2]?.replaceAll("\\", "/");
      const entry = name ? entries.get(name) : undefined;
      if (!match || !name || checksummed.has(name) || !seenNames.has(name) || name === "checksums.sha256" || !entry || hash(entry) !== match[1]) failures.push(name ?? line);
      else checksummed.add(name);
    }
    for (const name of normalizedNames) if (name !== "checksums.sha256" && !checksummed.has(name)) failures.push(name);
    if (failures.length) throw new OdinnRuntimeError("CAPSULE_TAMPERED", "capsule checksum verification failed", { failures: [...new Set(failures)] });
    return { valid: true, manifest, entries: normalizedNames };
  }
  async replay(path: string, { mode = "verification-only", workspace, executor, approveExternal = false }: AnyRecord = {}) {
    const verified = await this.verify(path);
    const entries = capsuleArchiveEntries(resolve(path));
    if (!["verification-only", "tool-mocked", "full"].includes(mode)) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", `unsupported replay mode: ${mode}`);
    if (mode === "full") {
      if (!workspace) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", "full replay requires a disposable workspace");
      if (typeof executor !== "function") throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", "full replay requires an audited task executor");
      const target = resolve(workspace);
      if (target === resolve(this.ledger.workspaceRoot)) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", "full replay refuses the original workspace");
      mkdirSync(target, { recursive: true });
      const sourceRun = parse(capsuleEntryText(entries, "run.json"), null);
      const requests = capsuleEntryText(entries, "events.jsonl").split(/\r?\n/).filter(Boolean).map((line) => parse(line, null)).filter((event) => event?.type === "tool-request");
      const replayRunId = `replay_${randomUUID()}`;
      this.ledger.ensureRun({ runId: replayRunId, objective: `full replay of ${sourceRun?.id ?? verified.manifest.runId}`, workspaceRoot: target });
      this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-started", payload: { sourceRunId: sourceRun?.id ?? verified.manifest.runId, mode, taskCount: requests.length } });
      const results = [];
      for (let index = 0; index < requests.length; index += 1) {
        const event = requests[index];
        const tool = event.payload?.toolName;
        const digest = event.payload?.inputDigest;
        if (!tool || !digest) throw new OdinnRuntimeError("CAPSULE_INVALID", "recorded tool request is missing replay metadata");
        const artifact = entries.get(`artifacts/${digest}`);
        if (!artifact) throw new OdinnRuntimeError("CAPSULE_INVALID", `capsule is missing input artifact ${digest}`);
        if (hash(artifact) !== digest) throw new OdinnRuntimeError("CAPSULE_TAMPERED", `tool ${tool} input artifact does not match its digest`);
        const input = parse(artifact.toString("utf8"), null);
        if (!isPlainRecord(input) || containsRedaction(input)) throw new OdinnRuntimeError("REPLAY_UNSUPPORTED", `tool ${tool} requires redacted, missing, or invalid input`);
        const safety = event.payload?.safety ?? {};
        const external = safety.reversibility === "irreversible" || (safety.effects ?? []).some((effect: string) => ["network", "credential", "external-state"].includes(effect));
        if (external && approveExternal !== true) throw new OdinnRuntimeError("CAPABILITY_DENIED", `full replay of external tool ${tool} requires explicit approval`);
        const result = await executor({ tool, input, external, replayRunId, stepIndex: index, workspaceRoot: target, sourceEvent: event });
        results.push({ tool, external, result: redact(result) });
        this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-action", payload: { sourceEventId: event.id, tool, external, result: redact(result) } });
      }
      this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-completed", payload: { sourceRunId: sourceRun?.id ?? verified.manifest.runId, taskCount: results.length } });
      this.ledger.database.db.prepare("UPDATE runs SET status = 'completed-unverified', completed_at = ? WHERE id = ?").run(now(), replayRunId);
      return { ...verified, mode, executed: true, replayRunId, results, message: "recorded actions re-executed through the audited runtime in a disposable workspace" };
    }
    if (mode === "verification-only") return { ...verified, mode, executed: false, contractIncluded: verified.entries.includes("contract.json"), message: "capsule integrity verified; run the included contract against a supplied workspace" };

    const sourceRun = parse(capsuleEntryText(entries, "run.json"), null);
    const recordedEvents = capsuleEntryText(entries, "events.jsonl").split(/\r?\n/).filter(Boolean).map((line) => parse(line, null)).filter(Boolean);
    const replayRunId = `replay_${randomUUID()}`;
    this.ledger.ensureRun({ runId: replayRunId, objective: `tool-mocked replay of ${sourceRun?.id ?? verified.manifest.runId}`, modelId: verified.manifest.model?.modelId ?? "", providerId: verified.manifest.model?.provider ?? "", workspaceRoot: workspace ? resolve(workspace) : this.ledger.workspaceRoot });
    this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-started", payload: { sourceRunId: sourceRun?.id ?? verified.manifest.runId, mode, eventCount: recordedEvents.length } });
    for (const event of recordedEvents) this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-boundary", payload: { sourceEventId: event.id, sourceType: event.type, payload: redact(event.payload ?? event.data ?? {}) } });
    this.ledger.appendEvent({ runId: replayRunId, type: "capsule-replay-completed", payload: { sourceRunId: sourceRun?.id ?? verified.manifest.runId, boundaryCount: recordedEvents.length } });
    this.ledger.database.db.prepare("UPDATE runs SET status = 'completed-unverified', completed_at = ? WHERE id = ?").run(now(), replayRunId);
    return { ...verified, mode, executed: true, replayRunId, boundaryCount: recordedEvents.length, message: "recorded model and tool boundaries replayed without executing external tools" };
  }
}

function assertCounterfactualActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "counterfactual operation was cancelled before durable settlement", { cancelled: true });
}

const COUNTERFACTUAL_PROTECTED_COMPONENTS = new Set([".git", ".odinn", ".odinn-worktrees"]);
const COUNTERFACTUAL_GENERATED_COMPONENTS = new Set([
  ...COUNTERFACTUAL_PROTECTED_COMPONENTS,
  ".cache", ".next", ".pnpm-store", ".turbo", "build", "coverage", "dist", "node_modules"
]);

function physicalCounterfactualPath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function counterfactualRootsOverlap(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  if (isWithin(resolvedLeft, resolvedRight) || isWithin(resolvedRight, resolvedLeft)) return true;
  const physicalLeft = physicalCounterfactualPath(resolvedLeft);
  const physicalRight = physicalCounterfactualPath(resolvedRight);
  return isWithin(physicalLeft, physicalRight) || isWithin(physicalRight, physicalLeft);
}

function assertDisjointCounterfactualRoots(sourceRoot: string, destinationRoot: string): void {
  if (counterfactualRootsOverlap(sourceRoot, destinationRoot)) {
    throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "counterfactual copy source and destination must not contain one another", {
      sourceRoot: resolve(sourceRoot),
      destinationRoot: resolve(destinationRoot)
    });
  }
}

function relativeWorkspaceComponents(root: string, candidate: string): string[] {
  const relativePath = relative(resolve(root), resolve(candidate));
  if (relativePath === "") return [];
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "counterfactual copy escaped its declared root");
  }
  return relativePath.split(sep).filter(Boolean);
}

function counterfactualCopyFilter({
  sourceRoot,
  destinationRoot,
  stateRoot,
  excludedComponents,
  signal
}: {
  sourceRoot: string;
  destinationRoot: string;
  stateRoot: string;
  excludedComponents: ReadonlySet<string>;
  signal?: AbortSignal;
}) {
  const resolvedSourceRoot = resolve(sourceRoot);
  const resolvedDestinationRoot = resolve(destinationRoot);
  const resolvedStateRoot = resolve(stateRoot);
  const stateNestedInSource = isWithin(resolvedSourceRoot, resolvedStateRoot);
  const stateNestedInDestination = isWithin(resolvedDestinationRoot, resolvedStateRoot);
  return (sourcePath: string, destinationPath: string): boolean => {
    assertCounterfactualActive(signal);
    const resolvedSourcePath = resolve(sourcePath);
    const resolvedDestinationPath = resolve(destinationPath);
    const sourceComponents = relativeWorkspaceComponents(resolvedSourceRoot, resolvedSourcePath);
    const destinationComponents = relativeWorkspaceComponents(resolvedDestinationRoot, resolvedDestinationPath);
    if (sourceComponents.some((component) => excludedComponents.has(component))) return false;
    if (destinationComponents.some((component) => excludedComponents.has(component))) return false;
    if (stateNestedInSource && isWithin(resolvedStateRoot, resolvedSourcePath)) return false;
    if (stateNestedInDestination && isWithin(resolvedStateRoot, resolvedDestinationPath)) return false;
    try {
      if (lstatSync(resolvedSourcePath).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return true;
  };
}

function counterfactualWorktreeBase(sourceRoot: string, stateRoot: string): string {
  const stateWorktrees = resolve(stateRoot, "worktrees");
  if (!counterfactualRootsOverlap(sourceRoot, stateWorktrees)) return stateWorktrees;
  const sourceParent = dirname(resolve(sourceRoot));
  if (sourceParent !== resolve(sourceRoot)) {
    return resolve(sourceParent, ".odinn-worktrees", `${basename(sourceRoot)}-${hash(resolve(sourceRoot)).slice(0, 16)}`);
  }
  return resolve(tmpdir(), "odinn-worktrees", hash(resolve(sourceRoot)).slice(0, 16));
}

function counterfactualGroupRoot(sourceRoot: string, stateRoot: string, groupId: string): string {
  return resolve(counterfactualWorktreeBase(sourceRoot, stateRoot), groupId);
}

function authorizedCounterfactualCandidateRoot({
  sourceRoot: sourceRootValue,
  candidateRoot: candidateRootValue,
  stateRoot,
  groupId
}: {
  sourceRoot: string;
  candidateRoot: string;
  stateRoot: string;
  groupId: string;
}): { sourceRoot: string; candidateRoot: string } {
  const sourceRoot = resolve(sourceRootValue);
  const candidateRoot = resolve(candidateRootValue);
  const authorizedGroupRoot = counterfactualGroupRoot(sourceRoot, stateRoot, groupId);
  if (candidateRoot === authorizedGroupRoot || !isWithin(authorizedGroupRoot, candidateRoot)) {
    throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "candidate workspace is not an authorized isolated branch");
  }
  assertDisjointCounterfactualRoots(sourceRoot, candidateRoot);
  return { sourceRoot, candidateRoot };
}

async function copyWorkspaceTree(sourceRoot: string, destinationRoot: string, stateRoot: string, signal?: AbortSignal) {
  assertDisjointCounterfactualRoots(sourceRoot, destinationRoot);
  const filter = counterfactualCopyFilter({
    sourceRoot,
    destinationRoot,
    stateRoot,
    excludedComponents: COUNTERFACTUAL_GENERATED_COMPONENTS,
    signal
  });
  assertCounterfactualActive(signal);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  assertCounterfactualActive(signal);
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  assertCounterfactualActive(signal);
  for (const entry of entries) {
    assertCounterfactualActive(signal);
    await cp(join(sourceRoot, entry.name), join(destinationRoot, entry.name), {
      recursive: true,
      filter
    });
    assertCounterfactualActive(signal);
  }
}

async function copyWorkspaceRollbackBackup(sourceRoot: string, destinationRoot: string, stateRoot: string, signal?: AbortSignal) {
  assertDisjointCounterfactualRoots(sourceRoot, destinationRoot);
  const filter = counterfactualCopyFilter({
    sourceRoot,
    destinationRoot,
    stateRoot,
    excludedComponents: COUNTERFACTUAL_PROTECTED_COMPONENTS,
    signal
  });
  assertCounterfactualActive(signal);
  await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  assertCounterfactualActive(signal);
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  assertCounterfactualActive(signal);
  for (const entry of entries) {
    assertCounterfactualActive(signal);
    await cp(join(sourceRoot, entry.name), join(destinationRoot, entry.name), {
      recursive: true,
      preserveTimestamps: true,
      filter
    });
    assertCounterfactualActive(signal);
  }
}

function validateCounterfactualPlans(plans: unknown): AnyRecord[] {
  if (!Array.isArray(plans) || plans.length < 1 || plans.length > 4) throw new OdinnRuntimeError("BUDGET_EXCEEDED", "counterfactual plans must contain 1-4 candidates");
  const ids = new Set<string>();
  return plans.map((plan, index) => {
    if (!isPlainRecord(plan)) throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${index + 1} must be an object`);
    if (typeof plan.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(plan.id)) throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${index + 1} has an unsafe id`);
    if (ids.has(plan.id)) throw new OdinnRuntimeError("CAPSULE_INVALID", `duplicate counterfactual plan id: ${plan.id}`);
    ids.add(plan.id);
    if (typeof plan.title !== "string" || !plan.title.trim() || plan.title.length > 256 || typeof plan.summary !== "string" || !plan.summary.trim() || plan.summary.length > 4_096) throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${plan.id} requires a bounded title and summary`);
    return plan;
  });
}

export class CounterfactualManager {
  [key: string]: any;
  constructor({ ledger, stateDir, featureFlags = {} }: AnyRecord = {}) { this.ledger = ledger; this.stateDir = resolve(stateDir ?? ".odinn"); this.featureFlags = featureFlags; }
  async create({ sourceRunId, sourceStepId, plans = [], workspaceRoot = currentWorkingDirectory(), signal, __testOnlyAfterWorkspaceCopy }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "counterfactual", this.ledger);
    assertCounterfactualActive(signal);
    const normalizedPlans = validateCounterfactualPlans(plans);
    if (typeof sourceRunId !== "string" || !sourceRunId || typeof sourceStepId !== "string" || !sourceStepId) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual sourceRunId and sourceStepId are required");
    const sourceRun = this.ledger.getRun(sourceRunId);
    if (!sourceRun) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual source run not found", { sourceRunId });
    const sourceRoot = resolve(workspaceRoot);
    const expectedRoot = resolve(sourceRun.workspaceRoot);
    if (sourceRoot !== expectedRoot) throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "counterfactual workspace must match the source run workspace", { expectedRoot, requestedRoot: sourceRoot });
    const groupId = `cf_${randomUUID()}`;
    const groupRoot = counterfactualGroupRoot(sourceRoot, this.stateDir, groupId);
    assertDisjointCounterfactualRoots(sourceRoot, groupRoot);
    const candidates: AnyRecord[] = [];
    const createdRunIds: string[] = [];
    assertCounterfactualActive(signal);
    this.ledger.database.db.prepare("INSERT INTO counterfactual_groups(id, source_run_id, status, created_at) VALUES (?, ?, 'created', ?)").run(groupId, sourceRunId, now());
    try {
      for (const plan of normalizedPlans) {
        assertCounterfactualActive(signal);
        const runId = `run_${randomUUID()}`;
        const branchRoot = resolve(groupRoot, plan.id);
        if (!isWithin(groupRoot, branchRoot) || branchRoot === groupRoot) throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "counterfactual branch escaped its group directory", { planId: plan.id });
        await copyWorkspaceTree(sourceRoot, branchRoot, this.stateDir, signal);
        await __testOnlyAfterWorkspaceCopy?.({ groupId, planId: plan.id, branchRoot });
        assertCounterfactualActive(signal);
        this.ledger.ensureRun({ runId, parentRunId: sourceRunId, branchPointStepId: sourceStepId, objective: plan.summary, workspaceRoot: branchRoot });
        createdRunIds.push(runId);
        this.ledger.database.db.prepare("INSERT INTO run_branches(id, source_run_id, source_step_id, child_run_id, label, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(`branch_${randomUUID()}`, sourceRunId, sourceStepId, runId, plan.title, now());
        this.ledger.database.db.prepare("INSERT INTO counterfactual_candidates(id, group_id, run_id, plan_json, status) VALUES (?, ?, ?, ?, 'created')").run(`candidate_${randomUUID()}`, groupId, runId, json(redact(plan)));
        candidates.push({ runId, plan, workspaceRoot: branchRoot });
      }
      assertCounterfactualActive(signal);
      this.ledger.appendEvent({ runId: sourceRunId, type: "branch-created", payload: { groupId, candidates: candidates.map((candidate) => ({ runId: candidate.runId, title: candidate.plan.title })) } });
      return { groupId, candidates };
    } catch (error) {
      this.ledger.database.transaction((db: any) => {
        db.prepare("DELETE FROM counterfactual_candidates WHERE group_id = ?").run(groupId);
        for (const runId of createdRunIds) {
          db.prepare("DELETE FROM run_branches WHERE child_run_id = ?").run(runId);
          db.prepare("DELETE FROM runs WHERE id = ?").run(runId);
        }
        db.prepare("DELETE FROM counterfactual_groups WHERE id = ?").run(groupId);
      });
      await rm(groupRoot, { recursive: true, force: true });
      throw error;
    }
  }
  async execute(groupId: string, { executor, proof, capabilities, policy, workspaceRoot = this.ledger.workspaceRoot, signal }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "counterfactual", this.ledger);
    assertCounterfactualActive(signal);
    if (typeof executor !== "function") throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual execution requires an executor");
    const rows = this.ledger.database.db.prepare("SELECT c.*, r.workspace_root, parent.workspace_root AS source_root FROM counterfactual_candidates c JOIN runs r ON r.id = c.run_id JOIN counterfactual_groups g ON g.id = c.group_id JOIN runs parent ON parent.id = g.source_run_id WHERE c.group_id = ? ORDER BY c.id").all(groupId);
    if (!rows.length) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual group not found");
    for (const row of rows) {
      authorizedCounterfactualCandidateRoot({
        sourceRoot: row.source_root,
        candidateRoot: row.workspace_root,
        stateRoot: this.stateDir,
        groupId
      });
    }
    const results = [];
    for (const row of rows) {
      assertCounterfactualActive(signal);
      const plan = parse(row.plan_json, {});
      const startedAt = now();
      this.ledger.database.db.prepare("UPDATE counterfactual_candidates SET status = 'executing' WHERE run_id = ?").run(row.run_id);
      this.ledger.database.db.prepare("UPDATE runs SET status = 'executing', started_at = ? WHERE id = ?").run(startedAt, row.run_id);
      this.ledger.appendEvent({ runId: row.run_id, type: "counterfactual-started", payload: { groupId, planId: plan.id } });
      const taskResults = [];
      try {
        if (!Array.isArray(plan.tasks) || plan.tasks.length === 0 || plan.tasks.length > 32) {
          throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${plan.id} must contain 1-32 executable tasks`);
        }
        for (let index = 0; index < plan.tasks.length; index += 1) {
          assertCounterfactualActive(signal);
          const task = plan.tasks[index];
          const taskId = `${row.run_id}:task:${index + 1}`;
          if (!task || typeof task.tool !== "string" || !task.tool) throw new OdinnRuntimeError("CAPSULE_INVALID", `counterfactual plan ${plan.id} task ${index} requires a tool`);
          this.ledger.ensureRun({ runId: taskId, parentRunId: row.run_id, objective: task.reason ?? `counterfactual task ${index + 1}`, workspaceRoot: row.workspace_root });
          const executableTask = { ...task, input: { ...(task.input ?? {}) } };
          if (task.readOnly === true && capabilities && this.featureFlags.capabilities === true && !executableTask.input.capabilityToken) {
            const issued = capabilities.issue({ runId: taskId, stepId: taskId, toolName: task.tool, scopes: ["read"], expiresInMs: 300_000, maxUses: 1 });
            executableTask.input.capabilityToken = issued.token;
          }
          const result = await executor({
            ...executableTask,
            id: taskId,
            actor: "counterfactual",
            reason: `counterfactual:${groupId}:${plan.id}`
          }, { workspaceRoot: row.workspace_root, policy, signal });
          assertCounterfactualActive(signal);
          taskResults.push(redact(result));
        }
        let proofResult;
        if (plan.contract) {
          assertCounterfactualActive(signal);
          if (!proof) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual plan includes a contract but no proof engine was supplied");
          const contract = { ...plan.contract, runId: row.run_id };
          proofResult = await proof.run(row.run_id, contract, { workspaceRoot: row.workspace_root, signal });
          assertCounterfactualActive(signal);
          if (proofResult.status === "failed" || proofResult.passed === false) throw new OdinnRuntimeError("VERIFICATION_FAILED", `counterfactual plan ${plan.id} failed Proof verification`, { proof: proofResult });
        }
        const verified = proofResult && (proofResult.status === "passed" || proofResult.status === "verified" || proofResult.passed === true);
        const resultStatus = verified ? "verified" : proofResult?.status ?? "completed-unverified";
        assertCounterfactualActive(signal);
        this.ledger.database.db.prepare("UPDATE counterfactual_candidates SET status = ? WHERE run_id = ?").run(verified ? "verified" : "completed", row.run_id);
        this.ledger.database.db.prepare("UPDATE runs SET status = ?, completed_at = ? WHERE id = ?").run(resultStatus, now(), row.run_id);
        this.ledger.appendEvent({ runId: row.run_id, type: "counterfactual-completed", payload: { groupId, planId: plan.id, proof: resultStatus, taskCount: taskResults.length } });
        results.push({ runId: row.run_id, planId: plan.id, status: resultStatus, tasks: taskResults, proof: proofResult });
      } catch (error) {
        // Request cancellation leaves the already-started candidate visibly
        // non-terminal. The Gateway shutdown journal owns that quarantine;
        // converting it into an ordinary failure or advancing the group would
        // falsely claim a settled outcome after the stop barrier fired.
        assertCounterfactualActive(signal);
        const failure = error instanceof OdinnRuntimeError ? error : new OdinnRuntimeError("RUNTIME_ERROR", failureMessage(error));
        this.ledger.database.db.prepare("UPDATE counterfactual_candidates SET status = 'failed' WHERE run_id = ?").run(row.run_id);
        this.ledger.database.db.prepare("UPDATE runs SET status = 'failed', completed_at = ? WHERE id = ?").run(now(), row.run_id);
        this.ledger.appendEvent({ runId: row.run_id, type: "counterfactual-failed", payload: { groupId, planId: plan.id, code: failure.code, message: failure.message } });
        results.push({ runId: row.run_id, planId: plan.id, status: "failed", error: { code: failure.code, message: failure.message } });
      }
    }
    assertCounterfactualActive(signal);
    this.ledger.database.db.prepare("UPDATE counterfactual_groups SET status = 'executed' WHERE id = ?").run(groupId);
    return { groupId, results };
  }
  compare(groupId: string) { requireExperimental(this.featureFlags, "counterfactual", this.ledger); const rows = this.ledger.database.db.prepare("SELECT c.*, c.status AS candidate_status, r.status AS run_status, r.workspace_root FROM counterfactual_candidates c JOIN runs r ON r.id = c.run_id WHERE c.group_id = ? ORDER BY c.id").all(groupId) as AnyRecord[]; return { groupId, candidates: rows.map((row: AnyRecord) => ({ ...row, status: row.candidate_status, runStatus: row.run_status, plan: parse(row.plan_json), proof: this.ledger.database.db.prepare("SELECT status, COUNT(*) count FROM assertion_results WHERE run_id = ? GROUP BY status").all(row.run_id) })) }; }
  async commit(groupId: string, runId: string, { apply = false, signal, __testOnlyAfterBackup, __testOnlyAfterActivation }: AnyRecord = {}) {
    requireExperimental(this.featureFlags, "counterfactual", this.ledger);
    assertCounterfactualActive(signal);
    const candidate = this.ledger.database.db.prepare("SELECT c.*, r.workspace_root AS candidate_root, parent.workspace_root AS source_root FROM counterfactual_candidates c JOIN runs r ON r.id = c.run_id JOIN runs parent ON parent.id = (SELECT source_run_id FROM counterfactual_groups WHERE id = c.group_id) WHERE c.group_id = ? AND c.run_id = ?").get(groupId, runId) as AnyRecord | undefined;
    if (!candidate) throw new OdinnRuntimeError("CAPSULE_INVALID", "counterfactual candidate not found");
    if (candidate.status !== "completed" && candidate.status !== "verified" && candidate.status !== "completed-unverified") throw new OdinnRuntimeError("WORKSPACE_CONFLICT", "only a completed candidate can be selected", { status: candidate.status });
    const { sourceRoot, candidateRoot } = authorizedCounterfactualCandidateRoot({
      sourceRoot: candidate.source_root,
      candidateRoot: candidate.candidate_root,
      stateRoot: this.stateDir,
      groupId
    });
    const actions = [{ action: "replace-workspace", source: candidateRoot, destination: sourceRoot }];
    if (!apply) return { groupId, runId, applied: false, actions, warning: "dry-run; pass --apply to replace the source workspace" };
    let backup: string | undefined;
    let backupReady = false;
    let activationStarted = false;
    try {
      assertCounterfactualActive(signal);
      backup = await mkdtemp(join(tmpdir(), "odinn-counterfactual-rollback-"));
      assertCounterfactualActive(signal);
      await copyWorkspaceRollbackBackup(sourceRoot, backup, this.stateDir, signal);
      backupReady = true;
      await __testOnlyAfterBackup?.({ groupId, runId, backup, sourceRoot, candidateRoot });
      assertCounterfactualActive(signal);
      await syncWorkspace(candidateRoot, sourceRoot, {
        signal,
        stateRoot: this.stateDir,
        onMutationStart: () => { activationStarted = true; }
      });
      assertCounterfactualActive(signal);
      await __testOnlyAfterActivation?.({ groupId, runId, backup, sourceRoot, candidateRoot });
      assertCounterfactualActive(signal);
      const sourceRunId = (this.ledger.database.db.prepare("SELECT source_run_id FROM counterfactual_groups WHERE id = ?").get(groupId) as AnyRecord | undefined)?.source_run_id;
      const selectedAt = now();
      this.ledger.database.transaction((db: any) => {
        db.prepare("UPDATE counterfactual_candidates SET status = CASE WHEN run_id = ? THEN 'selected' ELSE 'discarded' END, selected_at = CASE WHEN run_id = ? THEN ? ELSE selected_at END WHERE group_id = ?").run(runId, runId, selectedAt, groupId);
        db.prepare("UPDATE counterfactual_groups SET status = 'selected' WHERE id = ?").run(groupId);
        if (sourceRunId) this.ledger.appendEventUnsafe(db, { runId: sourceRunId, type: "branch-selected", payload: { groupId, runId, sourceRoot }, timestamp: selectedAt });
      });
      return { groupId, runId, applied: true, actions };
    } catch (error) {
      if (backup && backupReady && activationStarted) {
        await syncWorkspace(backup, sourceRoot, { stateRoot: this.stateDir }).catch(() => undefined);
      }
      assertCounterfactualActive(signal);
      throw new OdinnRuntimeError("WORKSPACE_CONFLICT", `selected branch could not be applied: ${failureMessage(error)}`, { groupId, runId });
    } finally {
      if (backup) await rm(backup, { recursive: true, force: true });
    }
  }
  async select(groupId: string, runId: string, options: AnyRecord = {}) { const result = await this.commit(groupId, runId, options); if (!result.applied) return result; return { ...result, selected: true }; }
}

async function syncWorkspace(source: string, destination: string, {
  signal,
  stateRoot,
  onMutationStart
}: {
  signal?: AbortSignal;
  stateRoot: string;
  onMutationStart?: () => void;
}) {
  assertDisjointCounterfactualRoots(source, destination);
  const filter = counterfactualCopyFilter({
    sourceRoot: source,
    destinationRoot: destination,
    stateRoot,
    excludedComponents: COUNTERFACTUAL_PROTECTED_COMPONENTS,
    signal
  });
  let mutationStarted = false;
  const beforeMutation = () => {
    assertCounterfactualActive(signal);
    if (!mutationStarted) {
      mutationStarted = true;
      onMutationStart?.();
      assertCounterfactualActive(signal);
    }
  };

  const syncDirectory = async (sourceDirectory: string, destinationDirectory: string): Promise<void> => {
    assertCounterfactualActive(signal);
    const sourceDirectoryEntries = await readdir(sourceDirectory, { withFileTypes: true });
    assertCounterfactualActive(signal);
    const destinationDirectoryEntries = await readdir(destinationDirectory, { withFileTypes: true });
    assertCounterfactualActive(signal);
    const sourceEntries = new Map(sourceDirectoryEntries.map((entry) => [entry.name, entry]));
    const destinationEntries = new Map(destinationDirectoryEntries.map((entry) => [entry.name, entry]));

    for (const entry of destinationDirectoryEntries) {
      if (entry.isSymbolicLink()) continue;
      const sourcePath = join(sourceDirectory, entry.name);
      const destinationPath = join(destinationDirectory, entry.name);
      if (!filter(sourcePath, destinationPath) || sourceEntries.has(entry.name)) continue;
      beforeMutation();
      await rm(destinationPath, { recursive: true, force: true });
      assertCounterfactualActive(signal);
    }

    for (const entry of sourceDirectoryEntries) {
      const sourcePath = join(sourceDirectory, entry.name);
      const destinationPath = join(destinationDirectory, entry.name);
      if (!filter(sourcePath, destinationPath)) continue;
      const destinationEntry = destinationEntries.get(entry.name);
      if (entry.isDirectory()) {
        if (destinationEntry && !destinationEntry.isDirectory()) {
          beforeMutation();
          await rm(destinationPath, { recursive: true, force: true });
          assertCounterfactualActive(signal);
        }
        if (!destinationEntry || !destinationEntry.isDirectory()) {
          beforeMutation();
          await mkdir(destinationPath, { recursive: false });
          assertCounterfactualActive(signal);
        }
        await syncDirectory(sourcePath, destinationPath);
        assertCounterfactualActive(signal);
        continue;
      }
      if (destinationEntry) {
        beforeMutation();
        await rm(destinationPath, { recursive: true, force: true });
        assertCounterfactualActive(signal);
      }
      beforeMutation();
      await cp(sourcePath, destinationPath, {
        recursive: true,
        preserveTimestamps: true,
        filter
      });
      assertCounterfactualActive(signal);
    }
  };

  await syncDirectory(source, destination);
  assertCounterfactualActive(signal);
  return { mutated: mutationStarted };
}

export function createDifferentiatedRuntime({ stateDir = ".odinn", workspaceRoot = currentWorkingDirectory(), featureFlags = {}, proofOptions = {} }: AnyRecord = {}) {
  const ledger = createRunLedger({ stateDir, workspaceRoot, featureFlags });
  const runtimeFlags = { ...featureFlags, __ledger: ledger };
  const plugins = loadRuntimePlugins({
    ledger,
    stateDir: resolve(stateDir),
    workspaceRoot: resolve(workspaceRoot),
    featureFlags: runtimeFlags
  }, [capabilityTokensPlugin, capsulesPlugin, counterfactualPlugin]);
  return {
    ledger,
    proof: new ProofEngine({ ledger, ...proofOptions }),
    sentinel: new Sentinel({ ledger }),
    snapshots: new SnapshotManager({ ledger }),
    darwin: new DarwinRouter({ ledger }),
    plugins,
    capabilities: plugins.get("capabilities")!.service as CapabilityBroker,
    capsules: plugins.get("capsules")!.service as CapsuleManager,
    counterfactual: plugins.get("counterfactual")!.service as CounterfactualManager
  };
}

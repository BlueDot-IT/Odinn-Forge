import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { redactDurableValue } from "@odinn/protocol";
import { approvalEffectPolicyForTool } from "@odinn/policy";

type NodeError = Error & { code?: string };

class ApprovalStoreContentionError extends Error {
  readonly code = "APPROVAL_STORE_CONTENDED";

  constructor() {
    super("approval state could not be accessed before the bounded deadline");
  }
}

type StoredApprovalAction = ApprovalAction & {
  bindingTag?: string;
  sealedInput?: SealedApprovalInput;
};

type SealedApprovalInput = {
  version: 1;
  iv: string;
  data: string;
  authTag: string;
};

const durableApprovalKeys = new Map<string, Buffer>();
const volatileApprovalActions = new Map<string, Map<string, ApprovalAction>>();
const MAX_PENDING_APPROVALS = 500;
const MAX_APPROVAL_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_APPROVAL_LOCK_TIMEOUT_MS = 10_000;
const MAX_SYNCHRONOUS_APPROVAL_LOCK_WAIT_MS = 250;
const APPROVAL_LOCK_RETRY_MS = 25;
const approvalLockWait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type ApprovalAction = {
  id?: string;
  status?: string;
  createdAt?: string;
  expiresAt?: number;
  approvedAt?: string;
  runId?: string;
  accountId?: string;
  actor?: string;
  tool: string;
  summary?: string;
  effect?: ApprovalEffect;
  input?: Record<string, unknown>;
  /** Exact execution input kept only in volatile memory or the sealed input envelope. */
  executionInput?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ApprovalEffect = {
  version: 1;
  tool: string;
  summary: string;
  capability: string;
  inputDigest: string;
  reversible: "reversible" | "irreversible" | "uncertain";
  idempotency: "idempotent" | "non-idempotent" | "unknown";
  [key: string]: unknown;
};

export type ApprovalStoreOperationOptions = {
  signal?: AbortSignal;
};

export type ApprovalStoreListOptions = ApprovalStoreOperationOptions & {
  limit?: number;
  offset?: number;
};

type ApprovalStoreOptions = {
  path?: string;
  lockTimeoutMs?: number;
};

type ApprovalStoreTestHooks = {
  /** @internal Test-only barrier after this store owns the file lock. */
  __testOnlyAfterLockAcquired?: () => void;
  /** @internal Test-only observation point after a live lock collision. */
  __testOnlyOnLockContention?: () => void;
};

export interface ApprovalStore {
  create(action: ApprovalAction, options?: ApprovalStoreOperationOptions): string;
  claim(id: unknown, options?: ApprovalStoreOperationOptions): ApprovalAction | undefined;
  claimAsync?(id: unknown, options?: ApprovalStoreOperationOptions): Promise<ApprovalAction | undefined>;
  /** Recover the exact approved action without consuming it; never exposes sealed storage. */
  recover(id: unknown, options?: ApprovalStoreOperationOptions): ApprovalAction | undefined;
  recoverAsync?(id: unknown, options?: ApprovalStoreOperationOptions): Promise<ApprovalAction | undefined>;
  consume(id: unknown, action: ApprovalAction, options?: ApprovalStoreOperationOptions): ApprovalAction | undefined;
  consumeAsync?(id: unknown, action: ApprovalAction, options?: ApprovalStoreOperationOptions): Promise<ApprovalAction | undefined>;
  take(id: unknown, options?: ApprovalStoreOperationOptions): ApprovalAction | undefined;
  revoke(id: unknown, options?: ApprovalStoreOperationOptions): boolean;
  revokeAsync?(id: unknown, options?: ApprovalStoreOperationOptions): Promise<boolean>;
  list(options?: ApprovalStoreListOptions): ApprovalAction[];
  listAsync?(options?: ApprovalStoreListOptions): Promise<ApprovalAction[]>;
}

export function approvalActionForExecution(action: ApprovalAction): ApprovalAction {
  return normalizeApprovalAction(action);
}

/** @internal Continuation admission uses this to deny only lock contention. */
export function isApprovalStoreContentionError(error: unknown): boolean {
  return error instanceof ApprovalStoreContentionError;
}

export function createApprovalStore(options: ApprovalStoreOptions = {}): ApprovalStore {
  return createApprovalStoreInternal({ path: options.path, lockTimeoutMs: options.lockTimeoutMs });
}

/** @internal Test-only factory; deliberately excluded from the kernel package root. */
export function createApprovalStoreWithTestHooks(options: ApprovalStoreOptions & ApprovalStoreTestHooks): ApprovalStore {
  const { __testOnlyAfterLockAcquired, __testOnlyOnLockContention, ...storeOptions } = options;
  return createApprovalStoreInternal(storeOptions, { __testOnlyAfterLockAcquired, __testOnlyOnLockContention });
}

function createApprovalStoreInternal(options: ApprovalStoreOptions, hooks: ApprovalStoreTestHooks = {}): ApprovalStore {
  const { path } = options;
  const { __testOnlyAfterLockAcquired, __testOnlyOnLockContention } = hooks;
  const lockTimeoutMs = positiveApprovalLockTimeout(options.lockTimeoutMs);
  const synchronousLockTimeoutMs = Math.min(lockTimeoutMs, MAX_SYNCHRONOUS_APPROVAL_LOCK_WAIT_MS);
  const pending = new Map<string, StoredApprovalAction>();
  const storeKey = path ?? `memory:${randomUUID()}`;
  const bindingKey = durableApprovalKeys.get(storeKey) ?? (path ? loadDurableApprovalKey(path) : randomBytes(32));
  durableApprovalKeys.set(storeKey, bindingKey);
  const volatile = volatileApprovalActions.get(storeKey) ?? new Map<string, ApprovalAction>();
  volatileApprovalActions.set(storeKey, volatile);
  const withLock = <T>(operation: () => T, operationOptions: ApprovalStoreOperationOptions = {}): T => {
    throwIfApprovalOperationAborted(operationOptions.signal);
    if (!path) return operation();
    const lockPath = `${path}.lock`;
    const token = randomUUID();
    const deadline = performance.now() + synchronousLockTimeoutMs;
    while (true) {
      try {
        const descriptor = openSync(lockPath, "wx", 0o600);
        try {
          writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
        } finally {
          closeSync(descriptor);
        }
        break;
      } catch (error) {
        const failure = error as NodeError;
        if (failure.code !== "EEXIST") throw error;
        if (quarantineStaleApprovalLock(lockPath)) continue;
        __testOnlyOnLockContention?.();
        throwIfApprovalOperationAborted(operationOptions.signal);
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) throw approvalStoreContentionError();
        Atomics.wait(approvalLockWait, 0, 0, Math.min(APPROVAL_LOCK_RETRY_MS, remainingMs));
      }
    }
    try {
      __testOnlyAfterLockAcquired?.();
      throwIfApprovalOperationAborted(operationOptions.signal);
      return operation();
    } finally {
      releaseOwnedApprovalLock(lockPath, token);
    }
  };
  const withLockAsync = async <T>(operation: () => T, operationOptions: ApprovalStoreOperationOptions = {}): Promise<T> => {
    throwIfApprovalOperationAborted(operationOptions.signal);
    if (!path) return operation();
    const lockPath = `${path}.lock`;
    const token = randomUUID();
    const deadline = performance.now() + lockTimeoutMs;
    while (true) {
      try {
        const descriptor = openSync(lockPath, "wx", 0o600);
        try {
          writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
        } finally {
          closeSync(descriptor);
        }
        break;
      } catch (error) {
        const failure = error as NodeError;
        if (failure.code !== "EEXIST") throw error;
        if (quarantineStaleApprovalLock(lockPath)) continue;
        __testOnlyOnLockContention?.();
        throwIfApprovalOperationAborted(operationOptions.signal);
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) throw approvalStoreContentionError();
        await waitForApprovalLockRetry(Math.min(APPROVAL_LOCK_RETRY_MS, remainingMs), operationOptions.signal);
      }
    }
    try {
      __testOnlyAfterLockAcquired?.();
      throwIfApprovalOperationAborted(operationOptions.signal);
      return operation();
    } finally {
      releaseOwnedApprovalLock(lockPath, token);
    }
  };
  const refresh = () => {
    if (!path) return;
    try {
      if (statSync(path).size > MAX_APPROVAL_FILE_BYTES) {
        const error = new Error(`approval state exceeds the ${MAX_APPROVAL_FILE_BYTES}-byte limit`) as NodeError;
        error.code = "APPROVAL_STATE_TOO_LARGE";
        throw error;
      }
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const records = Array.isArray(parsed) ? parsed : parsed?.schemaVersion === 1 && Array.isArray(parsed.approvals) ? parsed.approvals : [];
      if (records.length > MAX_PENDING_APPROVALS) {
        const error = new Error(`approval state exceeds the ${MAX_PENDING_APPROVALS}-approval limit`) as NodeError;
        error.code = "APPROVAL_STATE_TOO_LARGE";
        throw error;
      }
      pending.clear();
      for (const record of records) {
        if (record && typeof record.id === "string") {
          const sanitized = redactDurableValue(record, { toolName: typeof record.tool === "string" ? record.tool : undefined }) as StoredApprovalAction;
          delete (sanitized as Record<string, unknown>).bindingDigest;
          pending.set(record.id, sanitized);
        }
      }
    } catch (error) {
      if ((error as NodeError | undefined)?.code !== "ENOENT") throw error;
    }
  };
  const persist = () => {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, approvals: Array.from(pending.values()) }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  };
  const expire = () => {
    const now = Date.now();
    for (const [id, action] of pending) {
      if (Number(action.expiresAt) <= now) {
        pending.delete(id);
        volatile.delete(id);
      }
    }
  };
  const recoverApproval = (id: unknown): ApprovalAction | undefined => {
    refresh();
    expire();
    persist();
    const key = String(id ?? "");
    const action = pending.get(key);
    if (!action || action.status !== "approved" || Number(action.expiresAt) <= Date.now()) return undefined;
    const exact = volatile.get(key) ?? recoverSealedApprovalAction(bindingKey, key, action);
    if (!exact || !action.bindingTag || !safeEqualTag(action.bindingTag, approvalBindingTag(bindingKey, exact))) return undefined;
    return { ...publicApprovalAction(action), ...exact };
  };
  const claimApproval = (id: unknown): ApprovalAction | undefined => {
    refresh();
    expire();
    const key = String(id ?? "");
    const action = pending.get(key);
    if (!action || Number(action.expiresAt) <= Date.now()) {
      volatile.delete(key);
      persist();
      return undefined;
    }
    if (action.status === "approved") return publicApprovalAction(action);
    pending.set(key, { ...action, status: "approved", approvedAt: new Date().toISOString() });
    persist();
    return publicApprovalAction(pending.get(key)!);
  };
  const consumeApproval = (id: unknown, expected: ApprovalAction): ApprovalAction | undefined => {
    refresh();
    expire();
    const key = String(id ?? "");
    const action = pending.get(key);
    if (!action || Number(action.expiresAt) <= Date.now()) {
      volatile.delete(key);
      persist();
      return undefined;
    }
    if (action.status !== "approved") {
      persist();
      return undefined;
    }
    const normalized = normalizeApprovalAction(expected);
    const exact = volatile.get(key) ?? recoverSealedApprovalAction(bindingKey, key, action);
    if (!exact || !action.bindingTag || !safeEqualTag(action.bindingTag, approvalBindingTag(bindingKey, exact))) return undefined;
    const exactMatch = safeEqualTag(action.bindingTag, approvalBindingTag(bindingKey, normalized));
    const redactedMatch = stableApprovalValue(normalizeApprovalAction(action)) === stableApprovalValue(normalized);
    if (!exactMatch && !redactedMatch) return undefined;
    pending.delete(key);
    volatile.delete(key);
    persist();
    return { ...publicApprovalAction(action), ...exact };
  };
  const revokeApproval = (id: unknown): boolean => {
    refresh();
    const key = String(id ?? "");
    const removed = pending.delete(key);
    volatile.delete(key);
    persist();
    return removed;
  };
  const listApprovals = (options: ApprovalStoreListOptions = {}): ApprovalAction[] => {
    refresh();
    expire();
    persist();
    const limit = Math.min(MAX_PENDING_APPROVALS, Math.max(0, Number.isSafeInteger(Number(options.limit)) ? Number(options.limit) : MAX_PENDING_APPROVALS));
    const offset = Math.max(0, Number.isSafeInteger(Number(options.offset)) ? Number(options.offset) : 0);
    return Array.from(pending.values())
      .filter((action) => action.status === "pending" || action.status === "approved")
      .map(({ input, bindingTag: _bindingTag, sealedInput: _sealedInput, ...action }) => ({
        ...action,
        ...(action.status === "approved" ? { status: "claimed", recovery: "execution claim is in flight; inspect before retrying" } : {}),
        input: redactBrowserInput(input)
      }))
      .slice(offset, offset + limit);
  };
  return {
    create(action, options) {
      return withLock(() => {
        refresh();
        expire();
        if (pending.size >= MAX_PENDING_APPROVALS) throw new Error(`approval state is at its ${MAX_PENDING_APPROVALS}-approval limit`);
        const id = `approval_${randomUUID()}`;
        const normalized = normalizeApprovalAction(action);
        const { executionInput: _executionInput, ...publicAction } = action;
        const sanitized = redactDurableValue({ ...publicAction, tool: normalized.tool, actor: normalized.actor, summary: normalized.effect?.summary, effect: normalized.effect, input: publicAction.input ?? {} }, { toolName: normalized.tool }) as ApprovalAction;
        const bindingTag = approvalBindingTag(bindingKey, normalized);
        volatile.set(id, normalized);
        pending.set(id, {
          id,
          ...sanitized,
          bindingTag,
          ...(path ? { sealedInput: sealApprovalInput(bindingKey, id, normalized.input ?? {}) } : {}),
          status: "pending",
          createdAt: new Date().toISOString(),
          expiresAt: Date.now() + 300_000
        });
        persist();
        return id;
      }, options);
    },
    claim(id, options) {
      return withLock(() => claimApproval(id), options);
    },
    claimAsync(id, options) {
      return withLockAsync(() => claimApproval(id), options);
    },
    recover(id, options) {
      return withLock(() => recoverApproval(id), options);
    },
    recoverAsync(id, options) {
      return withLockAsync(() => recoverApproval(id), options);
    },
    consume(id, expected, options) {
      return withLock(() => consumeApproval(id, expected), options);
    },
    consumeAsync(id, expected, options) {
      return withLockAsync(() => consumeApproval(id, expected), options);
    },
    take(id, options) {
      const action = this.claim(id, options);
      return action ? this.consume(id, action, options) : undefined;
    },
    revoke(id, options) {
      return withLock(() => revokeApproval(id), options);
    },
    revokeAsync(id, options) {
      return withLockAsync(() => revokeApproval(id), options);
    },
    list(options: ApprovalStoreListOptions = {}) {
      return withLock(() => listApprovals(options), options);
    },
    listAsync(options: ApprovalStoreListOptions = {}) {
      return withLockAsync(() => listApprovals(options), options);
    }
  };
}

function positiveApprovalLockTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_APPROVAL_LOCK_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1) throw new Error("approval store lock timeout must be a positive integer");
  return timeout;
}

function throwIfApprovalOperationAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw approvalOperationAbortReason(signal);
}

function approvalOperationAbortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("approval store operation aborted");
  error.name = "AbortError";
  return error;
}

function waitForApprovalLockRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(approvalOperationAbortReason(signal));
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(approvalOperationAbortReason(signal!));
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function approvalStoreContentionError(): Error {
  return new ApprovalStoreContentionError();
}

function releaseOwnedApprovalLock(lockPath: string, token: string): void {
  try {
    const lease = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lease?.token === token) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeError).code !== "ENOENT") throw error;
  }
}

type ApprovalLockSnapshot = {
  identity: string;
  raw: string;
  mtimeMs: number;
  token?: string;
  pid?: number;
  createdAt?: number;
};

function quarantineStaleApprovalLock(lockPath: string): boolean {
  const expected = approvalLockSnapshot(lockPath);
  if (!expected || !staleApprovalSnapshot(expected)) return false;
  const recoveryIdentity = expected.token ?? `identity:${expected.identity}`;
  const identityDigest = createHash("sha256").update(recoveryIdentity).digest("hex");
  const recoveryPath = join(dirname(lockPath), `.odinn-approval-lock-recovery.${createHash("sha256").update(`${lockPath}\0${recoveryIdentity}`).digest("hex")}`);
  const recoveryToken = randomUUID();
  if (!acquireApprovalRecoveryMarker(recoveryPath, recoveryToken, true)) return false;

  try {
    const current = approvalLockSnapshot(lockPath);
    if (!current || current.identity !== expected.identity || !staleApprovalSnapshot(current)) return false;
    const quarantinePath = join(dirname(lockPath), `.odinn-approval-stale-lock.${createHash("sha256").update(lockPath).digest("hex")}.${identityDigest}.${recoveryToken}`);
    try {
      renameSync(lockPath, quarantinePath);
    } catch (error) {
      if ((error as NodeError).code === "ENOENT") return true;
      throw error;
    }
    const quarantined = approvalLockSnapshot(quarantinePath);
    if (!quarantined || quarantined.identity !== expected.identity) {
      throw new Error("approval lock changed during stale-lock quarantine; refusing recovery");
    }
    return true;
  } finally {
    try {
      const recovery = JSON.parse(readFileSync(recoveryPath, "utf8"));
      if (recovery?.token === recoveryToken) unlinkSync(recoveryPath);
    } catch (error) {
      if ((error as NodeError).code !== "ENOENT") throw error;
    }
  }
}

function approvalLockSnapshot(path: string): ApprovalLockSnapshot | undefined {
  try {
    const before = statSync(path);
    const raw = readFileSync(path, "utf8");
    const after = statSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return undefined;
    let lease: any;
    try { lease = JSON.parse(raw); } catch { lease = undefined; }
    const physicalIdentity = `${after.dev}:${after.ino}:${after.birthtimeMs}:${after.size}:${createHash("sha256").update(raw).digest("hex")}`;
    return {
      identity: createHash("sha256").update(physicalIdentity).digest("hex"),
      raw,
      mtimeMs: after.mtimeMs,
      ...(typeof lease?.token === "string" ? { token: lease.token } : {}),
      ...(Number.isInteger(lease?.pid) ? { pid: Number(lease.pid) } : {}),
      ...(Number.isFinite(Number(lease?.createdAt)) ? { createdAt: Number(lease.createdAt) } : {})
    };
  } catch (error) {
    if ((error as NodeError).code === "ENOENT") return undefined;
    throw error;
  }
}

function staleApprovalSnapshot(snapshot: ApprovalLockSnapshot): boolean {
  const ageMs = Date.now() - (snapshot.createdAt ?? snapshot.mtimeMs);
  if (ageMs < 5_000) return false;
  if (!snapshot.token || !Number.isInteger(snapshot.pid) || Number(snapshot.pid) < 1) return true;
  try {
    process.kill(Number(snapshot.pid), 0);
    return false;
  } catch (error) {
    return (error as NodeError).code === "ESRCH";
  }
}

function acquireApprovalRecoveryMarker(recoveryPath: string, token: string, allowRecovery: boolean): boolean {
  try {
    const descriptor = openSync(recoveryPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    return true;
  } catch (error) {
    if ((error as NodeError).code !== "EEXIST") throw error;
    // Apply the same token-bound protocol recursively. A dead recovery owner
    // is never removed until a distinct recovery marker has been acquired.
    if (allowRecovery && quarantineStaleApprovalLock(recoveryPath)) {
      return acquireApprovalRecoveryMarker(recoveryPath, token, false);
    }
    return false;
  }
}

function normalizeApprovalAction(action: ApprovalAction): ApprovalAction {
  const tool = String(action.tool ?? "").trim();
  const input = normalizeApprovalExecutionInput(tool, action.executionInput ?? action.input);
  return {
    tool,
    runId: String(action.runId ?? "").trim(),
    accountId: String(action.accountId ?? "").trim(),
    actor: String(action.actor ?? "").trim(),
    input,
    effect: buildApprovalEffect(String(action.tool ?? "").trim(), input)
  };
}

function buildApprovalEffect(tool: string, input: Record<string, unknown>): ApprovalEffect {
  const inputDigest = createHash("sha256").update(stableApprovalValue(input)).digest("hex");
  const digest = inputDigest.slice(0, 16);
  const base: ApprovalEffect = {
    version: 1,
    tool,
    summary: `Perform one approved ${tool || "runtime"} action.`,
    capability: tool,
    inputDigest,
    reversible: "uncertain",
    idempotency: "unknown"
  };
  if (tool === "process.exec") {
    const commandDigest = createHash("sha256").update(String(input.command ?? "")).digest("hex").slice(0, 16);
    return {
      ...base,
      summary: `Run one approved process inside the configured process sandbox (command digest ${commandDigest}).`,
      effectClass: "process execution",
      isolation: "configured sandbox",
      command: "[redacted]",
      cwd: boundedEffectText(input.cwd, "."),
      argsCount: Array.isArray(input.args) ? Math.min(input.args.length, 100) : 0,
      commandDigest,
      recovery: "An uncertain process outcome requires operator review before retry.",
      reversible: "uncertain",
      idempotency: "unknown"
    };
  }
  if (tool.startsWith("browser.")) {
    const target = boundedEffectText(input.expectedUrl ?? input.url ?? input.tabId, "the approved browser tab");
    return {
      ...base,
      summary: `Perform one approved browser mutation on ${target}.`,
      effectClass: "browser mutation",
      target,
      tabId: boundedEffectText(input.tabId, ""),
      expectedUrl: boundedEffectText(input.expectedUrl ?? input.url, ""),
      selector: boundedEffectText(input.selector ?? input.name, ""),
      mutation: tool.slice("browser.".length),
      recovery: "An uncertain browser mutation requires operator review before retry.",
      reversible: "uncertain",
      idempotency: "non-idempotent"
    };
  }
  if (tool === "mcp.invoke") {
    const server = boundedEffectText(input.serverId ?? input.server, "configured MCP server");
    return {
      ...base,
      summary: `Invoke one approved MCP tool on ${server}.`,
      effectClass: "MCP invocation",
      server,
      mcpTool: boundedEffectText(input.tool, "configured tool"),
      argsDigest: boundedEffectText(input.argsDigest, digest),
      recovery: "An uncertain MCP outcome requires operator review before retry.",
      reversible: "uncertain",
      idempotency: "unknown"
    };
  }
  const externalEffect = approvalEffectPolicyForTool(tool);
  if (externalEffect) {
    const targetValue = externalEffect.targetFields.map((field) => input[field]).find((value) => value !== undefined);
    const target = boundedEffectText(targetValue, externalEffect.targetFallback);
    return {
      ...base,
      summary: `Perform one approved ${externalEffect.summaryAction} on ${target}.`,
      effectClass: externalEffect.effectClass,
      target,
      mutation: externalEffect.mutation,
      payloadDigest: digest,
      recovery: externalEffect.recovery,
      reversible: externalEffect.reversible,
      idempotency: externalEffect.idempotency
    };
  }
  if (tool === "skill.lifecycle" || tool === "skill.install") {
    return {
      ...base,
      summary: `Change the lifecycle state of approved skill ${boundedEffectText(input.skillId ?? input.id, "the selected skill")}.`,
      effectClass: "skill lifecycle",
      skillId: boundedEffectText(input.skillId ?? input.id, "the selected skill"),
      skillVersion: boundedEffectText(input.version, ""),
      action: boundedEffectText(input.action, "change"),
      recovery: "A failed lifecycle change remains auditable and must be reviewed before retry.",
      reversible: "uncertain",
      idempotency: "unknown"
    };
  }
  return { ...base, inputKeys: Object.keys(input).filter((key) => !/token|secret|password|credential|authorization|cookie|content|prompt/i.test(key)).slice(0, 20) };
}

function boundedEffectText(value: unknown, fallback: string): string {
  const text = String(redactDurableValue(value) ?? "").replace(/\s+/gu, " ").trim();
  if (!text || text === "[redacted]") return fallback;
  return text.slice(0, 160);
}

const LEGACY_BROWSER_APPROVAL_HINT_TOOLS = new Set(["browser.click", "browser.type", "browser.press"]);

export function normalizeApprovalExecutionInput(tool: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  const normalized = { ...input };
  if (LEGACY_BROWSER_APPROVAL_HINT_TOOLS.has(tool)) {
    delete normalized.confirmed;
    delete normalized.approvalId;
  } else if (tool === "process.exec") {
    delete normalized.approvalId;
  }
  return normalized;
}

function stableApprovalValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableApprovalValue).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableApprovalValue(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function approvalBindingTag(key: Buffer, action: ApprovalAction): string {
  return createHmac("sha256", key).update(stableApprovalValue({
    tool: action.tool,
    runId: action.runId ?? "",
    accountId: action.accountId ?? "",
    actor: action.actor ?? "",
    input: action.input ?? {}
  })).digest("base64url");
}

function publicApprovalAction(action: StoredApprovalAction): ApprovalAction {
  const { bindingTag: _bindingTag, sealedInput: _sealedInput, ...publicAction } = action;
  return publicAction;
}

function loadDurableApprovalKey(path: string): Buffer {
  const keyPath = `${path}.key`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const key = readFileSync(keyPath);
    if (key.byteLength !== 32) throw new Error("approval store key is invalid; refusing to recover durable approvals");
    chmodSync(keyPath, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeError).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  try {
    const descriptor = openSync(keyPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, key);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(keyPath, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeError).code !== "EEXIST") throw error;
    const existing = readFileSync(keyPath);
    if (existing.byteLength !== 32) throw new Error("approval store key is invalid; refusing to recover durable approvals");
    chmodSync(keyPath, 0o600);
    return existing;
  }
}

function sealApprovalInput(key: Buffer, approvalId: string, input: Record<string, unknown>): SealedApprovalInput {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`odinn-approval-input-v1:${approvalId}`, "utf8"));
  const data = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(input), "utf8")), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64url"),
    data: data.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url")
  };
}

function recoverSealedApprovalAction(key: Buffer, approvalId: string, action: StoredApprovalAction): ApprovalAction | undefined {
  const sealed = action.sealedInput;
  if (!sealed || sealed.version !== 1 || typeof sealed.iv !== "string" || typeof sealed.data !== "string" || typeof sealed.authTag !== "string") return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64url"));
    decipher.setAAD(Buffer.from(`odinn-approval-input-v1:${approvalId}`, "utf8"));
    decipher.setAuthTag(Buffer.from(sealed.authTag, "base64url"));
    const input = JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64url")), decipher.final()]).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
    return normalizeApprovalAction({
      tool: action.tool,
      runId: action.runId,
      accountId: action.accountId,
      actor: action.actor,
      input: input as Record<string, unknown>
    });
  } catch {
    return undefined;
  }
}

function safeEqualTag(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64url");
  const rightBytes = Buffer.from(right, "base64url");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function redactBrowserInput(input: Record<string, unknown> = {}) {
  return "value" in input ? { ...input, value: "[redacted]", sensitive: true } : { ...input };
}

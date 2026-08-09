import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactDurableValue } from "@odinn/protocol";

type NodeError = Error & { code?: string };

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
  input?: Record<string, unknown>;
  /** Exact execution input kept only in volatile memory or the sealed input envelope. */
  executionInput?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface ApprovalStore {
  create(action: ApprovalAction): string;
  claim(id: unknown): ApprovalAction | undefined;
  /** Recover the exact approved action without consuming it; never exposes sealed storage. */
  recover(id: unknown): ApprovalAction | undefined;
  consume(id: unknown, action: ApprovalAction): ApprovalAction | undefined;
  take(id: unknown): ApprovalAction | undefined;
  revoke(id: unknown): boolean;
  list(): ApprovalAction[];
}

export function createApprovalStore({ path }: { path?: string } = {}): ApprovalStore {
  const pending = new Map<string, StoredApprovalAction>();
  const storeKey = path ?? `memory:${randomUUID()}`;
  const bindingKey = durableApprovalKeys.get(storeKey) ?? (path ? loadDurableApprovalKey(path) : randomBytes(32));
  durableApprovalKeys.set(storeKey, bindingKey);
  const volatile = volatileApprovalActions.get(storeKey) ?? new Map<string, ApprovalAction>();
  volatileApprovalActions.set(storeKey, volatile);
  const withLock = <T>(operation: () => T): T => {
    if (!path) return operation();
    const lockPath = `${path}.lock`;
    const token = randomUUID();
    const acquire = (allowRecovery: boolean): void => {
      try {
        const descriptor = openSync(lockPath, "wx", 0o600);
        try {
          writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
        } finally {
          closeSync(descriptor);
        }
      } catch (error) {
        const failure = error as NodeError;
        if (failure.code !== "EEXIST") throw error;
        if (allowRecovery && staleApprovalLock(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch (unlinkError) {
            if ((unlinkError as NodeError).code !== "ENOENT") throw unlinkError;
          }
          return acquire(false);
        }
        const busy = new Error("approval store is busy; refusing an unsafe concurrent claim") as NodeError;
        busy.code = "APPROVAL_STORE_BUSY";
        throw busy;
      }
    };
    acquire(true);
    try {
      return operation();
    } finally {
      try {
        const lease = JSON.parse(readFileSync(lockPath, "utf8"));
        if (lease?.token === token) unlinkSync(lockPath);
      } catch (error) {
        if ((error as NodeError).code !== "ENOENT") throw error;
      }
    }
  };
  const refresh = () => {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const records = Array.isArray(parsed) ? parsed : parsed?.schemaVersion === 1 && Array.isArray(parsed.approvals) ? parsed.approvals : [];
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
      if (action.status === "pending" && Number(action.expiresAt) <= now) {
        pending.delete(id);
        volatile.delete(id);
      }
    }
  };
  return {
    create(action) {
      return withLock(() => {
        refresh();
        const id = `approval_${randomUUID()}`;
        const normalized = normalizeApprovalAction(action);
        const { executionInput: _executionInput, ...publicAction } = action;
        const sanitized = redactDurableValue({ ...publicAction, tool: normalized.tool, actor: normalized.actor, input: publicAction.input ?? {} }, { toolName: normalized.tool }) as ApprovalAction;
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
      });
    },
    claim(id) {
      return withLock(() => {
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
      });
    },
    recover(id) {
      return withLock(() => {
        refresh();
        expire();
        const key = String(id ?? "");
        const action = pending.get(key);
        if (!action || action.status !== "approved" || Number(action.expiresAt) <= Date.now()) return undefined;
        const exact = volatile.get(key) ?? recoverSealedApprovalAction(bindingKey, key, action);
        if (!exact || !action.bindingTag || !safeEqualTag(action.bindingTag, approvalBindingTag(bindingKey, exact))) return undefined;
        return { ...publicApprovalAction(action), ...exact };
      });
    },
    consume(id, expected) {
      return withLock(() => {
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
      });
    },
    take(id) {
      const action = this.claim(id);
      return action ? this.consume(id, action) : undefined;
    },
    revoke(id) {
      return withLock(() => {
        refresh();
        const key = String(id ?? "");
        const removed = pending.delete(key);
        volatile.delete(key);
        persist();
        return removed;
      });
    },
    list() {
      return withLock(() => {
        refresh();
        expire();
        persist();
        return Array.from(pending.values())
          .filter((action) => action.status === "pending")
          .map(({ input, bindingTag: _bindingTag, sealedInput: _sealedInput, ...action }) => ({ ...action, input: redactBrowserInput(input) }));
      });
    }
  };
}

function staleApprovalLock(path: string) {
  try {
    const lease = JSON.parse(readFileSync(path, "utf8"));
    const ageMs = Date.now() - Number(lease?.createdAt ?? statSync(path).mtimeMs);
    if (!Number.isInteger(lease?.pid) || lease.pid < 1 || ageMs < 5_000) return false;
    try {
      process.kill(lease.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeError).code === "ESRCH";
    }
  } catch {
    try {
      return Date.now() - statSync(path).mtimeMs >= 5_000;
    } catch {
      return false;
    }
  }
}

function normalizeApprovalAction(action: ApprovalAction): ApprovalAction {
  const input = normalizeApprovalInput(action.executionInput ?? action.input);
  return {
    tool: String(action.tool ?? "").trim(),
    runId: String(action.runId ?? "").trim(),
    accountId: String(action.accountId ?? "").trim(),
    actor: String(action.actor ?? "").trim(),
    input
  };
}

function normalizeApprovalInput(input: Record<string, unknown> = {}): Record<string, unknown> {
  const normalized = { ...input };
  delete normalized.confirmed;
  delete normalized.approvalId;
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

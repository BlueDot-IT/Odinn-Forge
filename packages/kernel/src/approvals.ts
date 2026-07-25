import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type NodeError = Error & { code?: string };

export type ApprovalAction = {
  id?: string;
  status?: string;
  createdAt?: string;
  expiresAt?: number;
  approvedAt?: string;
  runId?: string;
  tool: string;
  summary?: string;
  input?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface ApprovalStore {
  create(action: ApprovalAction): string;
  claim(id: unknown): ApprovalAction | undefined;
  take(id: unknown): ApprovalAction | undefined;
  list(): ApprovalAction[];
}

export function createApprovalStore({ path }: { path?: string } = {}): ApprovalStore {
  const pending = new Map<string, ApprovalAction>();
  const refresh = () => {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const records = Array.isArray(parsed) ? parsed : parsed?.schemaVersion === 1 && Array.isArray(parsed.approvals) ? parsed.approvals : [];
      pending.clear();
      for (const record of records) {
        if (record && typeof record.id === "string") pending.set(record.id, record);
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
      if (action.status === "pending" && Number(action.expiresAt) <= now) pending.delete(id);
    }
  };
  return {
    create(action) {
      refresh();
      const id = `approval_${randomUUID()}`;
      pending.set(id, { id, ...action, status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + 300_000 });
      persist();
      return id;
    },
    claim(id) {
      refresh();
      expire();
      const key = String(id ?? "");
      const action = pending.get(key);
      if (!action || Number(action.expiresAt) <= Date.now()) {
        persist();
        return undefined;
      }
      if (action.status === "approved") return action;
      pending.set(key, { ...action, status: "approved", approvedAt: new Date().toISOString(), runId: action.runId ?? `approval:${key}` });
      persist();
      return pending.get(key);
    },
    take(id) {
      const action = this.claim(id);
      if (!action) return undefined;
      pending.delete(String(id ?? ""));
      persist();
      return action;
    },
    list() {
      refresh();
      expire();
      persist();
      return Array.from(pending.values())
        .filter((action) => action.status === "pending")
        .map(({ input, ...action }) => ({ ...action, input: redactBrowserInput(input) }));
    }
  };
}

function redactBrowserInput(input: Record<string, unknown> = {}) {
  return "value" in input ? { ...input, value: "[redacted]", sensitive: true } : { ...input };
}

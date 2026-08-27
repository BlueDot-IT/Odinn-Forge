import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertCapabilityIds,
  capabilitiesForTool,
  migrateLegacyCapabilityPolicy,
  type RuntimePolicy
} from "@odinn/policy";
import type { ApprovalAction, ApprovalStore } from "./approvals.ts";
import { withStateMutationLock } from "./state-mutation.ts";
import {
  SkillPackageStore,
  validateSkillPackage,
  type SkillTransitionPreconditions
} from "./skill-packages.ts";

export type SkillLifecycleContext = {
  operationId?: string;
  actor?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** @internal Test-only barrier after the managed-skill state lock is held. */
  __testOnlyAfterLockAcquired?: () => void | Promise<void>;
};

export type SkillLifecycleTransition = SkillTransitionPreconditions & {
  id: string;
  action: "enable" | "disable" | "quarantine";
};

export class SkillLifecycleError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "SkillLifecycleError";
    this.code = code;
    this.status = status;
  }
}

type LifecycleOptions = {
  store: SkillPackageStore;
  auditStore: { append(event: Record<string, unknown>): Promise<unknown> };
  approvalStore: ApprovalStore;
  policy: RuntimePolicy;
  enabled?: boolean;
};

const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const MAX_DRAFT_BYTES = 256 * 1024;

/**
 * The only application-owned mutation boundary for managed skills.
 *
 * SkillPackageStore remains a durable storage primitive for SDK consumers. A
 * gateway or control-plane caller must use this service so that feature flags,
 * capability binding, approvals, preconditions, and audit events cannot be
 * accidentally skipped.
 */
export class SkillLifecycleService {
  readonly store: SkillPackageStore;
  readonly auditStore: LifecycleOptions["auditStore"];
  readonly approvalStore: ApprovalStore;
  readonly policy: RuntimePolicy;
  readonly enabled: boolean;

  constructor(options: LifecycleOptions) {
    this.store = options.store;
    this.auditStore = options.auditStore;
    this.approvalStore = options.approvalStore;
    this.policy = options.policy;
    this.enabled = options.enabled === true;
  }

  assertWritable() {
    if (!this.enabled) throw new SkillLifecycleError("SKILL_LIFECYCLE_DISABLED", "managed skill lifecycle is disabled", 403);
    if (!this.policy.allowedCapabilities.includes("skill.manage")) {
      throw new SkillLifecycleError("SKILL_LIFECYCLE_NOT_AUTHORIZED", "skill lifecycle requires the explicit skill.manage capability", 403);
    }
  }

  async inspect() {
    const records = await this.store.inspect();
    return records.map((record: any) => safeRecord(record));
  }

  async verify(id: string) {
    return this.store.verify(id);
  }

  async create(input: unknown, context: SkillLifecycleContext = {}) {
    throwIfSkillLifecycleAborted(context.signal);
    this.assertWritable();
    const operation = operationContext(context);
    const validated = validateSkillPackage(input);
    validateSkillDeclarations(validated.manifest, false);
    await this.audit("skill.lifecycle.admitted", operation, {
      action: "create",
      skillId: validated.manifest.id,
      version: validated.manifest.version,
      integrity: validated.integrity,
      requestDigest: digest({ action: "create", manifest: validated.manifest, integrity: validated.integrity })
    });
    try {
      const installed = await this.store.install(input, {
        signal: context.signal,
        __testOnlyAfterLockAcquired: context.__testOnlyAfterLockAcquired
      });
      throwIfSkillLifecycleAborted(context.signal);
      await this.audit("skill.lifecycle.completed", operation, {
        action: "create",
        skillId: installed.id,
        version: installed.version,
        integrity: installed.integrity,
        status: installed.status,
        trusted: installed.trusted,
        requestDigest: digest({ action: "create", id: installed.id, version: installed.version, integrity: installed.integrity })
      });
      return safeRecord(installed);
    } catch (error) {
      if (!context.signal?.aborted) {
        await this.auditFailure(operation, "create", validated.manifest.id, validated.manifest.version, validated.integrity);
      }
      throw error;
    }
  }

  async transition(request: SkillLifecycleTransition, context: SkillLifecycleContext = {}) {
    throwIfSkillLifecycleAborted(context.signal);
    this.assertWritable();
    const operation = operationContext(context);
    const action = request?.action;
    if (!request || !SKILL_ID.test(String(request.id ?? ""))) throw new SkillLifecycleError("SKILL_ID_INVALID", "skill id is invalid", 400);
    if (!["enable", "disable", "quarantine"].includes(String(action))) throw new SkillLifecycleError("SKILL_ACTION_INVALID", "unsupported skill lifecycle action", 400);
    if (!request.version || !/^[a-f0-9]{64}$/u.test(String(request.integrity ?? ""))) {
      throw new SkillLifecycleError("SKILL_PRECONDITION_REQUIRED", "skill lifecycle requires the expected version and integrity digest", 409);
    }
    const record = await this.findRecord(request.id);
    if (!record) throw new SkillLifecycleError("SKILL_NOT_FOUND", "skill package not found", 404);
    if (record.version !== request.version || record.integrity !== request.integrity) {
      throw new SkillLifecycleError("SKILL_PRECONDITION_FAILED", "skill package version or integrity precondition failed", 409);
    }
    const requestDigest = digest({ id: request.id, action, version: request.version, integrity: request.integrity });
    if (action === "enable") {
      const validated = validateSkillPackage(record);
      validateSkillDeclarations(validated.manifest, true);
    } else {
      await this.store.verify(request.id);
    }
    await this.audit("skill.lifecycle.admitted", operation, {
      action,
      skillId: request.id,
      version: request.version,
      integrity: request.integrity,
      requestDigest,
      expectedVersion: request.version,
      expectedIntegrity: request.integrity
    });
    if (action === "enable") {
      throwIfSkillLifecycleAborted(context.signal);
      const summary = `Enable skill package ${request.id}@${request.version} after digest-bound review`;
      const approvalId = this.approvalStore.create({
        type: "skill-lifecycle",
        tool: "skill.lifecycle",
        runId: operation.operationId,
        summary,
        input: {
          skillId: request.id,
          action,
          version: request.version,
          integrity: request.integrity,
          requestDigest
        }
      }, { signal: context.signal });
      throwIfSkillLifecycleAborted(context.signal);
      await this.audit("skill.lifecycle.approval_required", operation, {
        action,
        skillId: request.id,
        version: request.version,
        integrity: request.integrity,
        requestDigest,
        approvalId
      });
      return {
        type: "approval.required",
        approvalId,
        tool: "skill.lifecycle",
        summary,
        expiresInSeconds: 300,
        skill: { id: request.id, version: request.version, integrity: request.integrity, status: record.status }
      };
    }
    try {
      const transitioned = await this.store.transition(request.id, action, {
        version: request.version,
        integrity: request.integrity
      }, {
        signal: context.signal,
        __testOnlyAfterLockAcquired: context.__testOnlyAfterLockAcquired
      });
      throwIfSkillLifecycleAborted(context.signal);
      await this.audit("skill.lifecycle.completed", operation, {
        action,
        skillId: request.id,
        version: request.version,
        integrity: request.integrity,
        status: transitioned.status,
        trusted: transitioned.trusted,
        requestDigest
      });
      return safeRecord(transitioned);
    } catch (error) {
      if (!context.signal?.aborted) {
        await this.auditFailure(operation, action, request.id, String(request.version), String(request.integrity), requestDigest);
      }
      throw error;
    }
  }

  async applyApproved(approvalId: string, pending?: ApprovalAction, context: SkillLifecycleContext = {}) {
    throwIfSkillLifecycleAborted(context.signal);
    this.assertWritable();
    const candidate = pending ?? (typeof this.approvalStore.claimAsync === "function"
      ? await this.approvalStore.claimAsync(approvalId, { signal: context.signal })
      : this.approvalStore.claim(approvalId, { signal: context.signal }));
    if (!candidate || candidate.tool !== "skill.lifecycle" || candidate.type !== "skill-lifecycle") {
      throw new SkillLifecycleError("SKILL_APPROVAL_INVALID", "skill lifecycle approval is missing or has the wrong type", 409);
    }
    const input = candidate.input ?? {};
    const expected = {
      id: String(input.skillId ?? ""),
      action: String(input.action ?? "") as SkillLifecycleTransition["action"],
      version: String(input.version ?? ""),
      integrity: String(input.integrity ?? ""),
      requestDigest: String(input.requestDigest ?? "")
    };
    const recomputed = digest({ id: expected.id, action: expected.action, version: expected.version, integrity: expected.integrity });
    if (expected.requestDigest !== recomputed || expected.action !== "enable") {
      throw new SkillLifecycleError("SKILL_APPROVAL_INVALID", "skill lifecycle approval binding is invalid", 409);
    }
    const expectedApproval = {
      tool: "skill.lifecycle",
      runId: candidate.runId,
      input
    };
    throwIfSkillLifecycleAborted(context.signal);
    const consumed = typeof this.approvalStore.consumeAsync === "function"
      ? await this.approvalStore.consumeAsync(approvalId, expectedApproval, { signal: context.signal })
      : this.approvalStore.consume(approvalId, expectedApproval, { signal: context.signal });
    if (!consumed) throw new SkillLifecycleError("SKILL_APPROVAL_CONSUMED", "skill lifecycle approval is expired, already used, or does not match", 409);
    const record = await this.findRecord(expected.id);
    if (!record || record.version !== expected.version || record.integrity !== expected.integrity) {
      await this.auditFailure({ operationId: candidate.runId || randomUUID(), actor: "approval-executor" }, "enable", expected.id, expected.version, expected.integrity, expected.requestDigest);
      throw new SkillLifecycleError("SKILL_PRECONDITION_FAILED", "approved skill package changed before enablement", 409);
    }
    const validated = validateSkillPackage(record);
    validateSkillDeclarations(validated.manifest, true);
    try {
      throwIfSkillLifecycleAborted(context.signal);
      const enabled = await this.store.transition(expected.id, "enable", {
        version: expected.version,
        integrity: expected.integrity
      }, {
        signal: context.signal,
        __testOnlyAfterLockAcquired: context.__testOnlyAfterLockAcquired
      });
      throwIfSkillLifecycleAborted(context.signal);
      await this.audit("skill.lifecycle.completed", {
        operationId: candidate.runId || randomUUID(),
        actor: "approval-executor"
      }, {
        action: "enable",
        skillId: expected.id,
        version: expected.version,
        integrity: expected.integrity,
        status: enabled.status,
        trusted: enabled.trusted,
        requestDigest: expected.requestDigest,
        approvalId
      });
      return safeRecord(enabled);
    } catch (error) {
      if (!context.signal?.aborted) {
        await this.auditFailure({ operationId: candidate.runId || randomUUID(), actor: "approval-executor" }, "enable", expected.id, expected.version, expected.integrity, expected.requestDigest);
      }
      throw error;
    }
  }

  async saveDraft(input: any, context: SkillLifecycleContext = {}) {
    throwIfSkillLifecycleAborted(context.signal);
    this.assertWritable();
    const operation = operationContext(context);
    const name = String(input?.name ?? "").trim();
    const description = String(input?.description ?? "").trim();
    const instructions = String(input?.instructions ?? "").trim();
    if (!SKILL_ID.test(name)) throw new SkillLifecycleError("SKILL_DRAFT_INVALID", "draft name must be 2-64 lowercase letters, digits, or hyphens", 400);
    if (description.length < 12 || instructions.length < 40) throw new SkillLifecycleError("SKILL_DRAFT_INVALID", "draft description or instructions are too short", 400);
    const content = `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${name}\n\n${instructions}\n`;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_DRAFT_BYTES) throw new SkillLifecycleError("SKILL_DRAFT_LIMIT", "skill draft exceeds its bounded size", 413);
    const digestValue = digest(content);
    const directory = join(this.store.stateDir, "skill-workshop", name);
    const path = join(directory, "SKILL.md");
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await this.audit("skill.lifecycle.admitted", operation, { action: "save-draft", skillId: name, requestDigest: digestValue, bytes });
    try {
      await withStateMutationLock(this.store.stateDir, async () => {
        throwIfSkillLifecycleAborted(context.signal);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(temporary, content, { mode: 0o600 });
        throwIfSkillLifecycleAborted(context.signal);
        await rename(temporary, path);
        await chmod(path, 0o600);
      }, {
        signal: context.signal,
        __testOnlyAfterLockAcquired: context.__testOnlyAfterLockAcquired
      });
      throwIfSkillLifecycleAborted(context.signal);
      await this.audit("skill.lifecycle.completed", operation, { action: "save-draft", skillId: name, requestDigest: digestValue, bytes, status: "draft" });
      return { path, digest: digestValue, status: "draft" };
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (!context.signal?.aborted) await this.auditFailure(operation, "save-draft", name, "draft", digestValue);
      throw error;
    }
  }

  private async findRecord(id: string) {
    const records = await this.store.inspect();
    return records.find((record: any) => record.id === id) as any;
  }

  private async audit(type: string, operation: { operationId: string; actor: string }, data: Record<string, unknown>) {
    await this.auditStore.append({
      at: new Date().toISOString(),
      runId: operation.operationId,
      type,
      actor: operation.actor,
      tool: "skill.lifecycle",
      capability: "skill.manage",
      decision: type.endsWith("approval_required") ? "pause" : "allow",
      data
    });
  }

  private async auditFailure(operation: { operationId: string; actor: string }, action: string, id: string, version: string, integrity: string, requestDigest?: string) {
    await this.audit("skill.lifecycle.failed", operation, {
      action,
      skillId: id,
      version,
      integrity,
      ...(requestDigest ? { requestDigest } : {})
    }).catch(() => undefined);
  }
}

function throwIfSkillLifecycleAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("skill lifecycle mutation was aborted");
}

function operationContext(context: SkillLifecycleContext) {
  return {
    operationId: String(context.operationId || context.idempotencyKey || `skill_${randomUUID()}`).slice(0, 128),
    actor: String(context.actor || "gateway").slice(0, 128)
  };
}

function validateSkillDeclarations(manifest: any, forEnable: boolean) {
  const requestedTools = Array.isArray(manifest.requestedTools) ? manifest.requestedTools : [];
  const trusted = new Set<string>();
  for (const tool of requestedTools) {
    for (const capability of capabilitiesForTool(String(tool))) trusted.add(capability);
  }
  const requested = Array.isArray(manifest.requestedCapabilities) ? manifest.requestedCapabilities : [];
  const migrated = migrateLegacyCapabilityPolicy(requested, { versionless: true });
  const canonical = new Set<string>([
    ...migrated.allowedCapabilities,
    ...migrated.scopedCapabilities.map((grant) => grant.capability)
  ]);
  assertCapabilityIds([...canonical], "skill requested capabilities");
  const outsideDeclaration = [...canonical].filter((capability) => !trusted.has(capability));
  if (outsideDeclaration.length) {
    throw new SkillLifecycleError("SKILL_CAPABILITY_ESCALATION", `skill requests capabilities outside trusted tools: ${outsideDeclaration.join(", ")}`, 403);
  }
  if (forEnable && (manifest.requestedSecrets?.length || manifest.network?.allow?.length)) {
    throw new SkillLifecycleError("SKILL_UNSUPPORTED_AUTHORITY", "skills with secret or network declarations cannot be enabled in Stage 8", 403);
  }
}

function safeRecord(record: any) {
  return {
    id: record.id,
    version: record.version,
    name: record.name,
    description: record.description,
    requestedTools: [...(record.requestedTools ?? [])].sort(),
    requestedCapabilities: [...(record.requestedCapabilities ?? [])].sort(),
    status: record.status,
    trusted: record.trusted === true,
    installedAt: record.installedAt,
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    integrity: record.integrity,
    ...(record.previousVersion ? { previousVersion: record.previousVersion } : {}),
    verification: {
      valid: record.verification?.valid === true,
      failures: Array.isArray(record.verification?.failures) ? record.verification.failures.slice(0, 8).map(String) : []
    }
  };
}

function digest(value: unknown) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}
